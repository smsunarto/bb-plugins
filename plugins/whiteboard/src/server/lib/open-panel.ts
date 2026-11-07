import type { OpenPanel, WhiteboardSettings } from "../../shared/contracts/engine.ts";
import { ReviewInputError } from "../../shared/review/input-error.ts";
import type { SessionTabs } from "./session-tabs.ts";
import { currentThread } from "./thread-context.ts";

export const NO_THREAD_MESSAGE =
  "Whiteboard opens sessions in a bb thread. Call this from an agent thread, or open it from Whiteboard in the sidebar.";

/**
 * The `open` callback `createReviewApi` receives (design §3.6):
 * 1. no calling thread → `NO_THREAD_MESSAGE` (409), where upstream says
 *    "The desktop is not connected.";
 * 2. `openTab` appends or retitles the durable plugin-panel tab on that
 *    thread and records it. The tab is not focused: the user opens it with
 *    the thread header's Open Whiteboard button.
 * A failed tab write throws a 409 carrying its reason, as upstream Desktop's
 * `openApiReview` relay does (`desktop-server.ts`), so `session_open` shows
 * the cause and `openCreated` reports it as `openError`.
 */
export function createOpenPanel(deps: {
  settings: WhiteboardSettings;
  openTab: SessionTabs["open"];
}): OpenPanel {
  const { settings, openTab } = deps;
  return async ({ reviewId, title }) => {
    const thread = currentThread();
    if (!thread) throw new ReviewInputError(NO_THREAD_MESSAGE, 409);
    try {
      await openTab(thread.threadId, reviewId, title);
    } catch (error) {
      throw new ReviewInputError(error instanceof Error ? error.message : String(error), 409);
    }
    return { softwareMapEnabled: settings.softwareMapEnabled() };
  };
}
