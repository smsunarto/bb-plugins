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

function readRequest(detail: unknown): PullRequestReviewRequest | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { url, threadId, navigating } = detail as Record<string, unknown>;
  if (typeof url !== "string" || typeof threadId !== "string" || threadId === "") return null;
  return { url, threadId, navigating: navigating === true };
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
