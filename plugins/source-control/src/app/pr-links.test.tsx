// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { changeKeySchema } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { rememberChange, rememberMiss, resetKnownPullRequests } from "./open-pull-request.tsx";

// The app's own registrations: the script that takes the click, and the segment that lends it a panel.
const app = await loadPluginApp(() => import("./app.tsx"));
const script = app.contentScripts.find((each) => each.id === "pr-links")!;
const segment = app.threadContextSegments.find((each) => each.id === "pr-links")!;

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
