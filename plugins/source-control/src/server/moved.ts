/**
 * What moved from code-review at the cutover: pull request watches, landed
 * work, the `bb review` command, the babysit and review skills, pins and the
 * reviewer's standing instructions; plus the import that carries the old
 * plugins' data across and the lookups that draw their old cards.
 *
 * While code-review still runs, the watch and landed services idle and their
 * tools and skills stay off, so a thread is never woken twice or offered two
 * tools for one job (see `legacy.ts`).
 */
import {
  cliCommand,
  defineCli,
  type BbPluginApi,
  type ExperimentalPluginRpcHandlersWithContext,
  type PluginAgentConfigurationContext,
  type PluginAgentToolContext,
} from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import type { Effect } from "effect";
import { z } from "zod";
import type { Placement } from "../core/change.ts";
import { changeKeySchema, prWatchTag, type ChangeKey } from "../core/ids.ts";
import {
  loginSchema,
  parsePrReference,
  prKey,
  type CommitRef,
  type Landed,
  type PrRef,
  type WatchRead,
} from "../core/watch.ts";
import type { sourceControlContract } from "../contract/rpc.ts";
import type { ReviewAnswer, ReviewRead } from "../forge/review.ts";
import { createCutover, legacyBranchId } from "./cutover.ts";
import type { SiteOutcome } from "./forge-sites.ts";
import type { HostCalls } from "./host-calls.ts";
import { createLanded, SHARE_LANDED } from "./landed.ts";
import { createLegacy, LEGACY_PLUGIN } from "./legacy.ts";
import { createPrWatcher, WATCH_PR } from "./pr-watch.ts";
import { pinsOf, rowsOf } from "./review-sources.ts";
import { playbook, prompt } from "./review-cli.ts";
import type { Store } from "./store.ts";

const files = instructionFiles(import.meta.url);

type BackgroundRead = (
  login: string | null,
  repo: { owner: string; name: string },
  read: ReviewRead,
  placements: readonly Placement[],
) => Effect.Effect<SiteOutcome<ReviewAnswer>>;

const quiet = new Set(["side-chat", "review"]);
const answering = /^(Arena|Review) \((Claude|Codex)\)(?: — .+)?$/;
const NOT_OWNERS = new Set(["review", "guide", "ask"]);

/**
 * Authors own their pull requests: they watch and land them. Review, guide
 * and Ask threads, and answering reviewer children, receive only their brief.
 */
export function ownsPullRequests(session: PluginAgentConfigurationContext): boolean {
  const { parentThreadId, title } = session.thread;
  const kind = (session.pluginMetadata as { kind?: unknown }).kind;
  return !(
    quiet.has(session.origin.pluginId ?? "") ||
    (typeof kind === "string" && NOT_OWNERS.has(kind)) ||
    (parentThreadId && answering.test(title ?? ""))
  );
}

/** The ChangeKey of a pull request from its head branch, as a checkout of it would derive it. */
function prChangeKey(ref: PrRef, head: { headOwner: string; branch: string }): ChangeKey {
  return changeKeySchema.parse(
    `gh:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}:${head.headOwner.toLowerCase()}:${head.branch}`,
  );
}

const repoOf = (ref: { owner: string; repo: string }) => ({ owner: ref.owner, name: ref.repo });

/** The composer banner's reads of a thread's watches, and its Unwatch. */
function watchHandlers(watcher: ReturnType<typeof createPrWatcher>) {
  return {
    prWatches: ({ keys }) =>
      Object.fromEntries(keys.map((threadId) => [threadId, watchesOf(watcher, threadId)])),
    stopPrWatch: async ({ threadId, ref }) => ({ stopped: await watcher.stop(threadId, ref) }),
  } satisfies Partial<ExperimentalPluginRpcHandlersWithContext<typeof sourceControlContract>>;
}

/** One thread's watches as the banner shows them. */
function watchesOf(watcher: ReturnType<typeof createPrWatcher>, threadId: string) {
  return {
    watches: watcher.list(threadId).map((record) => ({
      ref: record.ref,
      account: record.account,
      url: record.url,
      title: record.title,
      state: record.state,
      mergeState: record.mergeState,
      checks: record.checks,
      polledAt: record.polledAt,
      error: record.error,
      ended: record.ended,
    })),
  };
}

/** The closing agent message of the thread's last turn, from its newest events. */
async function lastReply(bb: BbPluginApi, threadId: string): Promise<string | null> {
  const events = (await bb.sdk.threads.events.list({
    threadId,
    order: "desc",
    limit: "10",
    types: ["item/completed"],
  })) as { data: unknown }[];
  for (const event of events) {
    const item = (event.data as { item?: Record<string, unknown> } | null)?.item;
    if (item?.["type"] === "agentMessage" && typeof item["text"] === "string") return item["text"];
  }
  return null;
}

