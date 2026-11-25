// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import type { ExperimentalPanelController, PluginRpcClient } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import {
  PullRequestLink,
  rememberChange,
  rememberMiss,
  resetKnownPullRequests,
  resolvePullRequest,
} from "./open-pull-request.tsx";

const PR = "https://github.com/Acme/API/pull/12";
const LOOKUP = "pr:acme/api#12";
const KEY = changeKeySchema.parse("gh:acme/api:scott:scott/route");

/** The clicks that reached the browser's own handling: a new tab to GitHub. */
let browser: string[];
const toBrowser = (event: MouseEvent) => {
  if (!event.defaultPrevented) browser.push((event.target as HTMLAnchorElement).href);
  event.preventDefault(); // jsdom cannot navigate
};

beforeEach(() => {
  browser = [];
  document.addEventListener("click", toBrowser);
});

afterEach(() => {
  document.removeEventListener("click", toBrowser);
  cleanup();
  resetKnownPullRequests();
});

function render(
  href: string,
  panel: Partial<ExperimentalPanelController> = { openTab: () => true },
) {
  return renderSlot(
    { component: PullRequestLink as never },
    { threadId: "thread-a", href, target: "_blank", children: "#12" } as never,
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      experimental_panel: panel,
    },
  );
}

test("a plain click opens a Review tab for the pull request at once, without waiting on GitHub", () => {
  const slot = render(PR);
  fireEvent.click(slot.getByRole("link", { name: "#12" }));
  expect(slot.inspection.experimental_panelCalls).toEqual([
    {
      method: "openTab",
      options: {
        tab: { id: "review", context: { kind: "thread" }, availability: "action" },
        params: { pr: "acme/api#12" },
        title: "#12 · Review",
      },
    },
  ]);
  expect(browser).toEqual([]);
});

test("a warm mapping still opens the PR-specific tab for validation", () => {
  rememberChange(LOOKUP, KEY, "thread-a");
  const slot = render(PR);
  fireEvent.click(slot.getByRole("link", { name: "#12" }));
  expect(slot.inspection.experimental_panelCalls).toEqual([
    {
      method: "openTab",
      options: {
        tab: { id: "review", context: { kind: "thread" }, availability: "action" },
        params: { pr: "acme/api#12" },
        title: "#12 · Review",
      },
    },
  ]);
});

test("a pull request Source Control just failed to show opens on GitHub inside the click", () => {
  rememberMiss(LOOKUP, "thread-a", "No access.");
  const slot = render(PR);
  fireEvent.click(slot.getByRole("link", { name: "#12" }));
  expect(browser).toEqual([PR]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("with no side panel, the link opens on GitHub inside the click", () => {
  const slot = render(PR, { openTab: () => false });
  fireEvent.click(slot.getByRole("link", { name: "#12" }));
  expect(browser).toEqual([PR]);
});

test("modified, middle and alt clicks are the browser's", () => {
  const slot = render(PR);
  const link = slot.getByRole("link", { name: "#12" });
  for (const modifier of [
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ])
    fireEvent.click(link, modifier);
  expect(browser).toHaveLength(5);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("a deep link into a pull request opens on GitHub", () => {
  const deep = `${PR}#issuecomment-1`;
  const slot = render(deep);
  fireEvent.click(slot.getByRole("link", { name: "#12" }));
  expect(browser).toEqual([deep]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

function rpc(answer: () => Promise<unknown>) {
  const calls: unknown[] = [];
  const client = {
    call: (method: string, input: unknown) => {
      calls.push({ method, input });
      return answer();
    },
  } as unknown as PluginRpcClient<typeof sourceControlContract>;
  return { client, calls };
}

test("asking for one pull request twice reads it once, from the asking thread's host", async () => {
  const { client, calls } = rpc(async () => ({ [LOOKUP]: { key: KEY, problem: null } }));
  const [first, second] = await Promise.all([
    resolvePullRequest(client, LOOKUP, "thread-a"),
    resolvePullRequest(client, LOOKUP, "thread-a"),
  ]);
  expect(first).toEqual({ key: KEY });
  expect(second).toEqual({ key: KEY });
  expect(calls).toEqual([
    { method: "legacyChange", input: { keys: [LOOKUP], threadId: "thread-a" } },
  ]);
});

test("a lookup on another thread can use its own host while the first is still pending", async () => {
  let firstAnswer: (value: unknown) => void = () => {};
  const { client: firstClient } = rpc(
    () =>
      new Promise((resolve) => {
        firstAnswer = resolve;
      }),
  );
  const { client: secondClient } = rpc(async () => ({ [LOOKUP]: { key: KEY, problem: null } }));
  const first = resolvePullRequest(firstClient, LOOKUP, "thread-a");
  const second = resolvePullRequest(secondClient, LOOKUP, "thread-b");
  firstAnswer({ [LOOKUP]: { key: null, problem: "No access on host A." } });
  expect(await first).toEqual({ problem: "No access on host A." });
  expect(await second).toEqual({ key: KEY });
});
