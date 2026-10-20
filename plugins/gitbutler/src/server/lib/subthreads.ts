import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  CheckoutIdentity,
  CheckoutSelection,
  ObservedCheckout,
  Subthread,
} from "../../shared/schema.ts";
import { assertCheckoutIdle, inCheckout } from "./checkout-ownership.ts";
import {
  hostClient,
  locationOf,
  MOVED,
  repositoryTarget,
  resolveTarget,
  writeTarget,
} from "./target.ts";

/**
 * The subthreads the panel hands work to: Create PR and Resolve conflicts.
 * Each is visible beneath the reader's thread. Main checkouts reuse its
 * environment; selected checkouts get their own exact host and repository path.
 */

const RUNNING = new Set(["pending", "starting", "active", "stopping"]);

/**
 * A repository on a host: where a subthread runs its checkout's Git driver,
 * and the environment it was found in, which a subthread must start on.
 */
export type LocatedRepository = {
  hostId: string;
  environmentId: string;
  key: string;
  path: string;
  checkout?: CheckoutSelection;
  repositoryKey?: string;
  identity?: CheckoutIdentity;
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
  checkout?: CheckoutSelection,
  observed?: ObservedCheckout,
  requireObserved = false,
): Promise<LocatedRepository> {
  const target = await writeTarget(bb, threadId, environmentId, checkout, repositoryKey);
  const { key, identity } = await hostClient(bb).call(
    "checkoutIdentity",
    repositoryTarget(target, repositoryKey),
    { hostId: target.hostId },
  );
  if (requireObserved && identity.kind === "git" && !observed) {
    throw new Error("Refresh this checkout before starting work so its branch and tip are known.");
  }
  if (
    observed &&
    (observed.branch !== identity.branch ||
      observed.head !== identity.head ||
      observed.origin !== identity.origin)
  ) {
    throw new Error("This checkout changed since the board was read. Refresh and try again.");
  }
  return {
    hostId: target.hostId,
    environmentId: target.environmentId,
    key,
    path: identity.path,
    ...(checkout ? { checkout } : {}),
    repositoryKey,
    identity,
  };
}

/**
 * The repository a read of subthread records means, without a host call
 * once it is known. Writes use {@link locateRepository}, which reads the
 * checkout again and pins the thread's environment.
 */
export async function locateForRead(
  bb: BbPluginApi,
  threadId: string,
  repositoryKey: string | undefined,
  checkout?: CheckoutSelection,
): Promise<LocatedRepository> {
  const { target, reason } = await resolveTarget(bb, threadId, checkout, repositoryKey);
  if (!target) throw new Error(reason);
  const { key, path } = await locationOf(bb, target, repositoryKey);
  return {
    hostId: target.hostId,
    environmentId: target.environmentId,
    key,
    path,
    ...(checkout ? { checkout } : {}),
    repositoryKey,
  };
}

/** Native child commands need the same observed-state and applied-branch guards as panel writes. */
export async function prepareCheckoutChild(
  bb: BbPluginApi,
  parentId: string,
  repository: LocatedRepository,
  kind: "review" | "conflicts",
): Promise<void> {
  if (repository.identity?.kind !== "git") return;
  const target = await writeTarget(
    bb,
    parentId,
    repository.environmentId,
    repository.checkout,
    repository.repositoryKey,
  );
  const identity = await hostClient(bb).call(
    "prepareCheckoutChild",
    {
      ...repositoryTarget(target, repository.repositoryKey),
      kind,
      observed: {
        branch: repository.identity.branch,
        head: repository.identity.head,
        origin: repository.identity.origin,
      },
    },
    { hostId: target.hostId },
  );
  if (identity.path !== repository.path || identity.commonDir !== repository.identity.commonDir) {
    throw new Error("This checkout changed since the board was read. Refresh and try again.");
  }
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
  {
    title,
    prompt,
    operation,
  }: { title: string; prompt: string; operation: "review" | "conflicts" },
): Promise<string> {
  const parent = await bb.sdk.threads.get({ threadId: parentId });
  if (parent.environmentId !== repository.environmentId) throw new Error(MOVED);
  const selected =
    repository.checkout || repository.identity?.kind === "git"
      ? await locateRepository(
          bb,
          parentId,
          repository.repositoryKey,
          repository.environmentId,
          repository.checkout,
          repository.identity
            ? {
                branch: repository.identity.branch,
                head: repository.identity.head,
                origin: repository.identity.origin,
              }
            : undefined,
          true,
        )
      : null;
  if (selected && !selected.identity?.branch && operation !== "conflicts") {
    throw new Error("This checkout has no checked-out branch. Refresh and try again.");
  }
  const start = async () => {
    if (selected) {
      await assertCheckoutIdle(bb, parentId, selected);
      await prepareCheckoutChild(bb, parentId, selected, operation);
      await writeTarget(bb, parentId, repository.environmentId);
    }
    const child = await bb.sdk.threads.spawn({
      projectId: parent.projectId,
      environment: selected?.checkout
        ? {
            type: "host",
            hostId: selected.hostId,
            workspace: {
              type: "unmanaged",
              path: selected.path,
              ...(selected.identity?.branch
                ? { branch: { kind: "existing", name: selected.identity.branch } }
                : {}),
            },
          }
        : { type: "reuse", environmentId: repository.environmentId },
      providerId: parent.providerId,
      parentThreadId: parentId,
      title,
      prompt,
    });
    return child.id;
  };
  return selected ? inCheckout(bb, selected, start) : start();
}
