// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { resetKnownPullRequests } from "./open-pull-request.ts";
import { lentThread, mountPullRequestLinks, useLendPullRequestLinks } from "./pr-links.ts";

const PR = "https://github.com/acme/api/pull/12";
const KEY = changeKeySchema.parse("gh:acme/api:scott:scott/route");

let script: AbortController;
/** What reached bb's own handler below the document: the clicks the script let through. */
let reachedBb: string[];

beforeEach(() => {
  script = new AbortController();
  reachedBb = [];
});

afterEach(() => {
  script.abort();
  cleanup();
  document.body.replaceChildren();
  resetKnownPullRequests();
});

function Lender({ threadId }: { threadId: string }) {
  useLendPullRequestLinks(threadId);
  return null;
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

function mount(routeThread: string | null = "thr_a") {
  const slot = renderSlot({ component: Lender as never }, { threadId: "thr_a" } as never, {
    experimental_rpcContract: sourceControlContract,
    pluginId: "source-control",
    context: { threadId: routeThread },
    experimental_panel: { openTab: () => true },
    rpc: { legacyChange: () => ({ "pr:acme/api#12": { key: KEY, problem: null } }) } as never,
  });
  mountPullRequestLinks(document, script.signal);
  return slot;
}

test("a plain click on a pull request link in a message opens its review beside the thread, not bb's handler", async () => {
  const slot = mount();
  fireEvent.click(markdownLink(PR));
  expect(reachedBb).toEqual([]);
  await waitFor(() =>
    expect(slot.inspection.experimental_panelCalls).toMatchObject([
      { method: "openTab", options: { tab: { id: "review" }, params: { key: KEY } } },
    ]),
  );
});

test("modified clicks, deep links and other links reach bb as before", async () => {
  const slot = mount();
  const link = markdownLink(PR);
  fireEvent.click(link, { metaKey: true });
  fireEvent.click(link, { ctrlKey: true });
  fireEvent.click(markdownLink(`${PR}/files`));
  fireEvent.click(markdownLink("https://github.com/acme/api/issues/12"));
  expect(reachedBb).toEqual([PR, PR, `${PR}/files`, "https://github.com/acme/api/issues/12"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("Source Control's own links are its own: an explicit Open on GitHub still reaches GitHub", () => {
  mount();
  const root = document.createElement("div");
  root.dataset["bbPlugin"] = "source-control";
  document.body.append(root);
  fireEvent.click(markdownLink(PR, root));
  expect(reachedBb).toEqual([PR]);
});

test("with no thread in view, nothing is lent and the link goes to GitHub", () => {
  mount(null);
  expect(lentThread()).toBeNull();
  fireEvent.click(markdownLink(PR));
  expect(reachedBb).toEqual([PR]);
});

test("only the thread the route shows lends its opener, and only while mounted", () => {
  const slot = mount("thr_a");
  expect(lentThread()).toBe("thr_a");
  slot.unmount();
  expect(lentThread()).toBeNull();
});

test("once the script stops, every click reaches bb", () => {
  mount();
  script.abort();
  fireEvent.click(markdownLink(PR));
  expect(reachedBb).toEqual([PR]);
});
