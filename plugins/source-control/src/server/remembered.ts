/**
 * The last Change of a thread whose checkout is gone. bb removes a crew
 * thread's worktree after handoff, but its pull request is still on GitHub,
 * so the thread's list row keeps showing it, read by the Change's key with
 * no checkout.
 *
 * The forge read remembers a thread's Change whenever it finds one
 * (forge-read.ts). Only another Change replaces it: a read on no branch, as
 * after a detached handoff, leaves it. A thread never read on a checkout
 * takes the Change of the branch bb recorded for its environment, when
 * exactly one stored pull request read has that branch. A merged pull
 * request is not read again.
 */
import { Effect } from "effect";
import type { ThreadChange } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import { parseChangeKey } from "../core/review.ts";
import { rememberedStatus, threadStatus, type ThreadStatus } from "../core/status.ts";
import type { Store } from "./store.ts";

export function createRemembered(deps: {
  store: Store;
  announce: (threadIds: Iterable<string>) => void;
  /** Whether the Change's pull request is due another read. */
  forgeDue: (key: ChangeKey) => boolean;
  /** Read the Change's pull request by its key alone. */
  readForge: (key: ChangeKey) => Effect.Effect<void>;
  now: () => number;
  /** How long a list row trusts its last look before asking bb and GitHub again. */
  glanceMs: number;
}) {
  const { store } = deps;
  /** Threads shown a remembered Change: told of its reads, never counted among its owners. */
  const showing = new Map<ChangeKey, Set<string>>();
  /** When each thread with no checkout was last resolved. */
  const lookedAt = new Map<string, number>();

  /** The thread's remembered GitHub Change and its remote branch, noting that the thread shows it. */
  function last(threadId: string): { key: ChangeKey; branch: string } | null {
    const key = store.lastChange(threadId);
    const parsed = key ? parseChangeKey(key) : null;
    if (!key || parsed?.kind !== "gh") return null;
    const threads = showing.get(key) ?? new Set<string>();
    threads.add(threadId);
    showing.set(key, threads);
    return { key, branch: parsed.branch };
  }

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
    read: Effect.fnUntraced(function* (threadId: string, branchName: string | null) {
      lookedAt.set(threadId, deps.now());
      if (!store.lastChange(threadId) && branchName) {
        const found = store.forgeKeysOnBranch(branchName);
        if (found.length === 1 && store.rememberChange(threadId, found[0]!))
          deps.announce([threadId]);
      }
      const change = last(threadId);
      if (!change || store.forge(change.key).read?.value?.state === "merged") return;
      if (deps.forgeDue(change.key)) yield* deps.readForge(change.key);
    }),
  };
}
