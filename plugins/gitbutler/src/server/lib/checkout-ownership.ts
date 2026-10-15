import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostClient } from "./target.ts";

const RUNNING = new Set(["pending", "starting", "active", "stopping"]);
const PAGE = 100;

/** Archived agents may still be finishing a turn. Hidden threads can own work too. */
async function* checkoutOwners(bb: BbPluginApi, callerThreadId: string, hostId: string) {
  for (const archived of [false, true]) {
    for (let offset = 0; ; offset += PAGE) {
      const threads = await bb.sdk.threads.list({
        hostId,
        includeHidden: true,
        archived,
        limit: PAGE,
        offset,
      });
      for (const thread of threads.filter(
        (thread) =>
          thread.id !== callerThreadId &&
          thread.deletedAt === null &&
          thread.environmentPath &&
          (RUNNING.has(thread.status) || thread.queuedWork !== "none"),
      ))
        yield thread;
      if (threads.length < PAGE) break;
    }
  }
}

/** An active agent's clean working tree is still owned. Compare canonical repository roots. */
export async function assertCheckoutIdle(
  bb: BbPluginApi,
  callerThreadId: string,
  repository: { hostId: string; path: string },
): Promise<void> {
  const client = hostClient(bb);
  const canonical = new Map<string, Promise<Set<string>>>();
  const pathsAt = (environmentPath: string) => {
    let paths = canonical.get(environmentPath);
    if (!paths) {
      paths = (async () => {
        const { repositories } = await client.call(
          "repositories",
          { environmentPath },
          {
            hostId: repository.hostId,
          },
        );
        const paths = await Promise.all(
          repositories.map(async ({ key }) => {
            const found = await client.call(
              "origin",
              { environmentPath, repositoryKey: key },
              {
                hostId: repository.hostId,
              },
            );
            return found.path;
          }),
        );
        return new Set(paths);
      })();
      canonical.set(environmentPath, paths);
    }
    return paths;
  };
  for await (const thread of checkoutOwners(bb, callerThreadId, repository.hostId)) {
    if (thread.environmentPath && (await pathsAt(thread.environmentPath)).has(repository.path)) {
      throw new Error(
        `This checkout is in use by ${thread.title ?? thread.titleFallback ?? thread.id} (${thread.id}). Wait for its work to finish and try again.`,
      );
    }
  }
}

/** A spawn must become visible before another checkout operation checks for an active owner. */
const operations = new WeakMap<BbPluginApi, Map<string, Promise<void>>>();

export function inCheckout<T>(
  bb: BbPluginApi,
  repository: { hostId: string; path: string },
  run: () => Promise<T>,
): Promise<T> {
  let queue = operations.get(bb);
  if (!queue) {
    queue = new Map();
    operations.set(bb, queue);
  }
  const key = JSON.stringify([repository.hostId, repository.path]);
  const result = (queue.get(key) ?? Promise.resolve()).then(run);
  const barrier = result.then(
    () => undefined,
    () => undefined,
  );
  queue.set(key, barrier);
  void barrier.then(() => {
    if (queue.get(key) === barrier) queue.delete(key);
    if (queue.size === 0) operations.delete(bb);
    return undefined;
  });
  return result;
}
