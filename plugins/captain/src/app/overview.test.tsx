// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { QueueItem } from "../contract/queue.ts";
import {
  asksTag,
  captainContract,
  crewTag,
  type CrewThreadItem,
  type DriveFileItem,
} from "../contract/rpc.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
const tab = app.tabs.find((each) => each.id === "overview")!;
const useVisible = tab.useVisible as (props: { threadId: string; environment: null }) => boolean;

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const CAPTAIN = "thr_captain";
const NOW = Date.now();

const decision: QueueItem = {
  kind: "ask",
  key: "ask:a1",
  id: "a1",
  askKind: "decision",
  text: "Pick the cache backend",
  detail: "Builds re-download deps.",
  options: ["Redis", "SQLite"],
  task: "BBP-43",
  since: NOW - 3 * 86_400_000,
  answer: null,
  snoozedUntil: null,
  skipOrder: null,
};
const ship: QueueItem = {
  ...decision,
  key: "ask:a2",
  id: "a2",
  askKind: "ship",
  text: "Ship the sidebar fix",
  options: ["Ship it", "Hold"],
  task: "BBP-44",
};

const crewThread = (overrides: Partial<CrewThreadItem>): CrewThreadItem => ({
  id: "thr_crew1",
  title: "Verify Unity builds",
  status: "idle",
  providerId: "claude-code",
  model: "Claude Opus 5.5",
  task: "GAME-5",
  role: "implement",
  hasPendingInteraction: false,
  updatedAt: NOW - 3 * 86_400_000,
  ...overrides,
});

const file = (path: string, excerpt: string | null = `# ${path}\n\nBody`): DriveFileItem => {
  const segments = path.split("/");
  return {
    path,
    name: segments.at(-1)!,
    folder: segments.length > 1 ? segments.slice(0, -1).join("/") : null,
    modifiedAt: NOW,
    excerpt,
  };
};

type State = { asks: QueueItem[]; threads: CrewThreadItem[]; files: DriveFileItem[] };

function render(state: State, options: { threadId?: string; external?: boolean } = {}) {
  const calls: string[] = [];
  const slot = renderSlot(
    tab as never,
    { threadId: options.threadId ?? CAPTAIN, environment: null } as never,
    {
      experimental_rpcContract: captainContract,
      pluginId: "captain",
      rpc: {
        captains: () => ({ ids: [CAPTAIN] }),
        asks: () => {
          calls.push("asks");
          return { items: state.asks };
        },
        crewThreads: () => {
          calls.push("crewThreads");
          return { threads: state.threads };
        },
        drive: () => {
          calls.push("drive");
          return {
            total: state.files.length,
            files: state.files,
            folder: { hostId: "host_server", path: "/storage/thr_captain" },
          };
        },
        resolveAsk: () => ({ state: "answered", warnings: [] }),
        defer: () => ({ snoozedUntil: null, skipOrder: null }),
      } as never,
      openFilePreview: () => true,
      openFileExternally: () => true,
      canOpenFileExternally: () => options.external ?? true,
      experimental_panel: { selectTab: () => true },
      experimental_panelTabs: {
        open: true,
        selectedKey: "overview",
        tabs: [
          { key: "info", title: "Info", status: null, closable: false, detail: { kind: "info" } },
        ],
      },
    },
  );
  return { slot, calls };
}

const seeded: State = {
  asks: [decision, ship],
  threads: [
    crewThread({ id: "thr_busy", title: "Fix the sidebar", status: "active", task: "BBP-44" }),
    crewThread({}),
    crewThread({ id: "thr_review", title: "Review BBP-43", role: "review", task: "BBP-43" }),
  ],
  files: [file("CAPTAIN.md"), file("CREW.md"), file("briefs/BBP-43.md")],
};

const section = async (slot: ReturnType<typeof render>["slot"], name: string) =>
  slot.findByRole("region", { name });

test("the tab shows only on a live Captain's thread", async () => {
  const Probe = ({ threadId }: { threadId: string }) => (
    <span data-testid="visible">{String(useVisible({ threadId, environment: null }))}</span>
  );
  const rpc = { captains: () => ({ ids: [CAPTAIN] }) } as never;
  const captain = renderSlot({ component: Probe } as never, { threadId: CAPTAIN } as never, {
    experimental_rpcContract: captainContract,
    rpc,
  });
  await waitFor(() => expect(captain.getByTestId("visible").textContent).toBe("true"));
  cleanup();
  const other = renderSlot({ component: Probe } as never, { threadId: "thr_other" } as never, {
    experimental_rpcContract: captainContract,
    rpc,
  });
  await waitFor(() => expect(other.getByTestId("visible").textContent).toBe("false"));
});

test("Needs you, Threads and Drive list their items with counts and sublines", async () => {
  const { slot } = render(seeded);
  const needs = await section(slot, "Needs you");
  await within(needs).findByText("Pick the cache backend");
  expect(needs.textContent).toContain("Needs you2");
  expect(needs.textContent).toContain("BBP-43 · decision");
  expect(needs.textContent).toContain("BBP-44 · ship");
  expect(needs.textContent).toContain("3d");

  const threads = await section(slot, "Threads");
  await within(threads).findByText("Fix the sidebar");
  expect(threads.textContent).toContain("Threads3");
  expect(threads.textContent).toContain("Claude Opus 5.5· GAME-5· implement· 3d");

  const drive = await section(slot, "Drive");
  await within(drive).findByRole("button", { name: "Open briefs/BBP-43.md" });
  expect(drive.textContent).toContain("Drive3");
  expect(drive.textContent).toContain("BBP-43.mdbriefs");
});

