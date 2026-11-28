// @vitest-environment jsdom
/**
 * bb keeps a hidden thread side-panel tab mounted. The Changes tab still paints
 * its snapshot there, but neither its clock nor Create PR's `publishRequests`
 * read may run until the tab is shown, the page is visible, and bb is connected.
 */
import { act, cleanup } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { Branch, ThreadChange, WorkspaceValue } from "../core/change.ts";
import { changeKeySchema } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { writeSnapshot } from "./snapshot.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
type ThreadTab = {
  component: ComponentType<{ threadId: string; environment: { id: string } | null }>;
};
const tab = app.tabs.find((registration) => registration.id === "changes") as unknown as ThreadTab;

const BRANCH = "scott/forge-host";

/** A checkout whose own branch has commits and no pull request: Create PR shows. */
function unpublished(now: number): ThreadChange {
  const branch: Branch = {
    name: BRANCH,
    head: "f00d001",
    remote: null,
    status: "ahead",
    push: "push",
    ahead: 1,
    behind: 0,
    newUpstream: 0,
    reviewId: null,
    commits: [
      {
        id: "f00d001",
        subject: "Route forge reads",
        createdAt: new Date(now - 60 * 60_000).toISOString(),
        conflicted: false,
      },
    ],
    moreCommits: 0,
    upstreamCommits: [],
  };
  const workspace: WorkspaceValue = {
    provider: "gitbutler",
    path: "/work/forge",
    commonDir: "/work/forge/.git",
    checkedOut: null,
    github: { repo: { owner: "smsunarto", name: "bb-plugins" }, headOwner: "smsunarto" },
    uncommitted: [],
    moreUncommitted: 0,
    conflicted: [],
    stacks: [{ key: BRANCH, branches: [branch], assigned: [] }],
    target: null,
  };
  return {
    state: "checkout",
    placement: {
      hostId: "host-a",
      hostName: "studio-mac",
      path: "/work/forge",
      environmentId: "env",
    },
    readAsGit: false,
    branch: BRANCH,
    key: changeKeySchema.parse(`gh:smsunarto/bb-plugins:smsunarto:${BRANCH}`),
    local: { read: { value: workspace, at: now - 12 * 60_000 }, problem: null },
    forge: { read: { value: null, at: now }, problem: null },
  };
}

let page: DocumentVisibilityState = "visible";

beforeEach(() => {
  localStorage.clear();
  page = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => page });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
});

/** Paints the tab from the snapshot alone; the live read answers only "pending". */
function renderTab(options: {
  tabVisible: boolean;
  realtimeConnectionState?: PluginRealtimeConnectionState;
}) {
  writeSnapshot("thread-a", unpublished(Date.now()));
  let publishRequests = 0;
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      ...options,
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => ({ "thread-a": { state: "pending" as const } }),
        // A child is working, so an active tab polls every 5 s.
        publishRequests: () => (
          publishRequests++,
          { requests: [{ branch: BRANCH, threadId: "pr-child", running: true }] }
        ),
      },
    },
  );
  return { slot, publishRequests: () => publishRequests };
}

const readState = (slot: ReturnType<typeof renderTab>["slot"]) =>
  slot.getByTestId("sc-read-state").textContent;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function setPage(state: DocumentVisibilityState) {
  page = state;
  await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
}

test("a hidden tab paints its snapshot but neither ticks nor reads publishRequests", async () => {
  const { slot, publishRequests } = renderTab({ tabVisible: false });
  expect(slot.getByRole("button", { name: `Create PR for ${BRANCH}` })).toBeTruthy();
  expect(readState(slot)).toBe("Read 12 min ago");
  await advance(60_000);
  expect(publishRequests()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(readState(slot)).toBe("Read 12 min ago");
});

test("a background page holds the tab still, and showing it reads and ticks at once", async () => {
  page = "hidden";
  const { slot, publishRequests } = renderTab({ tabVisible: true });
  await advance(60_000);
  expect(publishRequests()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(readState(slot)).toBe("Read 12 min ago");

  await setPage("visible");
  // The clock reads the time on resume, not 30 s later.
  await vi.waitFor(() => expect(readState(slot)).toBe("Read 13 min ago"));
  await vi.waitFor(() => expect(publishRequests()).toBe(1));
  await vi.waitFor(() => expect(slot.getByTestId("sc-create-pr-status")).toBeTruthy());
  await advance(5_000);
  await vi.waitFor(() => expect(publishRequests()).toBe(2));

  await setPage("hidden");
  const before = publishRequests();
  await advance(60_000);
  expect(publishRequests()).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

test("a dropped connection holds the tab still until bb reconnects", async () => {
  const { slot, publishRequests } = renderTab({
    tabVisible: true,
    realtimeConnectionState: "reconnecting",
  });
  await advance(60_000);
  expect(publishRequests()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);

  await slot.behavior.setRealtimeConnectionState("connected");
  await vi.waitFor(() => expect(readState(slot)).toBe("Read 13 min ago"));
  await vi.waitFor(() => expect(publishRequests()).toBe(1));
  await vi.waitFor(() => expect(slot.getByTestId("sc-create-pr-status")).toBeTruthy());
  await advance(5_000);
  await vi.waitFor(() => expect(publishRequests()).toBe(2));
});
