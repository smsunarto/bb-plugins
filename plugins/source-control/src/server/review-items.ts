/**
 * A Change's review: GitHub's review threads and bb's findings as items with
 * one id each, the reader's drafts and checked items, all in the store by
 * ChangeKey so every client reads the same and a restart keeps them. A new
 * head moves each finding and draft past the edits above it, or marks it
 * outdated when its own lines changed; nothing is dropped.
 */
import { Effect } from "effect";
import type { FilePatch, Problem } from "../core/change.ts";
import { reviewTag, type ChangeKey } from "../core/ids.ts";
import {
  forgeItem,
  lineEdits,
  moveAnchor,
  type Anchor,
  type ChangeReview,
  type ConversationResult,
  type Draft,
  type DraftInput,
  type LineEdits,
  type ReviewItem,
} from "../core/items.ts";
import { parseChangeKey, type ChangeDetail, type ReviewRevision } from "../core/review.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

/** Paths per patch read: the host contract's limit is higher, the page's is this. */
const PATCH_CHUNK = 40;

type PatchesResult = { ok: true; value: { files: FilePatch[] } } | { ok: false; problem: Problem };

export type ReviewItemsDeps = {
  store: Store;
  sites: ForgeSites;
  share: Share;
  detail: (key: ChangeKey) => ChangeDetail;
  /** File patches between two commits of a host revision. */
  patches: (
    key: ChangeKey,
    revision: ReviewRevision,
    paths: readonly string[],
  ) => Effect.Effect<PatchesResult>;
  /** Hosts a forge read may go through, the Change's own first. */
  placementsFor: (key: ChangeKey) => ReturnType<Store["checkouts"]>;
  invalidate: (tags: readonly string[]) => void;
  /** Runs work no caller waits for. */
  fork: (work: Effect.Effect<void>) => void;
  now: () => number;
};

const TRANSIENT = new Set<Problem["kind"]>([
  "host-offline",
  "auth",
  "rate-limited",
  "tool-missing",
  "no-site",
]);

/** A file's edits keyed by its path at the old head, and its path at the new one. */
type FileEdits = Map<string, { edits: LineEdits; path: string }>;

function editsOf(files: readonly FilePatch[]): FileEdits {
  const map: FileEdits = new Map();
  for (const file of files) {
    // A patch cut short says nothing reliable about lines: everything in it counts as changed.
    const edits = file.truncated
      ? { deleted: true, removed: [], inserted: [] }
      : lineEdits(file.patch, file.kind === "deleted");
    map.set(file.previousPath ?? file.path, { edits, path: file.path });
  }
  return map;
}

/** An anchor at `head`, or null for outdated; `edits` null when the change between could not be read. */
function moved(anchor: Anchor, edits: FileEdits | null, head: string): Anchor | null {
  if (anchor.side === "LEFT") return { ...anchor, head };
  if (edits === null) return null;
  const file = edits.get(anchor.path);
  const next = moveAnchor(anchor, file?.edits, head);
  return next && file ? { ...next, path: file.path } : next;
}

