/**
 * Sending a Change's checked items and drafts: to an agent thread as one
 * message, or to GitHub as one review. Exactly once: a batch is stored with
 * what it carries before anything is sent, keyed on the client's id; its id
 * is written into the message or review body as a marker, and before any
 * resend the destination is searched for that marker. A site that cannot be
 * reached leaves the batch queued, a refusal leaves it failed, both with the
 * problem, until an explicit Retry sends the same id again.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { Effect } from "effect";
import type { Problem } from "../core/change.ts";
import { reviewTag, type ChangeKey } from "../core/ids.ts";
import {
  batchMarker,
  batchPhase,
  type AgentStatus,
  type AgentTarget,
  type Batch,
  type BatchInput,
  type BatchView,
  type Draft,
  type ReviewItem,
} from "../core/items.ts";
import { parseChangeKey, type ChangeDetail } from "../core/review.ts";
import type { ReviewComment } from "../forge/github.ts";
import type { ForgeSites } from "./forge-sites.ts";
import { changeHome } from "./review-start.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

const files = instructionFiles(import.meta.url);

/** Problems a later Retry can get past: the batch waits queued. Anything else failed it. */
const TRANSIENT = new Set<Problem["kind"]>([
  "host-offline",
  "auth",
  "rate-limited",
  "tool-missing",
  "no-site",
  "failed",
]);

/** bb's thread statuses as an agent's. */
const RUNNING = new Set(["pending", "starting", "active", "stopping"]);
const statusOf = (status: string | undefined): AgentStatus =>
  status === undefined
    ? "unknown"
    : RUNNING.has(status)
      ? "running"
      : status === "error"
        ? "failed"
        : "idle";

/** What a batch carries, fixed when it is accepted: a retry sends exactly this. */
type Payload =
  | { destination: "agent"; text: string }
  | { destination: "github"; body: string; comments: ReviewComment[] };

const failure = (detail: string): Problem => ({ kind: "moved", detail });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ── What a batch says ──────────────────────────────────────────────────

const place = (anchor: ReviewItem["anchor"]) =>
  anchor.line === null ? anchor.path : `${anchor.path}:${anchor.line}`;
const indent = (text: string) => text.trim().replaceAll("\n", "\n  ");

function itemLine(item: ReviewItem): string {
  const who =
    item.origin.kind === "bb"
      ? `[P${item.priority ?? 2}] ${item.title ?? "Finding"}`
      : `@${item.origin.author}${item.priority !== null ? ` [P${item.priority}]` : ""}`;
  return `- ${who} — ${place(item.anchor)} (id \`${item.id}\`)\n  ${indent(item.body)}`;
}

/** The base a batch was read against, by commit or branch; nothing when the host chose it. */
function baseText(base: string | null): string {
  if (!base) return "";
  const named = base.startsWith("branch:") ? base.slice("branch:".length) : base;
  return named ? `, compared with \`${named}\`` : "";
}

function agentText(input: {
  branch: string;
  repoName: string;
  base: string | null;
  head: string;
  items: ReviewItem[];
  drafts: Draft[];
  marker: string;
}): string {
  const replies = input.drafts.map(
    (draft) =>
      `- ${place(draft.anchor)}${draft.replyTo ? ` (on \`${draft.replyTo}\`)` : ""}: ${indent(draft.body)}`,
  );
  return files.read("fix-batch", {
    branch: `\`${input.branch}\``,
    repoName: `\`${input.repoName}\``,
    head: input.head,
    base: baseText(input.base),
    items: input.items.length > 0 ? `Items:\n\n${input.items.map(itemLine).join("\n")}` : "",
    replies:
      replies.length > 0
        ? `${input.items.length > 0 ? "\n\n" : ""}The reviewer's comments:\n\n${replies.join("\n")}`
        : "",
    marker: input.marker,
  });
}

