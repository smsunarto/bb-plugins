/**
 * The last Change of a thread whose checkout is gone. bb removes a crew
 * thread's worktree after handoff, but its pull request is still on GitHub,
 * so the thread's list row keeps showing it, read by the Change's key with
 * no checkout.
 *
 * The forge read remembers a thread's Change, with its checkout's host,
 * whenever it finds one (forge-read.ts). Only another Change replaces it: a
 * read on no branch, as after a detached handoff, leaves it. A thread never
 * read on a checkout takes the Change its project's GitHub repository has on
 * the branch bb recorded for its environment, when that pull request has
 * been read; with no repository, nothing. A merged pull request is not read
 * again.
 *
 * Its pull request is read on the server and the remembered host only: a
 * machine that read the repository last, or any other checkout's host, can
 * be asleep, and must not hold this thread's read up.
 */
import { Effect } from "effect";
import type { ThreadChange } from "../core/change.ts";
import { changeKeyOf, type ChangeKey, type Repo } from "../core/ids.ts";
import { parseChangeKey } from "../core/review.ts";
import { rememberedStatus, threadStatus, type ThreadStatus } from "../core/status.ts";
import type { ForgeHost } from "./forge-sites.ts";
import type { RecordedEnvironment } from "./placement.ts";
import type { Store } from "./store.ts";

export function createRemembered(deps: {
  store: Store;
  announce: (threadIds: Iterable<string>) => void;
  /** Whether the Change's pull request is due another read. */
  forgeDue: (key: ChangeKey) => boolean;
  /** Read the Change's pull request on the server and `host` only. */
  readForge: (key: ChangeKey, host: ForgeHost) => Effect.Effect<void>;
  /** The project's GitHub repository, or null when it has none. */
  projectRepo: (projectId: string) => Effect.Effect<Repo | null>;
  forgeHost: (hostId: string) => Effect.Effect<ForgeHost>;
  now: () => number;
  /** How long a list row trusts its last look before asking bb and GitHub again. */
  glanceMs: number;
}) {
  const { store } = deps;
  /** Threads shown a remembered Change: told of its reads, never counted among its owners. */
  const showing = new Map<ChangeKey, Set<string>>();
  /** When each thread with no checkout was last resolved. */
  const lookedAt = new Map<string, number>();

  /** The thread's remembered GitHub Change, noting that the thread shows it. */
  function last(threadId: string) {
    const remembered = store.lastChange(threadId);
    const parsed = remembered ? parseChangeKey(remembered.key) : null;
    if (!remembered || parsed?.kind !== "gh") return null;
    const threads = showing.get(remembered.key) ?? new Set<string>();
    threads.add(threadId);
    showing.set(remembered.key, threads);
    return { ...remembered, branch: parsed.branch };
  }

  /** A thread never read on a checkout: its project's Change on the recorded branch, if that pull request was read. */
  const recover = Effect.fnUntraced(function* (threadId: string, recorded: RecordedEnvironment) {
    const repo = yield* deps.projectRepo(recorded.projectId);
    if (!repo) return;
    const key = changeKeyOf(
      { hostId: recorded.hostId, commonDir: "", branch: recorded.branchName },
      { repo, headOwner: repo.owner },
    );
    if (!store.forge(key).read) return;
    const host = yield* deps.forgeHost(recorded.hostId);
    if (store.rememberChange(threadId, key, host)) deps.announce([threadId]);
  });

  return {
    /** Threads showing this Change from memory. */
    threadsOf: (key: ChangeKey): Iterable<string> => showing.get(key) ?? [],
    /** The thread's compact row: its remembered Change when it has no checkout. */
    status(threadId: string, row: ThreadChange): ThreadStatus {
      const change = row.state === "none" ? last(threadId) : null;
      return change
        ? rememberedStatus(change.key, change.branch, store.forge(change.key))
        : threadStatus(row);
    },
    /** Whether a list row should resolve the thread again. */
    due(threadId: string): boolean {
      const at = lookedAt.get(threadId);
      return at === undefined || deps.now() - at >= deps.glanceMs;
    },
    /** The thread has no checkout: read its remembered Change's pull request when due. */
    read: Effect.fnUntraced(function* (threadId: string, recorded: RecordedEnvironment | null) {
      lookedAt.set(threadId, deps.now());
      if (!store.lastChange(threadId) && recorded) yield* recover(threadId, recorded);
      const change = last(threadId);
      if (!change || store.forge(change.key).read?.value?.state === "merged") return;
      if (deps.forgeDue(change.key)) yield* deps.readForge(change.key, change.host);
    }),
  };
}
