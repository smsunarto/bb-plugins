// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { changeKeySchema } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import {
  REVIEW_REQUEST_ATTRIBUTE,
  isPullRequestReviewAvailable,
  onPullRequestReviewAvailabilityChange,
  pullRequestUrlKey,
  requestPullRequestReview,
} from "@bb-plugins/review-request";
import { rememberChange, rememberMiss, resetKnownPullRequests } from "./open-pull-request.tsx";
import { parsePrLink, prKey } from "../core/watch.ts";
import { PENDING_MS } from "./pr-links.ts";

// The app's own registrations: the script that takes the click, and the segment that lends it a panel.
const app = await loadPluginApp(() => import("./app.tsx"));
const script = app.contentScripts.find((each) => each.id === "pr-links")!;
const segment = app.threadContextSegments.find((each) => each.id === "change")!;

const PR = "https://github.com/acme/api/pull/12";
const KEY = changeKeySchema.parse("gh:acme/api:scott:scott/route");

let stop: AbortController;
/** The clicks the script let through to bb's own handler below the document. */
let reachedBb: string[];

beforeEach(async () => {
  stop = new AbortController();
  reachedBb = [];
  await script.mount({
    pluginId: "source-control",
    generation: 1,
    signal: stop.signal,
  } as PluginContentScriptContext);
});

afterEach(() => {
  stop.abort();
  cleanup();
  document.body.replaceChildren();
  resetKnownPullRequests();
  vi.useRealTimers();
});

function Pane({ threadId }: { threadId: string }) {
  const visible = segment.useVisible!({ threadId, projectId: "p", environment: null });
  return visible ? <span>shown</span> : null;
}

/** `threadId`'s pane, with the route on `routeThread`. */
function pane(routeThread: string | null = "thr_a", openTab = () => true, threadId = routeThread) {
  return renderSlot({ component: Pane as never }, { threadId } as never, {
    experimental_rpcContract: sourceControlContract,
    pluginId: "source-control",
    context: { threadId: routeThread },
    experimental_panel: { openTab },
  });
}

/** A link as bb's Markdown draws one: its own click handler opens the URL and prevents the default. */
function markdownLink(href: string, inside?: HTMLElement): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.textContent = href;
  anchor.addEventListener("click", (event) => {
    reachedBb.push(href);
    event.preventDefault();
  });
  (inside ?? document.body).append(anchor);
  return anchor;
}

test("a plain click on a message's pull request link opens a Review tab for it beside the thread", () => {
  const slot = pane();
  expect(slot.queryByText("shown")).toBeNull();
  fireEvent.click(markdownLink(PR));
  expect(reachedBb).toEqual([]);
  expect(slot.inspection.experimental_panelCalls).toEqual([
    {
      method: "openTab",
      options: {
        tab: { id: "review", context: { kind: "thread" }, availability: "action" },
        params: { pr: "acme/api#12" },
        title: "Review · #12",
      },
    },
  ]);
});

test("a pull request this window has opened opens its Change's tab at once", () => {
  rememberChange("pr:acme/api#12", KEY);
  const slot = pane();
  fireEvent.click(markdownLink(PR));
  expect(slot.inspection.experimental_panelCalls).toMatchObject([
    { method: "openTab", options: { params: { key: KEY } } },
  ]);
});

