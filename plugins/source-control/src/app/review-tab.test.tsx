// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema } from "../core/ids.ts";
import type { ChangeDetail, ChangeRow } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { requestPlace, resetPlaces } from "./open-review.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
type ActionTab = {
  availability: string;
  component: ComponentType<{ threadId: string; environment: null; params: unknown }>;
};
const reviewTab = app.tabs.find((tab) => tab.id === "review") as unknown as ActionTab;

const key = changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:scott/panel");
const row: ChangeRow = {
  key,
  repo: "smsunarto/bb-plugins",
  title: "Review beside the thread",
  branch: "scott/panel",
  baseRef: "main",
  number: 12,
  url: null,
  author: "smsunarto",
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
const detail: ChangeDetail = {
  state: "change",
  row,
  head: "c0ffee",
  files: 1,
  additions: 1,
  deletions: 0,
  revision: { head: "c0ffee", base: "base0000", source: { kind: "forge", number: 12 } },
  stack: null,
  canMarkReady: false,
  ship: [],
  status: { label: "Open", tone: "open", number: 12, noPullRequest: false },
  problem: null,
  at: Date.now(),
};

type Handlers = PluginRpcTestHandlers<typeof sourceControlContract>;

function render(params: unknown) {
  return renderSlot(
    reviewTab,
    { threadId: "thread-a", environment: null, params },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      experimental_panel: { openTab: () => true },
      rpc: {
        changeDetail: ({ keys }) => Object.fromEntries(keys.map((k) => [k, detail])),
        checksForChange: ({ keys }) =>
          Object.fromEntries(keys.map((k) => [k, { read: null, problem: null }])),
        changeFiles: () => ({ ok: true as const, files: [], more: false }),
        changePatches: () => ({ ok: true as const, value: { files: [] } }),
        changeCommits: () => ({ ok: true as const, commits: [], more: false }),
      } as Partial<Handlers> as Handlers,
    },
  );
}

const selectedTab = (slot: ReturnType<typeof render>) =>
  slot.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

beforeEach(resetPlaces);
afterEach(cleanup);

test("Review is a thread action tab, so bb keeps one instance per Change's params", () => {
  expect(reviewTab.availability).toBe("action");
});

test("the tab lands where an entry point asks, and moves inside without leaving the thread", async () => {
  requestPlace({ key, tab: "commits" });
  const slot = render({ key });
  expect(await slot.findByText("Review beside the thread")).toBeTruthy();
  expect(selectedTab(slot)).toBe("Commits");

  // A second request for the tab already open moves it there.
  act(() => requestPlace({ key, tab: "files", path: "src/a.ts", line: 3 }));
  expect(selectedTab(slot)).toMatch(/^Files/);

  // Moving inside the tab keeps the thread: no route change.
  fireEvent.mouseDown(slot.getByRole("tab", { name: "Overview" }));
  expect(selectedTab(slot)).toBe("Overview");
  expect(slot.navigateCalls.filter((call) => call.method === "toPluginPanel")).toEqual([]);
  // The page's Back to changes has nothing to go back to here.
  expect(slot.queryByRole("button", { name: "Back to changes" })).toBeNull();
});

test("asking again for the place the tab already shows lands on it again", async () => {
  requestPlace({ key, tab: "files", path: "src/a.ts", line: 3 });
  const slot = render({ key });
  const first = await slot.findByTestId("sc-diff-column");
  // Same place: the Files view starts over, so it scrolls to the line again.
  act(() => requestPlace({ key, tab: "files", path: "src/a.ts", line: 3 }));
  const second = slot.getByTestId("sc-diff-column");
  expect(second).not.toBe(first);
  expect(first.isConnected).toBe(false);
});

test("opened from the launcher with no Change, the tab points to Source Control", async () => {
  const slot = render(null);
  fireEvent.click(await slot.findByRole("button", { name: "Open Source Control" }));
  expect(slot.experimental_panelCalls).toEqual([
    {
      method: "openTab",
      options: { tab: { id: "changes", context: { kind: "thread" }, availability: "fixed" } },
    },
  ]);
});
