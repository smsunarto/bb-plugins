// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useState, type ComponentType } from "react";
import {
  experimental_useRpcKeyedQuery as useKeyed,
  type ExperimentalPanelTabs,
} from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema } from "../core/ids.ts";
import type { ChangeDetail, ChangeRow } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import {
  knownPullRequest,
  rememberChange,
  resetKnownPullRequests,
  RESOLVE_MS,
} from "./open-pull-request.tsx";
import { resetPlaces } from "./open-review.ts";
import {
  pendingReviewThread,
  retirePendingReview,
  waitForReview,
} from "./pending-review-request.ts";
import { PullRequestTab } from "./pull-request-tab.tsx";

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
  retirePendingReview();
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
  changeDetail = vi.fn((): ChangeDetail | Promise<ChangeDetail> => detailShowing(shown)),
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
        changeDetail: async ({ keys }: { keys: string[] }) => ({
          [keys[0]!]: await changeDetail(),
        }),
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
  expect(knownPullRequest(LOOKUP, "thread-a")).toEqual({ key: KEY });
});

test("a pull request Source Control cannot read says why and offers GitHub, a click away", async () => {
  const { slot } = render(() => ({ [LOOKUP]: { key: null, problem: "gh has no access." } }));
  expect((await slot.findByRole("alert")).textContent).toContain("gh has no access.");
  const github = slot.getByRole("link", { name: "Open #12 on GitHub" });
  expect(github.getAttribute("href")).toBe("https://github.com/acme/api/pull/12");
  expect(knownPullRequest(LOOKUP, "thread-a")).toEqual({ problem: "gh has no access." });
  expect(knownPullRequest(LOOKUP, "thread-b")).toBeNull();
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
  expect(knownPullRequest(LOOKUP, "thread-a")).toMatchObject({ problem: expect.any(String) });
});