test("a pull request Source Control just failed to show goes straight to GitHub", () => {
  rememberMiss("pr:acme/api#12", "No access.");
  const slot = pane();
  fireEvent.click(markdownLink(PR));
  expect(reachedBb).toEqual([PR]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("modified, middle and alt clicks, deep links and other links reach bb as before", () => {
  const slot = pane();
  const link = markdownLink(PR);
  fireEvent.click(link, { metaKey: true });
  fireEvent.click(link, { ctrlKey: true });
  fireEvent.click(link, { shiftKey: true });
  fireEvent.click(link, { altKey: true });
  fireEvent.click(link, { button: 1 });
  fireEvent.click(markdownLink(`${PR}/files`));
  fireEvent.click(markdownLink("https://github.com/acme/api/issues/12"));
  expect(reachedBb).toHaveLength(7);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("Source Control's own links are its own: an explicit Open on GitHub still reaches GitHub", () => {
  const slot = pane();
  const root = document.createElement("div");
  root.dataset["bbPlugin"] = "source-control";
  document.body.append(root);
  fireEvent.click(markdownLink(PR, root));
  expect(reachedBb).toEqual([PR]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("where the thread has no side panel, the link goes to GitHub", () => {
  pane("thr_a", () => false);
  fireEvent.click(markdownLink(PR));
  expect(reachedBb).toEqual([PR]);
});

test("a pane whose thread the route does not show takes no click", () => {
  const slot = pane("thr_other", () => true, "thr_a");
  fireEvent.click(markdownLink(PR));
  expect(reachedBb).toEqual([PR]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("once the thread's pane is gone, its links go to GitHub", () => {
  pane().unmount();
  fireEvent.click(markdownLink(PR));
  expect(reachedBb).toEqual([PR]);
});

test("once the script stops, every click reaches bb", () => {
  const slot = pane();
  stop.abort();
  fireEvent.click(markdownLink(PR));
  expect(reachedBb).toEqual([PR]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

// ── Other plugins' asks (Tasks' PR pill, GenUI's buttons) ─────────────
// Each test joins the real asker (`requestPullRequestReview`) to the real
// taker (this app's content script and pane). A click always opens
// something: the Review, or GitHub through the caller's fallback.

const OPENS_PR_TAB = [{ method: "openTab", options: { params: { pr: "acme/api#12" } } }];

/** A caller that opens the thread itself, as Tasks' pill does, counting its GitHub fallbacks. */
function opener(threadId = "thr_a") {
  const github: string[] = [];
  const taken = requestPullRequestReview({
    url: PR,
    threadId,
    navigating: true,
    fallback: () => github.push(PR),
  });
  return { taken, github };
}

test("an ask for the thread in view opens its Review at once", () => {
  const slot = pane();
  expect(requestPullRequestReview({ url: PR, threadId: "thr_a", navigating: false })).toBe(true);
  expect(slot.inspection.experimental_panelCalls).toMatchObject(OPENS_PR_TAB);
});

test("an ask from a caller that opens the thread is taken, and opens once the thread is in view", () => {
  const ask = opener();
  expect(ask.taken).toBe(true);
  const slot = pane();
  expect(slot.inspection.experimental_panelCalls).toMatchObject(OPENS_PR_TAB);
  expect(ask.github).toEqual([]);
});

test("a taken ask whose pane declines the tab falls back to GitHub", () => {
  const ask = opener();
  expect(ask.taken).toBe(true);
  pane("thr_a", () => false);
  expect(ask.github).toEqual([PR]);
});

test("a taken ask whose thread never shows falls back to GitHub, and a late pane opens nothing", () => {
  vi.useFakeTimers();
  const ask = opener();
  vi.advanceTimersByTime(PENDING_MS - 1);
  expect(ask.github).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(ask.github).toEqual([PR]);
  const slot = pane();
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
  expect(ask.github).toEqual([PR]);
});

test("a waiting ask opens once: the thread's next visit opens nothing", () => {
  vi.useFakeTimers();
  const ask = opener();
  pane().unmount();
  const again = pane();
  vi.advanceTimersByTime(PENDING_MS);
  expect(again.inspection.experimental_panelCalls).toEqual([]);
  expect(ask.github).toEqual([]);
});

test("the latest ask wins: an earlier thread's pane opens nothing and leaves the latest waiting", () => {
  vi.useFakeTimers();
  const first = opener("thr_a");
  const second = opener("thr_b");
  // thr_a's pane shows late, from the first click: the reader has since asked for thr_b.
  const early = pane("thr_a");
  expect(early.inspection.experimental_panelCalls).toEqual([]);
  early.unmount();
  const latest = pane("thr_b");
  expect(latest.inspection.experimental_panelCalls).toMatchObject(OPENS_PR_TAB);
  vi.advanceTimersByTime(PENDING_MS);
  expect(first.github).toEqual([]);
  expect(second.github).toEqual([]);
});

test("a cached pull request whose pane declines the tab falls back like any other", () => {
  rememberChange("pr:acme/api#12", KEY);
  const ask = opener();
  expect(ask.taken).toBe(true);
  const slot = pane("thr_a", () => false);
  expect(ask.github).toEqual([PR]);
  // Not the review page: the caller offers GitHub.
  expect(slot.inspection.navigateCalls).toEqual([]);
});

test("callers can ask whether Review opens beside a thread now, and hear when that changes", () => {
  const changes = vi.fn();
  const listening = new AbortController();
  onPullRequestReviewAvailabilityChange(changes, listening.signal);
  expect(isPullRequestReviewAvailable("thr_a")).toBe(false);
  const slot = pane();
  expect(isPullRequestReviewAvailable("thr_a")).toBe(true);
  expect(isPullRequestReviewAvailable("thr_b")).toBe(false);
  slot.unmount();
  expect(isPullRequestReviewAvailable("thr_a")).toBe(false);
  expect(changes).toHaveBeenCalledTimes(2);
  listening.abort();
});

test("an ask without a fallback, or that will not open its thread, is taken only for the thread in view", () => {
  const slot = pane();
  expect(requestPullRequestReview({ url: PR, threadId: "thr_b", navigating: false })).toBe(false);
  expect(requestPullRequestReview({ url: PR, threadId: "thr_b", navigating: true })).toBe(false);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("an ask for another thread the caller opens waits for that thread, not the one in view", () => {
  const slot = pane();
  expect(opener("thr_b").taken).toBe(true);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("asks Source Control cannot take go to GitHub: no pull request, a recent miss, no side panel", () => {
  const files = requestPullRequestReview({
    url: `${PR}/files`,
    threadId: "thr_a",
    navigating: true,
    fallback: () => {},
  });
  expect(files).toBe(false);
  rememberMiss("pr:acme/api#12", "No access.");
  expect(opener().taken).toBe(false);
  resetKnownPullRequests();
  pane("thr_a", () => false);
  expect(opener().taken).toBe(false);
});

test("a link that asks for its own review is left to its owner", () => {
  const slot = pane();
  // As Tasks draws its pill: the attribute on the anchor itself.
  const link = markdownLink(PR);
  link.setAttribute(REVIEW_REQUEST_ATTRIBUTE, "");
  fireEvent.click(link);
  expect(reachedBb).toEqual([PR]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("once the script stops, a waiting ask falls back to GitHub and no new ask is taken", () => {
  const ask = opener();
  pane("thr_b");
  expect(isPullRequestReviewAvailable("thr_b")).toBe(true);
  stop.abort();
  expect(isPullRequestReviewAvailable("thr_b")).toBe(false);
  expect(ask.github).toEqual([PR]);
  expect(opener().taken).toBe(false);
  const slot = pane();
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("callers and Source Control agree on which links are a pull request itself", () => {
  for (const url of [
    PR,
    `${PR}/`,
    "https://www.github.com/acme/api/pull/12",
    `${PR}/files`,
    `${PR}#issuecomment-1`,
    `${PR}?w=1`,
    "https://github.com/acme/api/issues/12",
    "http://github.com/acme/api/pull/12",
    "https://github.com/acme/api/pull/0",
    "https://gitlab.com/acme/api/pull/12",
  ]) {
    const ref = parsePrLink(url);
    expect(pullRequestUrlKey(url), url).toBe(ref ? prKey(ref) : null);
  }
});

test("routing adds no invisible context segment", () => {
  expect(app.threadContextSegments.map((item) => item.id)).toEqual(["change"]);
});
