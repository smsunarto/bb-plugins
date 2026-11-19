// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import type { ExperimentalPanelTabs } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema } from "../core/ids.ts";
import type { ChangeDetail, ChangeRow } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { knownPullRequest, resetKnownPullRequests, RESOLVE_MS } from "./open-pull-request.tsx";
import { resetPlaces } from "./open-review.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
const reviewTab = app.tabs.find((tab) => tab.id === "review") as unknown as {
  component: ComponentType<{ threadId: string; environment: null; params: unknown }>;
};

const LOOKUP = "pr:acme/api#12";
const KEY = changeKeySchema.parse("gh:acme/api:scott:scott/route");

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetKnownPullRequests();
  resetPlaces();
});

/** The Review tab a link opened for acme/api#12, as the panel lists it. */
const SELF: ExperimentalPanelTabs = {
  open: true,
  selectedKey: "tab-pr",
  tabs: [
    {
      key: "tab-pr",
      title: "Review · #12",
      status: null,
      closable: true,
      detail: {
        kind: "plugin",
        pluginId: "source-control",
        tab: { id: "review", context: { kind: "thread" }, availability: "action" },
        params: { pr: "acme/api#12" },
      },
    },
  ],
};

function detailShowing(number: number | null): ChangeDetail {
  const row: ChangeRow = {
    key: KEY,
    repo: "acme/api",
    title: "Route links",
    branch: "scott/route",
    baseRef: "main",
    number,
    url: null,
    author: "scott",
    state: "open",
    mine: true,
    asked: false,
    stack: null,
    hostId: null,
    line: "",
    chips: [],
    sort: 0,
    updatedAt: new Date().toISOString(),
  };
  return {
    state: "change",
    row,
    head: "c0ffee",
    files: 1,
    additions: 1,
    deletions: 0,
    revision: null,
    stack: null,
    canMarkReady: false,
    ship: [],
    status: { label: "Open", tone: "open", number, noPullRequest: number === null },
    problem: null,
    at: Date.now(),
  };
}

function render(
  legacyChange: (input: { keys: string[]; threadId?: string }) => unknown,
  shown: number | null = 12,
) {
  const asked: unknown[] = [];
  const slot = renderSlot(
    { component: reviewTab.component as never },
    { threadId: "thread-a", environment: null, params: { pr: "acme/api#12" } } as never,
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      experimental_panel: { openTab: () => true, getTabs: () => SELF, closeTab: () => true },
      rpc: {
        legacyChange: (input: { keys: string[]; threadId?: string }) => {
          asked.push(input);
          return legacyChange(input);
        },
        changeDetail: ({ keys }: { keys: string[] }) =>
          Object.fromEntries(keys.map((key) => [key, detailShowing(shown)])),
      } as never,
    },
  );
  return { slot, asked };
}

const found = () => ({ [LOOKUP]: { key: KEY, problem: null } });

test("the tab says it is looking, then opens the Change's own tab and closes itself", async () => {
  const { slot, asked } = render(found);
  expect(slot.getByRole("status").textContent).toContain("Opening its review");
  await waitFor(() =>
    expect(slot.inspection.experimental_panelCalls).toEqual([
      {
        method: "openTab",
        options: {
          tab: { id: "review", context: { kind: "thread" }, availability: "action" },
          params: { key: KEY },
          title: "Review · scott/route",
        },
      },
      { method: "closeTab", key: "tab-pr" },
    ]),
  );
  expect(asked).toEqual([{ keys: [LOOKUP], threadId: "thread-a" }]);
  expect(knownPullRequest(LOOKUP)).toEqual({ key: KEY });
});

test("a pull request Source Control cannot read says why and offers GitHub, a click away", async () => {
  const { slot } = render(() => ({ [LOOKUP]: { key: null, problem: "gh has no access." } }));
  expect((await slot.findByRole("alert")).textContent).toContain("gh has no access.");
  const github = slot.getByRole("link", { name: "Open #12 on GitHub" });
  expect(github.getAttribute("href")).toBe("https://github.com/acme/api/pull/12");
  expect(knownPullRequest(LOOKUP)).toEqual({ problem: "gh has no access." });
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("with no answer in time it offers GitHub and a retry; a late answer is dropped", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let answer: (value: unknown) => void = () => {};
  const { slot, asked } = render(() => new Promise((resolve) => (answer = resolve)));
  await act(async () => vi.advanceTimersByTime(RESOLVE_MS));
  expect(slot.getByRole("alert").textContent).toContain("didn't answer in time");
  await act(async () => answer(found()));
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
  fireEvent.click(slot.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(asked).toHaveLength(2));
  await act(async () => answer(found()));
  await waitFor(() =>
    expect(slot.inspection.experimental_panelCalls).toMatchObject([
      { method: "openTab", options: { params: { key: KEY } } },
      { method: "closeTab" },
    ]),
  );
});

test("when the branch's review now shows another pull request, the link's goes to GitHub", async () => {
  const { slot } = render(found, 9);
  expect((await slot.findByRole("alert")).textContent).toContain("shows #9 now");
  expect(slot.getByRole("link", { name: "Open #12 on GitHub" })).toBeTruthy();
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
  expect(knownPullRequest(LOOKUP)).toMatchObject({ problem: expect.any(String) });
});

test("a tab closed before the answer opens nothing", async () => {
  let answer: (value: unknown) => void = () => {};
  const { slot } = render(() => new Promise((resolve) => (answer = resolve)));
  slot.unmount();
  await act(async () => answer(found()));
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});
