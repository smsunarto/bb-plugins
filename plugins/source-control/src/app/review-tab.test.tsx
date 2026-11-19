// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import type { ChangeKey } from "../core/ids.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema } from "../core/ids.ts";
import type { ChangeDetail, ChangeRow } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { requestPlace, resetPlaces, setPlace, useOpenReview } from "./open-review.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
type ActionTab = {
  availability: string;
  component: ComponentType<{ threadId: string; environment: null; params: unknown }>;
};
const reviewTab = app.tabs.find((tab) => tab.id === "review") as unknown as ActionTab;

const key = changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:scott/panel");
const sibling = changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:scott/panel-top");
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
  stack: [
    {
      key: sibling,
      branch: "scott/panel-top",
      number: 13,
      state: "open",
      commits: 1,
      current: false,
    },
    { key, branch: "scott/panel", number: 12, state: "open", commits: 2, current: true },
  ],
  canMarkReady: false,
  ship: [],
  status: { label: "Open", tone: "open", number: 12, noPullRequest: false },
  problem: null,
  at: Date.now(),
};

type Handlers = PluginRpcTestHandlers<typeof sourceControlContract>;

const RPC = {
  changeDetail: ({ keys }) => Object.fromEntries(keys.map((k) => [k, detail])),
  checksForChange: ({ keys }) =>
    Object.fromEntries(keys.map((k) => [k, { read: null, problem: null }])),
  changeFiles: () => ({ ok: true as const, files: [], more: false }),
  changePatches: () => ({ ok: true as const, value: { files: [] } }),
  changeCommits: () => ({ ok: true as const, commits: [], more: false }),
} as Partial<Handlers> as Handlers;

function render(params: unknown, threadId = "thread-a", rpc: Partial<Handlers> = {}) {
  return renderSlot(
    reviewTab,
    { threadId, environment: null, params },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      experimental_panel: { openTab: () => true },
      rpc: { ...RPC, ...rpc } as Handlers,
    },
  );
}

const selectedTab = (slot: ReturnType<typeof render>) =>
  slot.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

beforeEach(() => resetPlaces());
afterEach(cleanup);

function Opener({ targets }: { targets: { label: string; key: ChangeKey; path?: string }[] }) {
  const openReview = useOpenReview("thread-a");
  return targets.map((target) => (
    <button
      key={target.label}
      type="button"
      onClick={() => openReview({ key: target.key, tab: "files", path: target.path })}
    >
      {target.label}
    </button>
  ));
}

test("opening one Change twice asks bb for the same tab; another Change gets its own", () => {
  const slot = renderSlot(
    { component: Opener },
    {
      targets: [
        { label: "a.ts", key, path: "src/a.ts" },
        { label: "b.ts", key, path: "src/b.ts" },
        { label: "sibling", key: sibling },
      ],
    },
    { pluginId: "source-control", experimental_panel: { openTab: () => true } },
  );
  for (const label of ["a.ts", "b.ts", "sibling"])
    fireEvent.click(slot.getByRole("button", { name: label }));
  // bb focuses an open action tab whose params match, so params alone decide reuse.
  const params = slot.experimental_panelCalls.map((call) =>
    call.method === "openTab" ? call.options.params : null,
  );
  expect(params).toEqual([{ key }, { key }, { key: sibling }]);
});

test("the tab lands where an entry point asks, and moves inside without leaving the thread", async () => {
  requestPlace("thread-a", { key, tab: "commits" });
  const slot = render({ key });
  expect(await slot.findByText("Review beside the thread")).toBeTruthy();
  expect(selectedTab(slot)).toBe("Commits");

  // A request for the tab already open moves it there.
  act(() => requestPlace("thread-a", { key, tab: "files", path: "src/a.ts", line: 3 }));
  expect(selectedTab(slot)).toMatch(/^Files/);

  // Moving inside the tab keeps the thread: no route change.
  fireEvent.mouseDown(slot.getByRole("tab", { name: "Overview" }));
  expect(selectedTab(slot)).toBe("Overview");
  expect(slot.navigateCalls.filter((call) => call.method === "toPluginPanel")).toEqual([]);
  // The page's Back to changes has nothing to go back to here.
  expect(slot.queryByRole("button", { name: "Back to changes" })).toBeNull();
});

test("asking again for a place reveals it again, without rebuilding the views", async () => {
  const files = ["src/a.ts", "src/b.ts"].map((path) => ({
    path,
    kind: "modified" as const,
    previousPath: null,
    additions: 1,
    deletions: 0,
    binary: false,
  }));
  const scrollTo = vi.fn();
  const original = Element.prototype.scrollTo;
  Element.prototype.scrollTo = scrollTo;
  try {
    requestPlace("thread-a", { key, tab: "files", path: "src/b.ts", line: 4 });
    const slot = render({ key }, "thread-a", {
      changeFiles: () => ({ ok: true as const, files, more: false }),
    });
    const column = await slot.findByTestId("sc-diff-column");
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));

    // The reader scrolls away; the same finding is clicked again: it is revealed again.
    act(() => requestPlace("thread-a", { key, tab: "files", path: "src/b.ts", line: 4 }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(2));
    // Moving inside the tab to the place it shows does nothing.
    act(() => setPlace("thread-a", { key, tab: "files", path: "src/b.ts", line: 4 }));
    // Nothing was rebuilt: the same diff column throughout.
    expect(slot.getByTestId("sc-diff-column")).toBe(column);
    await new Promise((settle) => requestAnimationFrame(settle));
    expect(scrollTo).toHaveBeenCalledTimes(2);
  } finally {
    Element.prototype.scrollTo = original;
  }
});

test("two threads' tabs for one Change keep their own places", async () => {
  const a = within(render({ key }, "thread-a").container);
  const b = within(render({ key }, "thread-b").container);
  await a.findByText("Review beside the thread");
  await b.findByText("Review beside the thread");
  act(() => setPlace("thread-a", { key, tab: "commits" }));
  const selected = (scope: typeof a) =>
    scope.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")
      ?.textContent;
  expect(selected(a)).toBe("Commits");
  expect(selected(b)).toBe("Overview");
});

test("after a reload the tab comes back to its file and line", async () => {
  setPlace("thread-a", { key, tab: "files", path: "src/a.ts", line: 3 });
  resetPlaces({ reload: true });
  const slot = render({ key });
  await slot.findByText("Review beside the thread");
  expect(selectedTab(slot)).toMatch(/^Files/);
});

test("a Stack row opens that Change's own tab beside the thread", async () => {
  const slot = render({ key });
  fireEvent.click(await slot.findByRole("button", { name: /scott\/panel-top/ }));
  expect(slot.experimental_panelCalls).toEqual([
    {
      method: "openTab",
      options: {
        tab: { id: "review", context: { kind: "thread" }, availability: "action" },
        params: { key: sibling },
        title: "Review · scott/panel-top",
      },
    },
  ]);
  expect(selectedTab(slot)).toBe("Overview");
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
