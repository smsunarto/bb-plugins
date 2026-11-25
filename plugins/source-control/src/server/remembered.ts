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
 * the branch bb recorded for its environment, when that branch has a cached
 * read; that inference lasts only while the evidence identifies one head
 * owner. With no repository, nothing. A merged pull request is not read
 * again.
 *
 * Its pull request is read on the server and the remembered host only: a
 * machine that read the repository last, or any other checkout's host, can
 * be asleep, and must not hold this thread's read up.
 */
import { Effect } from "effect";
import type { ThreadChange } from "../core/change.ts";
import type { ChangeKey, Repo } from "../core/ids.ts";
import { parseChangeKey } from "../core/review.ts";
import { rememberedStatus, threadStatus, type ThreadStatus } from "../core/status.ts";
import type { ForgeHost } from "./forge-sites.ts";
import type { RecordedEnvironment } from "./placement.ts";
import type { Store } from "./store.ts";

export function createRemembered(deps: {
  store: Store;
  announce: (threadIds: Iterable<string>) => void;
  /** Whether the Change's pull request is due another read. */
  forgeDue: (key: ChangeKey, hostId: string) => boolean;
  /** Read the Change's pull request on the server and `host` only. */
  readForge: (key: ChangeKey, host: ForgeHost) => Effect.Effect<void>;
  /** The project's GitHub repository, null when absent, or undefined when BB could not answer. */
  projectRepo: (projectId: string) => Effect.Effect<Repo | null | undefined>;
  forgeHost: (hostId: string) => Effect.Effect<ForgeHost>;
  now: () => number;
  /** How long a list row trusts its last look before asking bb and GitHub again. */
  glanceMs: number;
}) {
  const { store } = deps;
  /** Threads shown a remembered Change: told of its reads, never counted among its owners. */
  const showing = new Map<ChangeKey, Set<string>>();
  /** Inferred Changes also depend on forge reads of sibling forks of their branch. */
  const inferenceReaders = new Map<string, Set<string>>();
  const identity = ({ owner, name }: Repo, branch: string) => JSON.stringify([owner, name, branch]);
  /** When each thread with no checkout was last resolved. */
  const lookedAt = new Map<string, number>();

  /** The thread's remembered GitHub Change, noting that the thread shows it. */
  function last(threadId: string) {
    const remembered = store.lastChange(threadId);
    const parsed = remembered ? parseChangeKey(remembered.key) : null;
    if (!remembered || parsed?.kind !== "gh") return null;
    if (remembered.inferred) {
      const { repo, branch } = parsed;
      const branchId = identity(repo, branch);
      const readers = inferenceReaders.get(branchId) ?? new Set<string>();
      readers.add(threadId);
      inferenceReaders.set(branchId, readers);
      if (store.knownBranchChange(repo, branch, remembered.key) !== remembered.key) return null;
    }
    const threads = showing.get(remembered.key) ?? new Set<string>();
    threads.add(threadId);
    showing.set(remembered.key, threads);
    return { ...remembered, branch: parsed.branch };
  }

  /** A thread never read on a checkout: its project's Change on the recorded branch, if that branch was read. */
  const recover = Effect.fnUntraced(function* (threadId: string, recorded: RecordedEnvironment) {
    const prior = store.lastChange(threadId);
    const parsed = prior?.inferred ? parseChangeKey(prior.key) : null;
    if (parsed?.kind === "gh" && parsed.branch !== recorded.branchName) {
      if (store.forgetInference(threadId)) deps.announce([threadId]);
    }
    const repo = yield* deps.projectRepo(recorded.projectId);
    if (repo === undefined) return;
    const sameBranch =
      repo &&
      parsed?.kind === "gh" &&
      identity(repo, recorded.branchName) === identity(parsed.repo, parsed.branch);
    const key = repo
      ? store.knownBranchChange(repo, recorded.branchName, sameBranch ? prior?.key : undefined)
      : null;
    if (!key) {
      if (store.forgetInference(threadId)) deps.announce([threadId]);
      return;
    }
    const host =
      prior?.host.hostId === recorded.hostId ? prior.host : yield* deps.forgeHost(recorded.hostId);
    if (store.rememberChange(threadId, key, host, true)) deps.announce([threadId]);
  });

  return {
    /** Threads showing this Change from memory. */
    *threadsOf(key: ChangeKey): Iterable<string> {
      yield* showing.get(key) ?? [];
      const parsed = parseChangeKey(key);
      if (parsed?.kind === "gh")
        yield* inferenceReaders.get(identity(parsed.repo, parsed.branch)) ?? [];
    },
    /** The thread's compact row: its remembered Change when it has no checkout. */
    status(threadId: string, row: ThreadChange): ThreadStatus {
      const change = row.state === "none" ? last(threadId) : null;
      return change
        ? rememberedStatus(change.key, change.branch, store.forge(change.key, change.host.hostId))
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
      if (recorded && (store.lastChange(threadId)?.inferred ?? true))
        yield* recover(threadId, recorded);
      const change = last(threadId);
      if (!change || store.forge(change.key).read?.value?.state === "merged") return;
      if (deps.forgeDue(change.key, change.host.hostId))
        yield* deps.readForge(change.key, change.host);
    }),
  };
}
