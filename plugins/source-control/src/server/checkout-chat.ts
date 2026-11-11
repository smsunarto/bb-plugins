/**
 * Where to open another checkout of the repository: a visible thread in that
 * checkout's ready bb environment, for Open checkout, and the environment
 * itself, for a new chat there. Ported from gitbutler
 * (`src/server/rpc/checkout-chat-target.ts`), finding the environment through
 * the placement table instead of walking the host's environments.
 *
 * Read on click only: each answer can change any time before the click, and
 * it starts, adopts and claims nothing.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store.ts";

type Answer =
  | {
      state: "ready";
      projectId: string;
      environmentId: string;
      hostId: string;
      threadId: string;
    }
  | { state: "unavailable"; reason: string };

/** Native reuse choices come from visible, unarchived sidebar threads, so one must exist. */
const THREAD_PAGE = 20;

const unavailable = (reason: string): Answer => ({ state: "unavailable", reason });

export function createCheckoutChat(deps: { bb: BbPluginApi; store: Store }) {
  const { bb, store } = deps;
  return async ({ hostId, path }: { hostId: string; path: string }): Promise<Answer> => {
    const placement = store
      .checkouts()
      .find((each) => each.hostId === hostId && each.path === path);
    if (!placement) return unavailable("bb no longer has a thread on this checkout.");
    const host = await bb.sdk.hosts.get({ hostId });
    if (host.status !== "connected" || host.lifecycle.phase !== "active")
      return unavailable(`${host.name} must be connected before opening this checkout.`);
    const environment = await bb.sdk.environments.get({
      environmentId: placement.environmentId,
    });
    if (
      environment.hostId !== hostId ||
      environment.path === null ||
      environment.status !== "ready" ||
      environment.lifecycle.phase !== "active" ||
      environment.hostLifecycle !== "active"
    )
      return unavailable("This checkout's bb environment is not ready.");
    const threads = await bb.sdk.threads.list({
      projectId: environment.projectId,
      environmentId: environment.id,
      archived: false,
      includeHidden: false,
      limit: THREAD_PAGE,
    });
    const thread = threads.find(
      (each) =>
        each.environmentId === environment.id &&
        each.archivedAt === null &&
        each.deletedAt === null &&
        each.visibility === "visible",
    );
    if (!thread)
      return unavailable("This checkout needs a visible, unarchived thread before opening it.");
    return {
      state: "ready",
      projectId: environment.projectId,
      environmentId: environment.id,
      hostId,
      threadId: thread.id,
    };
  };
}
