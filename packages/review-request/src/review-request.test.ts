import { describe, expect, test } from "bun:test";
import {
  PULL_REQUEST_REVIEW_EVENT,
  isPlainClick,
  requestPullRequestReview,
  takePullRequestReviews,
  type PullRequestReviewRequest,
} from "./review-request.ts";

const URL = "https://github.com/acme/app/pull/7";
const ask = { url: URL, threadId: "thr_1", navigating: true } as const;

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
