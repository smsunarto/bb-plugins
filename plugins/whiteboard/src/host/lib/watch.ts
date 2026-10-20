import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk/host";
import type {
  HostInput,
  HostOutput,
  WhiteboardHostSignals,
} from "../../shared/contracts/host-contract.ts";

const watches = new Map<string, Promise<ExperimentalHostWatchSubscription>>();

/**
 * Git bookkeeping that never changes a worktree inspection, which reads only
 * HEAD's commit and the listed files' stats: object storage and reflogs (a
 * commit or checkout also moves a ref or the index, which stay watched),
 * GitButler's own state, and Whiteboard's scratch checkouts under `dev-fast`.
 * Each would otherwise bump the engine's epoch and cost a host re-inspection.
 */
const GIT_BOOKKEEPING = ["objects", "logs", "gitbutler", "dev-fast"];
/** Quiet period before a delivery. The engine re-inspects at most once a second. */
const WATCH_DEBOUNCE_MS = 250;

const canonical = (target: string) => realpath(target).catch(() => path.resolve(target));

/**
 * Root-relative ignores for a watch root, from the Git common directory the
 * server resolved for its repository and watches as a root of its own. That
 * root ignores only the bookkeeping. A checkout holding the common directory
 * (a primary checkout's `.git`) ignores all of it, because the common
 * directory's own watch reports HEAD, refs and the index. Any other root,
 * such as a linked worktree, ignores nothing. Never inferred from a root's
 * contents: a checkout may hold source files named `HEAD` or `objects/`.
 */
export async function ignoredGitPaths(
  rootPath: string,
  gitCommonDir: string | undefined,
): Promise<string[]> {
  if (!gitCommonDir) return [];
  const [root, common] = await Promise.all([canonical(rootPath), canonical(gitCommonDir)]);
  const inside = path.relative(root, common);
  if (!inside) return GIT_BOOKKEEPING;
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return [];
  return [inside.split(path.sep).join("/")];
}

/**
 * Watch a checkout through the daemon's native watcher and emit one
 * `worktreeChanged` signal per coalesced delivery (design §1.3). The watch
 * outlives this call and retains the worker; a worker exit drops it, and the
 * server re-arms it from `experimental_onWorkerExit`. A daemon restart emits
 * no exit, so the server also asks `watchAlive` and re-arms what is gone.
 * Re-watching an id replaces its watch.
 */
export async function watchWorktree(
  input: HostInput<"watchWorktree">,
  context: ExperimentalHostRpcContext<WhiteboardHostSignals>,
): Promise<HostOutput<"watchWorktree">> {
  await unwatchWorktree({ watchId: input.watchId });
  const options = {
    rootPath: input.rootPath,
    ignoredPaths: await ignoredGitPaths(input.rootPath, input.gitCommonDir),
    debounceMs: WATCH_DEBOUNCE_MS,
  };
  const subscription = context.experimental_watch(options, async (event) => {
    await context
      .experimental_emitSignal("worktreeChanged", {
        watchId: input.watchId,
        rootPath: input.rootPath,
        kind: event.kind,
      })
      .catch(() => {});
  });
  watches.set(input.watchId, subscription);
  try {
    await subscription;
  } catch (error) {
    if (watches.get(input.watchId) === subscription) watches.delete(input.watchId);
    throw error;
  }
  return { ok: true };
}

export function watchAlive(input: HostInput<"watchAlive">): HostOutput<"watchAlive"> {
  return { live: input.watchIds.filter((watchId) => watches.has(watchId)) };
}

export async function unwatchWorktree(
  input: HostInput<"unwatchWorktree">,
): Promise<HostOutput<"unwatchWorktree">> {
  const subscription = watches.get(input.watchId);
  watches.delete(input.watchId);
  await subscription?.then((live) => live.dispose()).catch(() => {});
  return { ok: true };
}
