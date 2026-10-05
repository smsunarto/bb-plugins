import type { OpenPanel, WhiteboardSettings } from "../../shared/contracts/engine.ts";
import { ReviewInputError } from "../../shared/vendor/review/src/review-api/input-error.ts";
import type { Realtime } from "./realtime.ts";
import { type SessionTabs, tabTitle } from "./session-tabs.ts";
import { currentThread } from "./thread-context.ts";

export const NO_THREAD_MESSAGE =
  "Whiteboard opens sessions in a bb thread. Call this from an agent thread, or open it from Whiteboard in the sidebar.";

/**
 * The `open` callback `createReviewApi` receives (design §3.6):
 * 1. no calling thread → `NO_THREAD_MESSAGE` (409), where upstream says
 *    "The desktop is not connected.";
 * 2. `openTab` appends or retitles the durable plugin-panel tab on that
 *    thread, records it, and keeps the open for a client that shows the
 *    thread later (`claimOpen`). It answers the open's `at`;
 * 3. publish `whiteboard:open` with that `at`, so clients showing the thread
 *    focus the tab.
 * A failed tab write throws a 409 carrying its reason, as upstream Desktop's
 * `openApiReview` relay does (`desktop-server.ts`), so `session_open` shows
 * the cause and `openCreated` reports it as `openError`.
 */
export function createOpenPanel(deps: {
  settings: WhiteboardSettings;
  realtime: Realtime;
  openTab: SessionTabs["open"];
}): OpenPanel {
  const { settings, realtime, openTab } = deps;
  return async ({ reviewId, title }) => {
    const thread = currentThread();
    if (!thread) throw new ReviewInputError(NO_THREAD_MESSAGE, 409);
    let at: number;
    try {
      at = await openTab(thread.threadId, reviewId, title);
    } catch (error) {
      throw new ReviewInputError(error instanceof Error ? error.message : String(error), 409);
    }
    realtime.open({ threadId: thread.threadId, sessionId: reviewId, title: tabTitle(title), at });
    return { softwareMapEnabled: settings.softwareMapEnabled() };
  };
}