/** A line comment GitHub can place: on a line, at the head the review is pinned to. */
function reviewComment(
  anchor: ReviewItem["anchor"],
  head: string,
  body: string,
): ReviewComment | null {
  if (anchor.line === null || anchor.head !== head) return null;
  return {
    path: anchor.path,
    line: anchor.line,
    startLine: anchor.startLine,
    side: anchor.side,
    body,
  };
}

function githubPayload(
  head: string,
  items: ReviewItem[],
  drafts: Draft[],
  byId: Map<string, ReviewItem>,
): Payload | string {
  const comments: ReviewComment[] = [];
  for (const item of items) {
    // GitHub's own threads are already on the pull request.
    if (item.origin.kind !== "bb" || item.state !== "open") continue;
    const comment = reviewComment(
      item.anchor,
      head,
      `**[P${item.priority ?? 2}] ${item.title ?? "Finding"}**\n\n${item.body}`,
    );
    if (comment) comments.push(comment);
  }
  for (const draft of drafts) {
    if (draft.state !== "pending") continue;
    const on = draft.replyTo ? byId.get(draft.replyTo) : undefined;
    const quote =
      on?.origin.kind === "forge"
        ? `> @${on.origin.author}: ${on.body.split("\n")[0]!.slice(0, 200)}\n\n`
        : "";
    const comment = reviewComment(draft.anchor, head, `${quote}${draft.body}`);
    if (comment) comments.push(comment);
  }
  if (comments.length === 0)
    return "Nothing here can be posted to GitHub: no open finding or comment sits on a line of the pull request's head.";
  const count = comments.length === 1 ? "1 comment" : `${comments.length} comments`;
  return { destination: "github", body: `Review from bb: ${count}.`, comments };
}

// ── Sending ────────────────────────────────────────────────────────────

