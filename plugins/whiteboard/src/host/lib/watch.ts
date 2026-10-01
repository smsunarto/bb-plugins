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
 * Watch a checkout through the daemon's native watcher and emit one
 * `worktreeChanged` signal per coalesced delivery (design §1.3). The watch
 * outlives this call and retains the worker; a worker exit drops it, and the
 * server re-arms it from `experimental_onWorkerExit`. Re-watching an id
 * replaces its watch.
 */
export async function watchWorktree(
  input: HostInput<"watchWorktree">,
  context: ExperimentalHostRpcContext<WhiteboardHostSignals>,
): Promise<HostOutput<"watchWorktree">> {
  await unwatchWorktree({ watchId: input.watchId });
  const subscription = context.experimental_watch({ rootPath: input.rootPath }, async (event) => {
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

export async function unwatchWorktree(
  input: HostInput<"unwatchWorktree">,
): Promise<HostOutput<"unwatchWorktree">> {
  const subscription = watches.get(input.watchId);
  watches.delete(input.watchId);
  await subscription?.then((live) => live.dispose()).catch(() => {});
  return { ok: true };
}
