import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { OpenPanel, WhiteboardSettings } from "../../shared/contracts/engine.ts";
import { ReviewInputError } from "../../shared/vendor/review/src/review-api/input-error.ts";
import type { Realtime } from "./realtime.ts";
import { recordSessionThread, tabTitle, upsertSessionTab } from "./session-tabs.ts";
import { currentThread } from "./thread-context.ts";

/**
 * The `open` callback `createReviewApi` receives (design §3.6):
 * 1. no calling thread → upstream's "The desktop is not connected." (409);
 * 2. append or retitle the durable plugin-panel tab on that thread;
 * 3. record `session_threads`, so later renames and removals follow the tab;
 * 4. publish `whiteboard:open`, so clients showing the thread focus the tab.
 * A failed tab write throws a 409 carrying its reason, as upstream Desktop's
 * `openApiReview` relay does (`desktop-server.ts`), so `session_open` shows
 * the cause and `openCreated` reports it as `openError`.
 */
export function createOpenPanel(deps: {
  bb: BbPluginApi;
  settings: WhiteboardSettings;
  realtime: Realtime;
}): OpenPanel {
  const { bb, settings, realtime } = deps;
  return async ({ reviewId, title }) => {
    const thread = currentThread();
    if (!thread) throw new ReviewInputError("The desktop is not connected.", 409);
    try {
      await upsertSessionTab(bb, thread.threadId, reviewId, title);
    } catch (error) {
      throw new ReviewInputError(error instanceof Error ? error.message : String(error), 409);
    }
    recordSessionThread(bb, reviewId, thread.threadId);
    realtime.open({
      threadId: thread.threadId,
      sessionId: reviewId,
      title: tabTitle(title),
      nonce: randomUUID(),
    });
    return { softwareMapEnabled: settings.softwareMapEnabled() };
  };
}
