// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { changeKeySchema } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { REVIEW_REQUEST_ATTRIBUTE, requestPullRequestReview } from "@bb-plugins/review-request";
import { rememberChange, rememberMiss, resetKnownPullRequests } from "./open-pull-request.tsx";
import { PENDING_MS, resetPullRequestLinks, takeReviewRequest } from "./pr-links.ts";

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
  resetPullRequestLinks();
});

function Pane({ threadId }: { threadId: string }) {
  const visible = segment.useVisible!({ threadId, projectId: "p", environment: null });
  return visible ? <span>shown</span> : null;
}

/** A thread pane, with the route on `routeThread`. */
function pane(routeThread: string | null = "thr_a", openTab = () => true) {
  return renderSlot({ component: Pane as never }, { threadId: "thr_a" } as never, {
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
  const slot = pane("thr_other");
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

const OPENS_PR_TAB = [{ method: "openTab", options: { params: { pr: "acme/api#12" } } }];

test("an ask for the thread in view opens its Review at once", () => {
  const slot = pane();
  expect(requestPullRequestReview({ url: PR, threadId: "thr_a", navigating: false })).toBe(true);
  expect(slot.inspection.experimental_panelCalls).toMatchObject(OPENS_PR_TAB);
});

test("an ask from a caller that opens the thread is taken, and opens once the thread is in view", () => {
  expect(requestPullRequestReview({ url: PR, threadId: "thr_a", navigating: true })).toBe(true);
  const slot = pane();
  expect(slot.inspection.experimental_panelCalls).toMatchObject(OPENS_PR_TAB);
});

test("a waiting ask opens once: the thread's next visit opens nothing", () => {
  requestPullRequestReview({ url: PR, threadId: "thr_a", navigating: true });
  pane().unmount();
  const again = pane();
  expect(again.inspection.experimental_panelCalls).toEqual([]);
});

test("a waiting ask its thread took too long to show is dropped", () => {
  expect(
    takeReviewRequest(
      { url: PR, threadId: "thr_a", navigating: true },
      Date.now() - PENDING_MS - 1,
    ),
  ).toBe(true);
  const slot = pane();
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("an ask for a thread not in view, from a caller that will not open it, goes to GitHub", () => {
  const slot = pane();
  expect(requestPullRequestReview({ url: PR, threadId: "thr_b", navigating: false })).toBe(false);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("an ask for another thread the caller opens waits for that thread, not the one in view", () => {
  const slot = pane();
  expect(requestPullRequestReview({ url: PR, threadId: "thr_b", navigating: true })).toBe(true);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("asks Source Control cannot take go to GitHub: no pull request, a recent miss, no side panel", () => {
  expect(
    requestPullRequestReview({ url: `${PR}/files`, threadId: "thr_a", navigating: true }),
  ).toBe(false);
  rememberMiss("pr:acme/api#12", "No access.");
  expect(requestPullRequestReview({ url: PR, threadId: "thr_a", navigating: true })).toBe(false);
  resetKnownPullRequests();
  pane("thr_a", () => false);
  expect(requestPullRequestReview({ url: PR, threadId: "thr_a", navigating: true })).toBe(false);
});

test("a link that asks for its own review is left to its owner", () => {
  const slot = pane();
  const owner = document.createElement("span");
  owner.setAttribute(REVIEW_REQUEST_ATTRIBUTE, "");
  document.body.append(owner);
  fireEvent.click(markdownLink(PR, owner));
  expect(reachedBb).toEqual([PR]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("once the script stops, no ask is taken and a waiting one is dropped", () => {
  requestPullRequestReview({ url: PR, threadId: "thr_a", navigating: true });
  stop.abort();
  expect(requestPullRequestReview({ url: PR, threadId: "thr_a", navigating: true })).toBe(false);
  const slot = pane();
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("routing adds no invisible context segment", () => {
  expect(app.threadContextSegments.map((item) => item.id)).toEqual(["change"]);
});
