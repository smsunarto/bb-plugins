import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import type { Subthread } from "../../shared/schema.ts";
import { MOVED, writeTarget } from "./target.ts";

/**
 * The subthreads the panel hands work to: Create PR and Resolve conflicts.
 * Each is a visible child of the reader's thread on the same environment, so
 * it runs `but` on the same workspace and the reader can watch and answer it.
 */

const RUNNING = new Set(["pending", "starting", "active", "stopping"]);

/**
 * A repository on a host: where a subthread runs `but`, what it is called,
 * and the environment it was found in, which a subthread must start on.
 */
export type LocatedRepository = {
  hostId: string;
  environmentId: string;
  key: string;
  path: string;
};

/**
 * The repository the panel means, resolved by the host the same way every
 * other call is. An omitted key is the panel's default repository, so the
 * subthread gets that repository's path rather than no path at all.
 */
export async function locateRepository(
  bb: BbPluginApi,
  threadId: string,
  repositoryKey: string | undefined,
  /** For a write: the environment of the board the reader acted on. */
  environmentId?: string,
): Promise<LocatedRepository> {
  const target = await writeTarget(bb, threadId, environmentId);
  const repository = await bb.hosts
    .experimental_client({ contract: gitbutlerHostContract })
    .call(
      "repository",
      { environmentPath: target.environmentPath, ...(repositoryKey ? { repositoryKey } : {}) },
      { hostId: target.hostId },
    );
  return { hostId: target.hostId, environmentId: target.environmentId, ...repository };
}

/**
 * A child as the panel shows it, or null once it is deleted, or archived and
 * stopped. bb
 * answers a deleted thread with a 404. Any other failure may pass, so it is
 * thrown rather than read as gone: that would let a second subthread start
 * beside one still at work.
 */
export async function liveSubthread(bb: BbPluginApi, threadId: string): Promise<Subthread | null> {
  const child = await bb.sdk.threads.get({ threadId }).catch((error: unknown) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (!child || child.deletedAt !== null) return null;
  // A message waiting in its queue is work it will still do.
  const running = RUNNING.has(child.status) || child.queuedMessageCount > 0;
  // bb lets an archived thread finish its turn while the archive can be
  // undone, so it is gone only once it stops.
  if (child.archivedAt !== null && !running) return null;
  return { threadId, running };
}

/** The SDK's `BbHttpError` carries the HTTP status. The plugin SDK does not export the class. */
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

/**
 * Starts a child of `parentId`, with its provider, on the environment
 * `repository` was found in. A parent that moved since is refused: the
 * prompt names a path in the old environment.
 */
export async function spawnSubthread(
  bb: BbPluginApi,
  parentId: string,
  repository: LocatedRepository,
  { title, prompt }: { title: string; prompt: string },
): Promise<string> {
  const parent = await bb.sdk.threads.get({ threadId: parentId });
  if (parent.environmentId !== repository.environmentId) throw new Error(MOVED);
  const child = await bb.sdk.threads.spawn({
    projectId: parent.projectId,
    environment: { type: "reuse", environmentId: repository.environmentId },
    providerId: parent.providerId,
    parentThreadId: parentId,
    title,
    prompt,
  });
  return child.id;
}