export function createMoved(deps: {
  bb: BbPluginApi;
  store: Store;
  host: HostCalls;
  read: BackgroundRead;
  run: <A>(effect: Effect.Effect<A>) => Promise<A>;
  invalidate: (tags: readonly string[]) => void;
  /** A pin changed: the inboxes read again, so the list shows it. */
  pinsChanged: () => void;
  now: () => number;
}) {
  const { bb, store } = deps;
  const legacy = createLegacy(bb, deps.now);
  const placementsOf = (threadId: string): Placement[] => {
    const where = store.placement(threadId);
    return where?.state === "checkout" ? [where.placement] : [];
  };
  const read = (
    login: string | null,
    repo: { owner: string; name: string },
    what: ReviewRead,
    threadId: string | null,
  ) =>
    deps.run(deps.read(login, repo, what, threadId ? placementsOf(threadId) : store.checkouts()));
  const narrow = <K extends ReviewAnswer["kind"], T>(
    outcome: SiteOutcome<ReviewAnswer>,
    kind: K,
    pick: (answer: Extract<ReviewAnswer, { kind: K }>) => T,
  ): SiteOutcome<T> =>
    !outcome.ok
      ? outcome
      : outcome.value.kind === kind
        ? {
            ok: true,
            login: outcome.login,
            value: pick(outcome.value as Extract<ReviewAnswer, { kind: K }>),
          }
        : { ok: false, reason: "failed", message: "GitHub answered something else." };

  const watcher = createPrWatcher({
    changed: (threadId) => deps.invalidate([prWatchTag(threadId)]),
    bb,
    store,
    now: deps.now,
    standingDown: legacy.running,
    read: async (login, ref, threadId): Promise<SiteOutcome<WatchRead>> =>
      narrow(
        await read(login, repoOf(ref), { kind: "watch", ref }, threadId),
        "watch",
        (a) => a.read,
      ),
  });
  const landed = createLanded({
    bb,
    store,
    watcher,
    now: deps.now,
    standingDown: legacy.running,
    lastReply: lastReply.bind(null, bb),
    read: async (login, listed, threadId): Promise<SiteOutcome<Landed>> => {
      const first: { owner: string; repo: string } | undefined = listed.prs[0] ?? listed.commits[0];
      if (!first) return { ok: false, reason: "failed", message: "Nothing listed." };
      return narrow(
        await read(
          login,
          repoOf(first),
          { kind: "landed", prs: listed.prs, commits: listed.commits as CommitRef[] },
          threadId,
        ),
        "landed",
        (a) => a.landed,
      );
    },
  });

  const settings = bb.settings.define({
    reviewInstructions: {
      type: "string",
      label: "Review instructions",
      description:
        "Standing instructions every bb review of a Change gets, after the review criteria. Carried over from code-review at the cutover.",
      default: "",
      experimental_multiline: true,
    },
  });
  const instructions = {
    get: async () => (await settings.get()).reviewInstructions,
    set: async (text: string) => {
      await settings.experimental_set({ reviewInstructions: text });
    },
  };

  const cutover = createCutover({
    bb,
    store,
    host: deps.host,
    watcher,
    landed,
    instructions,
    now: deps.now,
  });

  const watchParameters = z
    .object({
      reference: z.string().min(1),
      account: loginSchema.optional(),
      stop: z.boolean().optional(),
    })
    .strict();
  const watchTool = {
    name: WATCH_PR,
    ...files.tool(WATCH_PR),
    presentation: {
      label: { pending: "Updating pull request watch", completed: "Updated pull request watch" },
    },
    parameters: watchParameters,
    async execute(
      { reference, account, stop }: z.output<typeof watchParameters>,
      { threadId }: PluginAgentToolContext,
    ) {
      const ref = parsePrReference(reference);
      if (!ref) throw new Error("Use a GitHub pull request URL or owner/repo#123.");
      if (!stop) {
        const watching = await watcher.watch(threadId, ref, account);
        // An open pull request means the thread's work has not all landed.
        await landed.reopen(threadId, ref);
        return watching;
      }
      return (await watcher.stop(threadId, ref))
        ? `Stopped watching ${prKey(ref)}.`
        : `This thread was not watching ${prKey(ref)}.`;
    },
  };

  /** An old card's target as a Change: by the stored mapping, the checkouts' rows, or GitHub. */
  async function legacyChange(
    lookup: string,
  ): Promise<{ key: ChangeKey | null; problem: string | null }> {
    const stored = store.legacyBranch(lookup) ?? store.legacyBranch(lookup.replace(/^branch:/, ""));
    if (stored) return { key: stored, problem: null };
    if (lookup.startsWith("branch:")) {
      const id = lookup.slice("branch:".length);
      for (const placement of store.checkouts())
        for (const row of rowsOf(store, placement))
          if (legacyBranchId(placement.hostId, placement.path, row.branch) === id) {
            store.putLegacyBranch(id, row.key as ChangeKey);
            return { key: row.key as ChangeKey, problem: null };
          }
      return { key: null, problem: "This branch is no longer in a checkout Source Control reads." };
    }
    const ref = parsePrReference(lookup.replace(/^pr:/, ""));
    if (!ref) return { key: null, problem: "This card names no pull request." };
    const outcome = await read(null, repoOf(ref), { kind: "prHead", ref }, null);
    if (!outcome.ok || outcome.value.kind !== "prHead")
      return {
        key: null,
        problem: outcome.ok ? "GitHub answered something else." : outcome.message,
      };
    const key = prChangeKey(ref, outcome.value.head);
    store.putLegacyBranch(lookup, key);
    return { key, problem: null };
  }

  const handlers = {
    importFromOldPlugins: () => cutover.run(),
    legacyChange: async ({ keys }) =>
      Object.fromEntries(
        await Promise.all(keys.map(async (key) => [key, await legacyChange(key)] as const)),
      ),
    landedCard: async (target) => {
      const first = target.prs[0] ?? target.commits[0];
      if (!first) return { ok: false as const, message: "Nothing listed.", away: false };
      const outcome = await read(
        target.account,
        repoOf(first),
        { kind: "landed", prs: target.prs, commits: target.commits },
        // With no account named, the thread's own host answers first, as it did for the title.
        target.account === null ? (target.threadId ?? null) : null,
      );
      if (outcome.ok && outcome.value.kind === "landed")
        return { ok: true as const, landed: outcome.value.landed };
      return {
        ok: false as const,
        message: outcome.ok ? "GitHub answered something else." : outcome.message,
        away: !outcome.ok && (outcome.reason === "away" || outcome.reason === "rate-limited"),
      };
    },
    ...watchHandlers(watcher),
    pins: () => ({ pins: pinsOf(store) }),
    setPinned: ({ ref, pinned }) => {
      const changed = pinned
        ? store.putPin(prKey(ref), JSON.stringify(ref), deps.now())
        : store.dropPin(prKey(ref));
      if (changed) deps.pinsChanged();
      return { ok: true as const };
    },
  } satisfies Partial<ExperimentalPluginRpcHandlersWithContext<typeof sourceControlContract>>;

  const importCommand = cliCommand({
    summary: files.read("commands/import"),
    options: { json: { type: "boolean", description: "Print the report as JSON." } },
    async run({ options }) {
      const report = await cutover.run();
      if (options.json) return { exitCode: 0, stdout: `${JSON.stringify(report, null, 2)}\n` };
      const lines = Object.entries(report.counts).map(([kind, count]) => {
        const skipped = Object.entries(count.skipped)
          .map(([reason, n]) => `${n} ${reason}`)
          .join("; ");
        return `${kind}: read ${count.read}, imported ${count.imported}, already present ${count.present}${skipped ? `, skipped ${skipped}` : ""}`;
      });
      for (const each of report.unavailable)
        lines.push(`${each.plugin}: not read (${each.reason})`);
      return { exitCode: report.unavailable.length ? 1 : 0, stdout: `${lines.join("\n")}\n` };
    },
  });

  return {
    legacy,
    watcher,
    landed,
    instructions,
    handlers,
    register() {
      bb.agents.registerTool(watchTool);
      bb.agents.registerTool(landed.tool);
      bb.background.service("pr-watch", watcher.service);
      bb.background.service("landed", landed.service);
      // bb gives a plugin one CLI command, chosen here once at startup. While code-review runs it
      // owns `bb review` and its export answers, so Source Control offers `bb source-control
      // import`; once code-review is gone there is nothing left to import and Source Control
      // takes `bb review`. Reloading Source Control after either plugin changes state re-chooses.
      const registerCommand = (running: boolean) => {
        try {
          bb.cli.register(
            running
              ? defineCli({
                  name: "source-control",
                  summary:
                    "Source Control: import the old code-review and gitbutler plugins' data.",
                  commands: { import: importCommand },
                })
              : defineCli({
                  name: "review",
                  summary: "Review playbooks and the shared reviewer prompt.",
                  commands: { playbook: playbook(bb), prompt: prompt() },
                }),
          );
        } catch (error) {
          bb.log.warn(`Could not register a command: ${String(error)}`);
        }
      };
      void legacy.refresh().then(registerCommand);
    },
    /** Tools and skills for a session: only once code-review no longer offers its own. */
    configure(session: PluginAgentConfigurationContext) {
      const own = !legacy.running() && ownsPullRequests(session);
      return {
        tools: own ? [WATCH_PR, SHARE_LANDED] : [],
        skills: own ? ["request-review", "babysit-pr"] : [],
      };
    },
    threadSettled(threadId: string) {
      void watcher.flush(threadId).catch(() => {});
      void landed.replied(threadId);
    },
    threadGone(threadId: string) {
      void watcher.forget(threadId);
      landed.forget(threadId);
    },
  };
}

export { LEGACY_PLUGIN };
export type Moved = ReturnType<typeof createMoved>;