export function createReviewItems(deps: ReviewItemsDeps) {
  const { store } = deps;

  const headOf = (key: ChangeKey) => {
    const detail = deps.detail(key);
    return detail.state === "change" ? detail.revision : null;
  };

  /** Findings and drafts still anchored at an older head than the Change's. */
  const behind = (key: ChangeKey, head: string) => ({
    findings: store
      .findings(key)
      .filter((item) => item.state === "open" && item.anchor.head !== head),
    drafts: store
      .drafts(key)
      .filter((draft) => draft.state === "pending" && draft.anchor.head !== head),
  });

  /** What changed between `from` and the revision's head, for these paths; null when it cannot be read. */
  const editsSince = (key: ChangeKey, revision: ReviewRevision, from: string, paths: string[]) =>
    Effect.gen(function* () {
      if (paths.length === 0) return new Map() as FileEdits;
      if (revision.source.kind === "host") {
        const files: FilePatch[] = [];
        for (let start = 0; start < paths.length; start += PATCH_CHUNK) {
          const answer = yield* deps.patches(
            key,
            { ...revision, base: from },
            paths.slice(start, start + PATCH_CHUNK),
          );
          if (!answer.ok) return answer.problem;
          files.push(...answer.value.files);
        }
        return editsOf(files);
      }
      const parsed = parseChangeKey(key);
      if (parsed?.kind !== "gh") return null;
      const answer = yield* deps.sites
        .repoRead(
          { kind: "compare", repo: parsed.repo, base: from, head: revision.head },
          deps.placementsFor(key),
        )
        .pipe(Effect.result);
      if (answer._tag === "Failure") return answer.failure.problem;
      if (answer.success.kind !== "files") return null;
      const wanted = new Set(paths);
      return editsOf(
        answer.success.files.flatMap((entry) =>
          wanted.has(entry.file.previousPath ?? entry.file.path)
            ? [
                entry.patch ?? {
                  path: entry.file.path,
                  kind: entry.file.kind,
                  previousPath: entry.file.previousPath,
                  patch: "",
                  truncated: true,
                },
              ]
            : [],
        ),
      );
    });

  /** Move what was anchored at `old` to the revision's head; false when that change cannot be read yet. */
  const settleFrom = (
    key: ChangeKey,
    revision: ReviewRevision,
    old: string,
    items: ReviewItem[],
    drafts: Draft[],
  ) =>
    Effect.gen(function* () {
      const paths = new Set<string>();
      for (const each of [...items, ...drafts])
        if (each.anchor.side === "RIGHT") paths.add(each.anchor.path);
      const read = yield* editsSince(key, revision, old, [...paths]);
      // Away or refused for now: the next read tries again. Only a change that cannot be read at all outdates.
      if (read !== null && !(read instanceof Map) && TRANSIENT.has(read.kind)) return false;
      const edits = read instanceof Map ? read : null;
      // The rows are this pass's own copies from the store: changed in place, then written back.
      for (const each of [...items, ...drafts]) {
        const anchor = moved(each.anchor, edits, revision.head);
        if (anchor) each.anchor = anchor;
        else each.state = "outdated";
      }
      store.putFindings(key, items);
      for (const draft of drafts) store.putDraft(key, draft);
      return true;
    });

  /**
   * Bring every finding and draft to the Change's head. A host that is away
   * leaves them for the next read; any other failure to read the change
   * between marks the touched ones outdated rather than guess.
   */
  const settle = (key: ChangeKey) =>
    deps.share(
      `anchors:${key}`,
      Effect.gen(function* () {
        const revision = headOf(key);
        if (!revision) return;
        const { findings, drafts } = behind(key, revision.head);
        const olds = new Set([...findings, ...drafts].map((each) => each.anchor.head));
        let changed = false;
        for (const old of olds) {
          const items = findings.filter((item) => item.anchor.head === old);
          const mine = drafts.filter((draft) => draft.anchor.head === old);
          if (yield* settleFrom(key, revision, old, items, mine)) changed = true;
        }
        if (changed) deps.invalidate([reviewTag(key)]);
      }),
    );

  /** Settle the Change in the background when anything is behind its head. */
  const settleIfBehind = (key: ChangeKey) => {
    const revision = headOf(key);
    if (!revision) return;
    const { findings, drafts } = behind(key, revision.head);
    if (findings.length > 0 || drafts.length > 0) deps.fork(Effect.ignore(settle(key)));
  };

  const review = (key: ChangeKey): ChangeReview => {
    const pr = store.forge(key).read?.value ?? null;
    const threads = store.threads(key);
    const forgeItems = pr
      ? (threads.read?.value ?? []).flatMap((thread) => forgeItem(thread, pr.headRefOid) ?? [])
      : [];
    const items = [...store.findings(key), ...forgeItems];
    const ids = new Set(items.map((item) => item.id));
    return {
      items,
      drafts: store.drafts(key),
      selected: store.selected(key).filter((id) => ids.has(id)),
      runs: store.runs(key),
      forge: { at: threads.read?.at ?? null, problem: threads.problem },
    };
  };

  return {
    /** Stored state only; a Change behind its head settles in the background. */
    read(keys: readonly ChangeKey[]): Record<string, ChangeReview> {
      return Object.fromEntries(
        keys.map((key) => {
          settleIfBehind(key);
          return [key, review(key)];
        }),
      );
    },
    settle,
    settleIfBehind,
    /** Saves a draft; the same client id twice is one draft, the second an edit. */
    saveDraft(key: ChangeKey, input: DraftInput): Draft {
      const before = store.draft(key, input.id);
      const sameAnchor =
        before !== null && JSON.stringify(before.anchor) === JSON.stringify(input.anchor);
      const now = deps.now();
      const draft: Draft = {
        ...input,
        state: sameAnchor ? before.state : "pending",
        createdAt: before?.createdAt ?? now,
        updatedAt:
          sameAnchor && before.body === input.body && before.replyTo === input.replyTo
            ? before.updatedAt
            : now,
      };
      if (store.putDraft(key, draft)) deps.invalidate([reviewTag(key)]);
      settleIfBehind(key);
      return draft;
    },
    deleteDraft(key: ChangeKey, id: string): void {
      if (store.dropDraft(key, id)) deps.invalidate([reviewTag(key)]);
    },
    setSelected(key: ChangeKey, ids: readonly string[], selected: boolean): void {
      if (store.setSelected(key, ids, selected)) deps.invalidate([reviewTag(key)]);
    },
    /** A review thread's report replaces its earlier one; each finding gets `bb:<threadId>:<n>`. */
    report(
      threadId: string,
      summary: string,
      findings: readonly {
        priority: number;
        title: string;
        body: string;
        path: string;
        line: number;
        startLine?: number | undefined;
        side?: "LEFT" | "RIGHT" | undefined;
      }[],
    ): { key: ChangeKey; count: number } | null {
      const linked = store.run(threadId);
      if (!linked) return null;
      const { key, run } = linked;
      const createdAt = new Date(deps.now()).toISOString();
      const items = findings.map((finding, index): ReviewItem => {
        const start = finding.startLine ?? finding.line;
        return {
          id: `bb:${threadId}:${index + 1}`,
          origin: { kind: "bb", threadId },
          priority: finding.priority,
          title: finding.title,
          body: finding.body,
          anchor: {
            path: finding.path,
            line: Math.max(start, finding.line),
            startLine: start === finding.line ? null : Math.min(start, finding.line),
            side: finding.side ?? "RIGHT",
            head: run.head,
          },
          state: "open",
          url: null,
          createdAt,
          replies: [],
        };
      });
      store.replaceFindings(key, threadId, items);
      store.putRun(key, {
        ...run,
        state: "reported",
        summary: summary.trim() || null,
        findings: items.length,
      });
      deps.invalidate([reviewTag(key)]);
      settleIfBehind(key);
      return { key, count: items.length };
    },
    /** A review thread stopped: one that never reported ended without findings, or failed. */
    runEnded(threadId: string, failed: boolean): void {
      const linked = store.run(threadId);
      if (!linked || linked.run.state !== "running") return;
      store.putRun(linked.key, { ...linked.run, state: failed ? "failed" : "finished" });
      deps.invalidate([reviewTag(linked.key)]);
    },
    /** The pull request's conversation, through any site that can see it. */
    conversation: (key: ChangeKey) =>
      Effect.gen(function* () {
        const parsed = parseChangeKey(key);
        const pr = store.forge(key).read?.value ?? null;
        if (parsed?.kind !== "gh" || !pr)
          return {
            ok: false,
            problem: { kind: "moved", detail: "This Change has no pull request yet." },
          } satisfies ConversationResult;
        const answer = yield* deps.sites
          .repoRead(
            { kind: "timeline", repo: parsed.repo, number: pr.number },
            deps.placementsFor(key),
          )
          .pipe(Effect.result);
        if (answer._tag === "Failure")
          return { ok: false, problem: answer.failure.problem } satisfies ConversationResult;
        return {
          ok: true,
          items: answer.success.kind === "timeline" ? answer.success.items : [],
        } satisfies ConversationResult;
      }),
  };
}

export type ReviewItems = ReturnType<typeof createReviewItems>;