test("a tab closed before the answer opens nothing", async () => {
  let answer: (value: unknown) => void = () => {};
  const { slot } = render(() => new Promise((resolve) => (answer = resolve)));
  slot.unmount();
  await act(async () => answer(found()));
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("Try again reads a previously missing Change again even when the mapping is unchanged", async () => {
  const detail = vi
    .fn((): ChangeDetail => detailShowing(12))
    .mockReturnValueOnce({ state: "missing", problem: null });
  const { slot } = render(found, 12, detail);
  await slot.findByRole("alert");
  fireEvent.click(slot.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(slot.inspection.experimental_panelCalls).toMatchObject([
      { method: "openTab", options: { params: { key: KEY } } },
      { method: "closeTab" },
    ]),
  );
  expect(knownPullRequest(LOOKUP, "thread-a")).toEqual({ key: KEY });
});

test("a warm mapping still checks which pull request the Change shows", async () => {
  rememberChange(LOOKUP, KEY, "thread-a");
  const { slot, asked } = render(found, 13);
  expect((await slot.findByRole("alert")).textContent).toContain("shows #13 now");
  expect(asked).toEqual([]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
  expect(slot.inspection.rpcCalls).toContainEqual(
    expect.objectContaining({
      method: "changeDetail",
      input: { keys: [KEY], prNumber: 12, threadId: "thread-a" },
    }),
  );
});

test("a thrown lookup records a temporary miss", async () => {
  const { slot } = render(async () => {
    throw new Error("offline");
  });
  expect((await slot.findByRole("alert")).textContent).toContain("offline");
  expect(knownPullRequest(LOOKUP, "thread-a")).toEqual({
    problem: expect.stringContaining("offline"),
  });
  expect(knownPullRequest(LOOKUP, "thread-a", Date.now() + 60_000)).toBeNull();
});

test("a slow Change read names the Review in its timeout", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const detail = vi.fn((): Promise<ChangeDetail> => new Promise(() => {}));
  const { slot } = render(found, 12, detail);
  await waitFor(() => expect(detail).toHaveBeenCalled());
  await act(async () => vi.advanceTimersByTime(RESOLVE_MS));
  expect(slot.getByRole("alert").textContent).toContain("The Review didn't load in time.");
});

test("a slow GitHub lookup can return its server failure after eight seconds", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { slot, asked } = render(
    () =>
      new Promise((resolve) => {
        setTimeout(
          () => resolve({ [LOOKUP]: { key: null, problem: "Repository is unavailable." } }),
          14_000,
        );
      }),
  );
  await waitFor(() => expect(asked).toHaveLength(1));
  await act(async () => vi.advanceTimersByTimeAsync(14_000));
  expect(slot.getByRole("alert").textContent).toContain("Repository is unavailable.");
});

test("a missing Change states the branch error once", async () => {
  const detail = vi.fn((): ChangeDetail => ({ state: "missing", problem: null }));
  const { slot } = render(found, 12, detail);
  expect((await slot.findByRole("alert")).textContent).toBe(
    "Source Control doesn't know this pull request's branch.",
  );
});

test("an older PR handoff preserves a newer Tasks request", async () => {
  let resolveDetail: (detail: ChangeDetail) => void = () => {};
  const detail = vi.fn(() => new Promise<ChangeDetail>((resolve) => (resolveDetail = resolve)));
  const { slot } = render(found, 12, detail);
  await waitFor(() => expect(detail).toHaveBeenCalled());
  waitForReview({
    threadId: "thread-b",
    url: "https://github.com/acme/api/pull/13",
    fallback: () => {},
  });
  await act(async () => resolveDetail(detailShowing(12)));
  await waitFor(() => expect(slot.inspection.experimental_panelCalls).toHaveLength(2));
  expect(pendingReviewThread()).toBe("thread-b");
});

test("an in-flight refresh of a cached branch must finish before promotion", async () => {
  rememberChange(LOOKUP, KEY, "thread-a");
  let answer: (detail: ChangeDetail) => void = () => {};
  const read = vi
    .fn(() => new Promise<ChangeDetail>((resolve) => (answer = resolve)))
    .mockResolvedValueOnce(detailShowing(12));
  function Flow() {
    const [show, setShow] = useState(false);
    const q = useKeyed({ contract: sourceControlContract, method: "changeDetail", keys: [KEY] });
    return (
      <>
        <button onClick={() => void q.refetchKeys([KEY])}>refresh</button>
        <span>{q.data?.[KEY]?.state}</span>
        <button onClick={() => setShow(true)}>link</button>
        {show && (
          <PullRequestTab threadId="thread-a" pr={{ owner: "acme", repo: "api", number: 12 }} />
        )}
      </>
    );
  }
  const slot = renderSlot({ component: Flow as never }, {} as never, {
    experimental_rpcContract: sourceControlContract,
    pluginId: "source-control",
    experimental_panel: { openTab: () => true, getTabs: () => SELF, closeTab: () => true },
    rpc: { changeDetail: async () => ({ [KEY]: await read() }) } as never,
  });
  await slot.findByText("change");
  fireEvent.click(slot.getByText("refresh"));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await act(async () => {
    fireEvent.click(slot.getByText("link"));
  });
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
  await act(async () => answer(detailShowing(13)));
  expect((await slot.findByRole("alert")).textContent).toContain("shows #13 now");
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("reconnect promotes the Change after a detail RPC error", async () => {
  const detail = vi
    .fn((): ChangeDetail => detailShowing(12))
    .mockImplementationOnce(() => {
      throw new Error("Disconnected");
    });
  const { slot } = render(found, 12, detail);
  expect((await slot.findByRole("alert")).textContent).toContain("Disconnected");
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
  await act(async () => slot.experimental_invalidateRpc(null, "source-control"));
  await slot.findByText("Opened in its review tab.");
  expect(slot.inspection.experimental_panelCalls).toMatchObject([
    { method: "openTab", options: { params: { key: KEY } } },
    { method: "closeTab" },
  ]);
});

test("report the forge failure when the branch is known", async () => {
  const detail = vi.fn((): ChangeDetail => ({
    state: "missing",
    problem: { kind: "rate-limited", site: "GitHub", detail: "API rate limit exceeded" },
  }));
  const { slot } = render(found, 12, detail);
  expect((await slot.findByRole("alert")).textContent).toMatch(/rate[- ]limit/i);
});
