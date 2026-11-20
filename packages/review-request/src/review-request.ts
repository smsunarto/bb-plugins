/**
 * Asking Source Control, from another plugin, to open a pull request's
 * Review tab.
 *
 * The Plugin SDK cannot open another plugin's side-panel tab, so plugins
 * that show a pull request (Tasks' PR pill, GenUI's link buttons) ask on the
 * window with a cancelable event, and Source Control's content script takes
 * the ask by cancelling it inside the dispatch. The answer is therefore
 * known inside the click: when nothing takes it (Source Control is disabled
 * or not installed, or cannot show that pull request) the caller opens
 * GitHub as before, so no click is lost to a popup blocker.
 *
 * A click always opens something. Source Control takes an ask only when it
 * can open the Review now, or, for a caller that is bringing the thread into
 * view, when it can call the caller's `fallback` if the Review never opens:
 * the thread's pane does not show in time, declines the tab, or the ask is
 * dropped. A request without a fallback is taken only for the thread in view.
 * The fallback runs after the click, when a browser no longer lets a page
 * open a window, so it offers GitHub (a toast with an action) rather than
 * opening it.
 *
 * Callers that describe a control before it is pressed (GenUI's hints) ask
 * whether Review can open beside a thread now (`isPullRequestReviewAvailable`)
 * and re-ask when Source Control reports a change
 * (`onPullRequestReviewAvailabilityChange`).
 */

/** The window event a request travels as. */
export const PULL_REQUEST_REVIEW_EVENT = "bb-plugins:open-pull-request-review";

/**
 * Put on a pull request link whose owner sends its own request, so Source
 * Control's message-link handler leaves the click to it.
 */
export const REVIEW_REQUEST_ATTRIBUTE = "data-bb-review-request";

export type PullRequestReviewRequest = {
  /** The pull request's own page, `https://github.com/<owner>/<repo>/pull/<n>`. */
  readonly url: string;
  /** The thread the Review opens beside. */
  readonly threadId: string;
  /**
   * The caller brings `threadId` into view right after a taken request (Tasks
   * opens the thread), so Source Control may open the Review once it shows.
   * Without it, Source Control takes the request only while that thread is
   * in view.
   */
  readonly navigating: boolean;
  /**
   * Offers the pull request on GitHub, such as a toast whose action opens
   * it. Required with `navigating`: Source Control calls it, at most once
   * and after the click, when a taken request cannot open the Review after
   * all. It must not open a window itself: the click's activation is gone.
   */
  readonly fallback?: () => void;
};

/**
 * Asks Source Control to open the pull request's Review. True when it took
 * the request: the caller must not open GitHub. False when nothing took it:
 * open the link as before.
 */
export function requestPullRequestReview(
  request: PullRequestReviewRequest,
  target: EventTarget = window,
): boolean {
  const event = new CustomEvent<PullRequestReviewRequest>(PULL_REQUEST_REVIEW_EVENT, {
    detail: Object.freeze({ ...request }),
    cancelable: true,
  });
  return !target.dispatchEvent(event);
}

/**
 * Source Control's side: `take` answers each request inside the dispatch,
 * true for one it will open. Stops when `signal` aborts.
 */
export function takePullRequestReviews(
  take: (request: PullRequestReviewRequest) => boolean,
  signal: AbortSignal,
  target: EventTarget = window,
): void {
  target.addEventListener(
    PULL_REQUEST_REVIEW_EVENT,
    (event) => {
      if (event.defaultPrevented || !(event instanceof CustomEvent)) return;
      const request = readRequest(event.detail);
      if (request && take(request)) event.preventDefault();
    },
    { signal },
  );
}

/** A request as the taker reads it: `navigating` only with a fallback to keep the click's promise. */
function readRequest(detail: unknown): PullRequestReviewRequest | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { url, threadId, navigating, fallback } = detail as Record<string, unknown>;
  if (typeof url !== "string" || typeof threadId !== "string" || threadId === "") return null;
  if (navigating !== true || typeof fallback !== "function") {
    return { url, threadId, navigating: false };
  }
  let called = false;
  const once = () => {
    if (called) return;
    called = true;
    (fallback as () => void)();
  };
  return { url, threadId, navigating: true, fallback: once };
}

export { parsePullRequestUrl, pullRequestUrlKey, type PullRequestUrl } from "./pull-request-url";

// ── Whether Review can open beside a thread now ────────────────────────

/** The window event that asks, cancelled by Source Control when the answer is yes. */
export const REVIEW_AVAILABLE_EVENT = "bb-plugins:pull-request-review-available";
/** The window event Source Control sends when the answer may have changed. */
export const REVIEW_AVAILABILITY_EVENT = "bb-plugins:pull-request-review-availability";

/**
 * Whether Source Control can open a pull request's Review beside `threadId`
 * now: it is running and the thread's pane is in view, and, when `url` is
 * named, it can show that pull request. False when unknown.
 */
export function isPullRequestReviewAvailable(
  threadId: string,
  url: string | null = null,
  target: EventTarget = window,
): boolean {
  const event = new CustomEvent(REVIEW_AVAILABLE_EVENT, {
    detail: { threadId, url },
    cancelable: true,
  });
  return !target.dispatchEvent(event);
}

/** Calls `listener` whenever Source Control reports availability may have changed, until `signal` aborts. */
export function onPullRequestReviewAvailabilityChange(
  listener: () => void,
  signal: AbortSignal,
  target: EventTarget = window,
): void {
  target.addEventListener(REVIEW_AVAILABILITY_EVENT, listener, { signal });
}

/**
 * Source Control's side of availability: `available` answers each ask
 * inside its dispatch, until `signal` aborts. Returns the function to call
 * when the answer may have changed.
 */
export function answerPullRequestReviewAvailability(
  available: (threadId: string, url: string | null) => boolean,
  signal: AbortSignal,
  target: EventTarget = window,
): () => void {
  target.addEventListener(
    REVIEW_AVAILABLE_EVENT,
    (event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { threadId?: unknown; url?: unknown } | null;
      const threadId = detail?.threadId;
      const url = typeof detail?.url === "string" ? detail.url : null;
      if (typeof threadId === "string" && available(threadId, url)) event.preventDefault();
    },
    { signal },
  );
  return () => target.dispatchEvent(new Event(REVIEW_AVAILABILITY_EVENT));
}

type Click = {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly defaultPrevented: boolean;
};

/** A primary click with no modifier: the one a link may take over. Modified and middle clicks stay native. */
export function isPlainClick(event: Click): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