test("rows and cards open their targets", async () => {
  const { slot } = render(seeded);
  fireEvent.click(await slot.findByRole("button", { name: /Fix the sidebar/u }));
  fireEvent.click(await slot.findByRole("button", { name: "Open briefs/BBP-43.md" }));
  fireEvent.click(await slot.findByRole("button", { name: "Open the Drive folder" }));
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "toThread", threadId: "thr_busy" },
    {
      method: "experimental_openFilePreview",
      options: {
        target: { kind: "thread-storage", threadId: CAPTAIN, path: "briefs/BBP-43.md" },
        location: null,
      },
    },
    {
      method: "experimental_openFileExternally",
      options: {
        target: { kind: "host", hostId: "host_server", path: "/storage/thr_captain" },
        location: null,
      },
    },
  ]);
});

test("without an external file target, ↗ shows bb's Info tab instead", async () => {
  const { slot } = render(seeded, { external: false });
  fireEvent.click(await slot.findByRole("button", { name: "Show the Drive in Info" }));
  expect(slot.inspection.experimental_panelCalls).toEqual([{ method: "selectTab", key: "info" }]);
});

test("an ask opens the banner's answer controls, and answering sends it", async () => {
  const { slot } = render(seeded);
  fireEvent.click(await slot.findByRole("button", { name: /Pick the cache backend/u }));
  const answer = await slot.findByTestId("captain-overview-answer");
  expect(answer.textContent).toContain("Builds re-download deps.");
  expect(within(answer).getByRole("button", { name: /Redis/u }).textContent).toContain(
    "Recommended",
  );
  expect(within(answer).getByRole("button", { name: "Other…" })).not.toBeNull();
  fireEvent.click(within(answer).getByRole("button", { name: /SQLite/u }));
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "resolveAsk").map((c) => c.input),
    ).toEqual([{ askId: "a1", answer: "SQLite" }]),
  );
  fireEvent.click(slot.getByRole("button", { name: /Pick the cache backend/u }));
  await waitFor(() => expect(slot.queryByTestId("captain-overview-answer")).toBeNull());
});

test("sections collapse and stay collapsed for that thread", async () => {
  const first = render(seeded);
  const toggle = await within(await section(first.slot, "Threads")).findByRole("button", {
    name: /Threads/u,
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(first.slot.queryByText("Fix the sidebar")).toBeNull();
  cleanup();

  const again = render(seeded);
  const threads = await section(again.slot, "Threads");
  expect(
    within(threads)
      .getByRole("button", { name: /Threads/u })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  await within(await section(again.slot, "Needs you")).findByText("Pick the cache backend");
  cleanup();

  // Another Captain's Overview keeps its own state.
  const other = render(seeded, { threadId: "thr_other" });
  const otherThreads = await section(other.slot, "Threads");
  expect(
    within(otherThreads)
      .getByRole("button", { name: /Threads/u })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("an ask or a crew change refreshes its section", async () => {
  const state: State = { ...seeded, asks: [decision], threads: [crewThread({})] };
  const { slot } = render(state);
  const needs = await section(slot, "Needs you");
  await within(needs).findByText("Pick the cache backend");

  state.asks = [decision, ship];
  await slot.behavior.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  await within(needs).findByText("Ship the sidebar fix");

  state.asks = [ship];
  await slot.behavior.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  await waitFor(() => expect(within(needs).queryByText("Pick the cache backend")).toBeNull());

  const threads = await section(slot, "Threads");
  state.threads = [crewThread({ status: "active", title: "Verify Unity builds" })];
  await slot.behavior.experimental_invalidateRpc([crewTag(CAPTAIN)]);
  await waitFor(() =>
    expect(
      within(threads).getByText("Verify Unity builds").className.includes("text-foreground"),
    ).toBe(true),
  );
});

test("each section has an empty state", async () => {
  const { slot } = render({ asks: [], threads: [], files: [] });
  await slot.findByText("Nothing needs you.");
  await slot.findByText("No crew yet. Dispatch a task to start one.");
  await slot.findByText("The Drive is empty.");
});

test("a hidden tab reads nothing", async () => {
  const calls: string[] = [];
  renderSlot(tab as never, { threadId: CAPTAIN, environment: null } as never, {
    experimental_rpcContract: captainContract,
    tabVisible: false,
    rpc: {
      captains: () => ({ ids: [CAPTAIN] }),
      asks: () => (calls.push("asks"), { items: [] }),
      crewThreads: () => (calls.push("crewThreads"), { threads: [] }),
      drive: () => (calls.push("drive"), { total: 0, files: [], folder: null }),
    } as never,
  });
  await new Promise((settle) => setTimeout(settle, 30));
  expect(calls).toEqual([]);
});

test("the root carries the plugin-scope attribute beside its plugin label", async () => {
  const { slot } = render(seeded);
  const root = await slot.findByTestId("captain-overview");
  expect(root.getAttribute("data-bb-plugin")).toBe("captain");
  expect(root.hasAttribute("data-bb-plugin-scope-captain")).toBe(true);
});

test("an open ask stays open when bb remounts the tab", async () => {
  const first = render(seeded);
  fireEvent.click(await first.slot.findByRole("button", { name: /Ship the sidebar fix/u }));
  await first.slot.findByTestId("captain-overview-answer");
  cleanup();

  const again = render(seeded);
  const answer = await again.slot.findByTestId("captain-overview-answer");
  expect(answer.closest("li")?.textContent).toContain("Ship the sidebar fix");
  // Close it, so no other test starts with it open.
  fireEvent.click(again.slot.getByRole("button", { name: /Ship the sidebar fix/u }));
  await waitFor(() => expect(again.slot.queryByTestId("captain-overview-answer")).toBeNull());
});