export function createBatches(deps: {
  bb: BbPluginApi;
  store: Store;
  sites: ForgeSites;
  share: Share;
  detail: (key: ChangeKey) => ChangeDetail;
  /** The Change's items as the reader sees them. */
  items: (key: ChangeKey) => ReviewItem[];
  placementsFor: (key: ChangeKey) => ReturnType<Store["checkouts"]>;
  /** Threads whose branch is this Change's. */
  threadsOnChange: (key: ChangeKey) => string[];
  invalidate: (tags: readonly string[]) => void;
  fork: (work: Effect.Effect<void>) => void;
  now: () => number;
}) {
  const { bb, store } = deps;
  /** Each agent thread's status as bb last said: thread events keep it, a read fills a gap once. */
  const agents = new Map<string, AgentStatus>();
  const asking = new Set<string>();

  const headOf = (key: ChangeKey) => {
    const detail = deps.detail(key);
    return detail.state === "change" ? (detail.revision?.head ?? detail.head) : null;
  };

  const agentStatus = (threadId: string): AgentStatus => {
    const known = agents.get(threadId);
    if (known) return known;
    if (!asking.has(threadId)) {
      asking.add(threadId);
      deps.fork(
        Effect.promise(() =>
          bb.sdk.threads.get({ threadId }).then(
            (thread) => statusOf(thread.status),
            (): AgentStatus => "gone",
          ),
        ).pipe(Effect.flatMap((status) => Effect.sync(() => threadStatus(threadId, status)))),
      );
    }
    return "unknown";
  };

  /** A thread's status changed: the Changes with batches sent to it read again. */
  const threadStatus = (threadId: string, status: AgentStatus) => {
    asking.delete(threadId);
    if (agents.get(threadId) === status) return;
    agents.set(threadId, status);
    const keys = store.changesSentTo(threadId);
    if (keys.length > 0) deps.invalidate(keys.map(reviewTag));
  };

  const view = (batch: Batch, head: string | null): BatchView => {
    const agent =
      batch.destination === "agent" && batch.state === "sent" && batch.threadId
        ? agentStatus(batch.threadId)
        : null;
    return { ...batch, agent, phase: batchPhase(batch, agent, head) };
  };

  /** What the batch carries, from the items and drafts as they are now; a string when nothing can go. */
  const payloadOf = (key: ChangeKey, input: BatchInput): Payload | string => {
    const all = deps.items(key);
    const byId = new Map(all.map((item) => [item.id, item]));
    const items = input.itemIds.flatMap((id) => byId.get(id) ?? []);
    const wanted = new Set(input.draftIds);
    const drafts = store.drafts(key).filter((draft) => wanted.has(draft.id));
    if (items.length + drafts.length === 0)
      return "Nothing to send: check a finding or write a comment first.";
    if (input.destination === "github") return githubPayload(input.head, items, drafts, byId);
    const detail = deps.detail(key);
    const change = detail.state === "change" ? detail : null;
    return {
      destination: "agent",
      text: agentText({
        branch: change?.row.branch ?? parseChangeKey(key)?.branch ?? key,
        repoName: change?.row.repo ?? "",
        base: change?.revision?.base ?? null,
        head: input.head,
        items,
        drafts,
        marker: batchMarker(input.id),
      }),
    };
  };

  /** Whether the thread already has the batch's message, sent or waiting in its queue. */
  const alreadyIn = async (threadId: string, marker: string) => {
    const [history, queued] = await Promise.all([
      bb.sdk.threads.promptHistory({ threadId, limit: "50" }),
      bb.sdk.threads.queuedMessages.list({ threadId }),
    ]);
    return JSON.stringify(history).includes(marker) || JSON.stringify(queued).includes(marker);
  };

  /** Into the thread, or a new thread in the Change's project; the message is the payload's. */
  const toAgent = (key: ChangeKey, batch: Batch, text: string) =>
    Effect.tryPromise({
      try: async (): Promise<Partial<Batch>> => {
        const marker = batchMarker(batch.id);
        if (batch.target.kind === "thread" || batch.threadId) {
          const threadId = batch.threadId ?? (batch.target as { threadId: string }).threadId;
          if (await alreadyIn(threadId, marker)) return { threadId };
          await bb.sdk.threads.send({
            threadId,
            mode: "queue-if-active",
            input: [{ type: "text", text, mentions: [] }],
          });
          return { threadId };
        }
        const detail = deps.detail(key);
        const revision = detail.state === "change" ? detail.revision : null;
        if (!revision) throw new Error("This Change has no revision an agent can work on.");
        const home = await changeHome(bb, store, key, revision);
        if (typeof home === "string") throw new Error(home);
        const thread = await bb.sdk.threads.spawn({
          projectId: home.projectId,
          environment: home.environment,
          visibility: "visible",
          title: `Fix review items on ${detail.state === "change" ? detail.row.branch : key}`,
          pluginMetadata: { kind: "fix", changeKey: key, batchId: batch.id },
          prompt: text,
        });
        return { threadId: thread.id };
      },
      catch: (error): Problem => ({ kind: "failed", site: "bb", detail: message(error) }),
    });

  const toGitHub = (
    key: ChangeKey,
    batch: Batch,
    payload: Extract<Payload, { destination: "github" }>,
  ) =>
    Effect.gen(function* () {
      const parsed = parseChangeKey(key);
      if (parsed?.kind !== "gh" || batch.target.kind !== "pull-request")
        return yield* Effect.fail(failure("This Change has no pull request to review."));
      const answer = yield* deps.sites
        .submitReview(
          {
            repo: parsed.repo,
            headOwner: parsed.headOwner,
            branch: parsed.branch,
            number: batch.target.number,
            expectedHead: batch.head,
            marker: batchMarker(batch.id),
            body: payload.body,
            comments: payload.comments,
          },
          deps.placementsFor(key),
        )
        .pipe(Effect.mapError((error) => error.problem));
      if (answer.status === "conflict") return yield* Effect.fail(failure(answer.detail));
      return { url: answer.url } satisfies Partial<Batch>;
    });

  /** One attempt; stores the outcome and returns the batch as it now is. */
  const attempt = (key: ChangeKey, batch: Batch, payload: Payload) =>
    Effect.gen(function* () {
      const sending: Batch = { ...batch, state: "sending", problem: null };
      store.putBatch(sending);
      deps.invalidate([reviewTag(key)]);
      const sent = yield* (
        payload.destination === "agent"
          ? toAgent(key, sending, payload.text)
          : toGitHub(key, sending, payload)
      ).pipe(Effect.result);
      if (sent._tag === "Success") {
        const done: Batch = { ...sending, ...sent.success, state: "sent", sentAt: deps.now() };
        store.settleSent(key, done);
        deps.invalidate([reviewTag(key)]);
        return done;
      }
      const problem = sent.failure;
      const stopped: Batch = {
        ...sending,
        state: TRANSIENT.has(problem.kind) ? "queued" : "failed",
        problem,
      };
      store.putBatch(stopped);
      deps.invalidate([reviewTag(key)]);
      return stopped;
    });

  /**
   * Sends the batch once. A known id that was sent returns as it is; one
   * queued, failed or left sending by a crash is tried again with what it
   * carried when accepted, after looking for its marker.
   */
  const send = (key: ChangeKey, input: BatchInput) =>
    deps.share(
      `batch:${input.id}`,
      Effect.gen(function* () {
        const known = store.batch(input.id);
        if (known) {
          if (known.key !== key || known.batch.state === "sent")
            return view(known.batch, headOf(known.key));
          const done = yield* attempt(known.key, known.batch, JSON.parse(known.payload) as Payload);
          return view(done, headOf(known.key));
        }
        const now = deps.now();
        const fresh: Batch = {
          ...input,
          state: "sending",
          problem: null,
          createdAt: now,
          sentAt: null,
          threadId: input.target.kind === "thread" ? input.target.threadId : null,
          url: null,
        };
        const payload = payloadOf(key, input);
        if (typeof payload === "string") {
          const refused: Batch = { ...fresh, state: "failed", problem: failure(payload) };
          store.acceptBatch(key, refused, "null");
          deps.invalidate([reviewTag(key)]);
          return view(refused, headOf(key));
        }
        store.acceptBatch(key, fresh, JSON.stringify(payload));
        const done = yield* attempt(key, fresh, payload);
        return view(done, headOf(key));
      }),
    );

  return {
    send,
    /** The Change's batches, each with its agent's status and what it shows. */
    batches(key: ChangeKey): BatchView[] {
      const head = headOf(key);
      return store.batches(key).map((batch) => view(batch, head));
    },
    threadStatus,
    async stop(key: ChangeKey, batchId: string) {
      const found = store.batch(batchId);
      if (!found || found.key !== key || !found.batch.threadId)
        return { ok: false as const, message: "That batch has no agent thread." };
      try {
        await bb.sdk.threads.stop({ threadId: found.batch.threadId });
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, message: message(error) };
      }
    },
    /** Threads on the Change's branch, then those batches went to before; titles and status from bb. */
    async targets(key: ChangeKey): Promise<AgentTarget[]> {
      const onChange = deps.threadsOnChange(key);
      const earlier = store
        .batches(key)
        .flatMap((batch) => (batch.threadId ? [batch.threadId] : []));
      const ids = [...new Set([...onChange, ...earlier])].slice(0, 20);
      const on = new Set(onChange);
      return Promise.all(
        ids.map(async (threadId): Promise<AgentTarget> => {
          try {
            const thread = await bb.sdk.threads.get({ threadId });
            const status = statusOf(thread.status);
            threadStatus(threadId, status);
            return { threadId, title: thread.title ?? null, status, onChange: on.has(threadId) };
          } catch {
            return { threadId, title: null, status: "gone", onChange: on.has(threadId) };
          }
        }),
      ).then((all) => all.filter((target) => target.status !== "gone"));
    },
  };
}

export type Batches = ReturnType<typeof createBatches>;
