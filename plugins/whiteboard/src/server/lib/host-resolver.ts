import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostResolver } from "../../shared/contracts/engine.ts";
import { ReviewInputError } from "../../shared/vendor/review/src/review-api/input-error.ts";
import { currentThread } from "./thread-context.ts";

export const NO_HOST_MESSAGE =
  "Whiteboard cannot tell which bb host has this checkout. Run the tool from a thread in that project.";

export function boundElsewhereMessage(rootPath: string, hostName: string): string {
  return `${rootPath} is already registered from another bb host (${hostName}). Whiteboard keys checkouts by path, so one path can belong to one host.`;
}

/** The resolver the host-io facades use. Beyond `HostResolver` it learns paths hosts report. */
export interface WhiteboardHostResolver extends HostResolver {
  /**
   * Remember that `rootPath` (and everything under it) lives on `hostId`. The
   * facades call it for paths a host returned, such as a pinned checkout or
   * a shared git dir, so later calls on those paths go back to that host.
   */
  rememberPath(rootPath: string, hostId: string): void;
  /** The host driving this call, ignoring repository bindings (steps 2-4). Registration binds to it. */
  callerHost(): Promise<string>;
}

/** Whether `child` is `parent` or lies under it. */
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The longest key of `paths` that contains `target`. */
function longestOwner<T>(paths: Iterable<[string, T]>, target: string): T | undefined {
  let best: { length: number; value: T } | undefined;
  for (const [root, value] of paths) {
    if (within(root, target) && (!best || root.length > best.length))
      best = { length: root.length, value };
  }
  return best?.value;
}

/**
 * Repository to bb host routing (design §3.1). `hostFor` answers, in order:
 *
 * 1. the `repository_hosts` row: by `repositoryId`, or for a `rootPath` the
 *    registered repository that is or contains it, then a remembered path
 *    a host reported (a pinned checkout under the repository's git dir);
 * 2. the calling thread's environment host, cached on the ThreadContext;
 * 3. the single connected persistent host;
 * 4. otherwise `ReviewInputError(NO_HOST_MESSAGE, 409)`.
 */
export function createHostResolver(bb: BbPluginApi): WhiteboardHostResolver {
  const remembered = new Map<string, string>();
  const db = () => bb.storage.database();

  const boundHost = (target: { repositoryId?: string; rootPath?: string }) => {
    if (target.repositoryId) {
      const row = db()
        .prepare("SELECT host_id AS hostId FROM repository_hosts WHERE repository_id = ?")
        .get(target.repositoryId) as { hostId: string } | undefined;
      if (row) return row.hostId;
    }
    if (target.rootPath) {
      const resolved = path.resolve(target.rootPath);
      const rows = db()
        .prepare(
          "SELECT r.path AS path, h.host_id AS hostId FROM repository_hosts h JOIN repositories r ON r.id = h.repository_id",
        )
        .all() as { path: string; hostId: string }[];
      return (
        longestOwner(
          rows.map((row) => [row.path, row.hostId] as [string, string]),
          resolved,
        ) ?? longestOwner(remembered, resolved)
      );
    }
    return undefined;
  };

  const threadHost = async (): Promise<string | undefined> => {
    const context = currentThread();
    if (!context) return undefined;
    if (context.hostId) return context.hostId;
    try {
      const thread = await bb.sdk.threads.get({ threadId: context.threadId });
      if (!thread.environmentId) return undefined;
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      context.hostId = environment.hostId;
      return environment.hostId;
    } catch {
      return undefined;
    }
  };

  const singleHost = async (): Promise<string | undefined> => {
    const hosts = (await bb.sdk.hosts.list().catch(() => [])).filter(
      (host) => host.type === "persistent" && host.status === "connected",
    );
    return hosts.length === 1 ? hosts[0]!.id : undefined;
  };

  const callerHost = async () => {
    const host = (await threadHost()) ?? (await singleHost());
    if (!host) throw new ReviewInputError(NO_HOST_MESSAGE, 409);
    return host;
  };

  const hostName = async (hostId: string) =>
    (await bb.sdk.hosts.list().catch(() => [])).find((host) => host.id === hostId)?.name ?? hostId;

  return {
    async hostFor(target) {
      return boundHost(target) ?? (await callerHost());
    },
    async bindRepository(repository, hostId) {
      const rootPath = path.resolve(repository.rootPath);
      const existing =
        (
          db()
            .prepare("SELECT host_id AS hostId FROM repository_hosts WHERE repository_id = ?")
            .get(repository.repositoryId) as { hostId: string } | undefined
        )?.hostId ??
        (
          db()
            .prepare(
              "SELECT h.host_id AS hostId FROM repository_hosts h JOIN repositories r ON r.id = h.repository_id WHERE r.path = ?",
            )
            .get(rootPath) as { hostId: string } | undefined
        )?.hostId;
      if (existing === hostId) return;
      if (existing !== undefined)
        throw new ReviewInputError(boundElsewhereMessage(rootPath, await hostName(existing)), 409);
      db()
        .prepare("INSERT INTO repository_hosts(repository_id, host_id) VALUES (?, ?)")
        .run(repository.repositoryId, hostId);
    },
    rememberPath(rootPath, hostId) {
      remembered.set(path.resolve(rootPath), hostId);
    },
    callerHost,
  };
}

export function isWhiteboardHostResolver(
  resolver: HostResolver,
): resolver is WhiteboardHostResolver {
  return typeof (resolver as Partial<WhiteboardHostResolver>).rememberPath === "function";
}
