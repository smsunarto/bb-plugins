import { describe, expect, test } from "bun:test";
import {
  PULL_REQUEST_REVIEW_EVENT,
  answerPullRequestReviewAvailability,
  isPlainClick,
  isPullRequestReviewAvailable,
  onPullRequestReviewAvailabilityChange,
  pullRequestUrlKey,
  requestPullRequestReview,
  takePullRequestReviews,
  type PullRequestReviewRequest,
} from "./review-request.ts";

const URL = "https://github.com/acme/app/pull/7";
const ask = { url: URL, threadId: "thr_1", navigating: false } as const;

describe("requestPullRequestReview", () => {
  test("is not taken when nothing listens", () => {
    expect(requestPullRequestReview(ask, new EventTarget())).toBe(false);
  });

  test("is taken when the taker answers true, and the taker reads the request", () => {
    const target = new EventTarget();
    const seen: PullRequestReviewRequest[] = [];
    takePullRequestReviews(
      (request) => (seen.push(request), true),
      new AbortController().signal,
      target,
    );
    expect(requestPullRequestReview(ask, target)).toBe(true);
    expect(seen).toEqual([ask]);
  });

  test("is not taken when the taker answers false", () => {
    const target = new EventTarget();
    takePullRequestReviews(() => false, new AbortController().signal, target);
    expect(requestPullRequestReview(ask, target)).toBe(false);
  });

  test("stops taking once the signal aborts", () => {
    const target = new EventTarget();
    const stop = new AbortController();
    takePullRequestReviews(() => true, stop.signal, target);
    stop.abort();
    expect(requestPullRequestReview(ask, target)).toBe(false);
  });

  test("a navigating request without a fallback is read as one for the thread in view", () => {
    const target = new EventTarget();
    const seen: PullRequestReviewRequest[] = [];
    takePullRequestReviews(
      (request) => (seen.push(request), true),
      new AbortController().signal,
      target,
    );
    requestPullRequestReview({ url: URL, threadId: "thr_1", navigating: true }, target);
    expect(seen).toEqual([{ url: URL, threadId: "thr_1", navigating: false }]);
  });

  test("a navigating request's fallback reaches the taker and runs at most once", () => {
    const target = new EventTarget();
    let taken: PullRequestReviewRequest | null = null;
    takePullRequestReviews(
      (request) => ((taken = request), true),
      new AbortController().signal,
      target,
    );
    let opened = 0;
    expect(
      requestPullRequestReview({ ...ask, navigating: true, fallback: () => opened++ }, target),
    ).toBe(true);
    expect(taken!.navigating).toBe(true);
    taken!.fallback!();
    taken!.fallback!();
    expect(opened).toBe(1);
  });

  test("ignores a malformed request", () => {
    const target = new EventTarget();
    let called = false;
    takePullRequestReviews(() => (called = true), new AbortController().signal, target);
    const event = new CustomEvent(PULL_REQUEST_REVIEW_EVENT, {
      detail: { url: URL },
      cancelable: true,
    });
    expect(target.dispatchEvent(event)).toBe(true);
    expect(called).toBe(false);
  });
});

test("isPlainClick takes only an unmodified primary click", () => {
  const plain = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };
  expect(isPlainClick(plain)).toBe(true);
  expect(isPlainClick({ ...plain, metaKey: true })).toBe(false);
  expect(isPlainClick({ ...plain, ctrlKey: true })).toBe(false);
  expect(isPlainClick({ ...plain, shiftKey: true })).toBe(false);
  expect(isPlainClick({ ...plain, altKey: true })).toBe(false);
  expect(isPlainClick({ ...plain, button: 1 })).toBe(false);
  expect(isPlainClick({ ...plain, defaultPrevented: true })).toBe(false);
});

test("pullRequestUrlKey reads only a pull request's own page", () => {
  expect(pullRequestUrlKey(URL)).toBe("acme/app#7");
  expect(pullRequestUrlKey("https://www.github.com/acme/app/pull/7/")).toBe("acme/app#7");
  expect(pullRequestUrlKey("https://github.com/acme/app/pull/7/files")).toBeNull();
  expect(pullRequestUrlKey("https://github.com/acme/app/pull/7#discussion_r1")).toBeNull();
  expect(pullRequestUrlKey("https://github.com/acme/app/issues/7")).toBeNull();
  expect(pullRequestUrlKey("http://github.com/acme/app/pull/7")).toBeNull();
  expect(pullRequestUrlKey("https://github.com/acme/app/pull/0")).toBeNull();
});

test("availability: unknown without Source Control, its answer while it runs, and its change notices", () => {
  const target = new EventTarget();
  expect(isPullRequestReviewAvailable("thr_1", null, target)).toBe(false);
  const stop = new AbortController();
  let inView = "thr_1";
  const changed = answerPullRequestReviewAvailability(
    (threadId) => threadId === inView,
    stop.signal,
    target,
  );
  let notices = 0;
  onPullRequestReviewAvailabilityChange(() => notices++, stop.signal, target);
  expect(isPullRequestReviewAvailable("thr_1", null, target)).toBe(true);
  expect(isPullRequestReviewAvailable("thr_2", null, target)).toBe(false);
  inView = "thr_2";
  changed();
  expect(notices).toBe(1);
  expect(isPullRequestReviewAvailable("thr_2", null, target)).toBe(true);
  stop.abort();
  expect(isPullRequestReviewAvailable("thr_2", null, target)).toBe(false);
});
