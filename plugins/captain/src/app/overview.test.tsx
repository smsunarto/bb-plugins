// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { QueueItem } from "../contract/queue.ts";
import {
  asksTag,
  captainContract,
  crewTag,
  type CaptainTaskItem,
  type DriveFileItem,
} from "../contract/rpc.ts";
import type { RoutineView } from "../contract/routines.ts";

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

const task = (overrides: Partial<CaptainTaskItem>): CaptainTaskItem => ({
  key: "GAME-5",
  title: "Verify Unity builds",
  status: "in_progress",
  ready: false,
  crew: { threadId: "thr_crew1", role: "Implement", state: "idle" },
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

type State = {
  asks: QueueItem[];
  tasks: CaptainTaskItem[];
  /** More open tasks than were read. */
  tasksTruncated?: boolean;
  /** Every open task read, when more than the rows. */
  tasksTotal?: number;
  crewError?: string | null;
  /** Repos whose tasks could not be read. */
  unavailable?: string[];
  /** The owner backfill's state; ready when unset. */
  owners?: "ready" | "pending" | "failed";
  files: DriveFileItem[];
  /** Every file in the Drive, when more than the cards. */
  total?: number;
  truncated?: boolean;
  /** Reads that fail while set. */
  failing?: Set<string>;
  /** Reads that never answer, to hold their placeholders. */
  pending?: Set<string>;
  routines?: RoutineView[];
};

function render(
  state: State,
  options: {
    threadId?: string;
    external?: boolean;
    connection?: "connected" | "reconnecting";
  } = {},
) {
  const fails = (method: string) => {
    if (state.failing?.has(method)) throw new Error(`${method} unavailable`);
  };
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
          fails("asks");
          if (state.pending?.has("asks")) return new Promise(() => {});
          return { items: state.asks };
        },
        tasks: () => {
          calls.push("tasks");
          fails("tasks");
          if (state.pending?.has("tasks")) return new Promise(() => {});
          return {
            tasks: state.tasks,
            total: state.tasksTotal ?? state.tasks.length,
            truncated: state.tasksTruncated ?? false,
            crewError: state.crewError ?? null,
            unavailable: state.unavailable ?? [],
            owners: state.owners ?? "ready",
          };
        },
        routines: () => {
          calls.push("routines");
          fails("routines");
          return { routines: state.routines ?? [], serverTimezone: "UTC" };
        },
        drive: () => {
          calls.push("drive");
          fails("drive");
          return {
            total: state.total ?? state.files.length,
            truncated: state.truncated ?? false,
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
      ...(options.connection === undefined ? {} : { realtimeConnectionState: options.connection }),
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
  tasks: [
    task({
      key: "BBP-44",
      title: "Fix the sidebar",
      status: "in_review",
      ready: true,
      crew: { threadId: "thr_busy", role: "Review", state: "working" },
    }),
    task({}),
    task({ key: "BBP-43", title: "Cache the builds", status: "todo", crew: null }),
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

test("Needs you, Tasks and Drive list their items with counts and sublines", async () => {
  const { slot } = render(seeded);
  const needs = await section(slot, "Needs you");
  await within(needs).findByText("Pick the cache backend");
  expect(needs.textContent).toContain("Needs you2");
  expect(needs.textContent).toContain("BBP-43 · decision");
  expect(needs.textContent).toContain("BBP-44 · ship");
  expect(needs.textContent).toContain("3d");

  const tasks = await section(slot, "Tasks");
  await within(tasks).findByText("Fix the sidebar");
  expect(tasks.textContent).toContain("Tasks3");
  // One line a task: the status and crew state are in the row's tooltip, not under it.
  const rowTitle = (key: string) =>
    within(tasks)
      .getByRole("link", { name: new RegExp(`^${key} `, "u") })
      .getAttribute("title");
  expect(rowTitle("BBP-44")).toBe("BBP-44 Fix the sidebar\nReady to ship · Review working");
  expect(rowTitle("GAME-5")).toBe("GAME-5 Verify Unity builds\nIn progress · Implement idle");
  expect(rowTitle("BBP-43")).toBe("BBP-43 Cache the builds\nTodo");
  expect(tasks.textContent).not.toContain("Ready to ship");
  expect(tasks.textContent).not.toContain("In progress");
  expect(tasks.textContent).toContain("BBP-43 Cache the builds");

  const drive = await section(slot, "Drive");
  await within(drive).findByRole("button", { name: "Open briefs/BBP-43.md" });
  expect(drive.textContent).toContain("Drive3");
  expect(drive.textContent).toContain("BBP-43.mdbriefs");
});

test("a task opens in Tasks, and its crew thread from the row's link", async () => {
  const { slot } = render(seeded);
  const row = await slot.findByRole("link", { name: /BBP-44 Fix the sidebar/u });
  expect(row.getAttribute("href")).toBe("/plugins/scott-tasks/tasks/task/BBP-44");
  // A task without crew has no thread link.
  expect(slot.queryByRole("button", { name: /BBP-43's/u })).toBeNull();
});

test("rows and cards open their targets", async () => {
  const { slot } = render(seeded);
  fireEvent.click(
    await slot.findByRole("button", { name: "Open BBP-44's Review thread, working" }),
  );
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
  const toggle = await within(await section(first.slot, "Tasks")).findByRole("button", {
    name: /Tasks/u,
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(first.slot.queryByText("Fix the sidebar")).toBeNull();
  cleanup();

  const again = render(seeded);
  const tasks = await section(again.slot, "Tasks");
  expect(within(tasks).getByRole("button", { name: /Tasks/u }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  await within(await section(again.slot, "Needs you")).findByText("Pick the cache backend");
  cleanup();

  // Another Captain's Overview keeps its own state.
  const other = render(seeded, { threadId: "thr_other" });
  const otherTasks = await section(other.slot, "Tasks");
  expect(
    within(otherTasks).getByRole("button", { name: /Tasks/u }).getAttribute("aria-expanded"),
  ).toBe("true");
});

test("a Threads section collapsed before Tasks replaced it stays collapsed", async () => {
  window.localStorage.setItem(
    `captain:overview:${CAPTAIN}`,
    JSON.stringify({ needs: false, threads: true, drive: false }),
  );
  const { slot } = render(seeded);
  const tasks = await section(slot, "Tasks");
  expect(within(tasks).getByRole("button", { name: /Tasks/u }).getAttribute("aria-expanded")).toBe(
    "false",
  );
});

test("an ask or a crew change refreshes its section", async () => {
  const state: State = { ...seeded, asks: [decision], tasks: [task({})] };
  const { slot } = render(state);
  const needs = await section(slot, "Needs you");
  await within(needs).findByText("Pick the cache backend");

  state.asks = [decision, ship];
  await slot.behavior.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  await within(needs).findByText("Ship the sidebar fix");

  state.asks = [ship];
  await slot.behavior.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  await waitFor(() => expect(within(needs).queryByText("Pick the cache backend")).toBeNull());
});

test("a crew change refreshes the tasks: their order and their crew's state", async () => {
  const review = task({ key: "BBP-43", title: "Review the cache", status: "in_review" });
  const work = task({ key: "GAME-5", title: "Verify Unity builds" });
  const state: State = { ...seeded, tasks: [review, work] };
  const { slot } = render(state);
  const tasks = await section(slot, "Tasks");
  await within(tasks).findByText("Review the cache");
  const rowNames = () =>
    within(tasks)
      .getAllByRole("link")
      .map((row) => row.textContent?.slice(0, 6));
  expect(rowNames()).toEqual(["BBP-43", "GAME-5"]);

  // The server orders ready to ship first, then in review.
  state.tasks = [
    { ...work, ready: true, crew: { threadId: "thr_crew1", role: "Implement", state: "working" } },
    review,
  ];
  await slot.behavior.experimental_invalidateRpc([crewTag(CAPTAIN)]);
  await waitFor(() => expect(rowNames()).toEqual(["GAME-5", "BBP-43"]));
  expect(
    within(tasks)
      .getByRole("link", { name: /^GAME-5 /u })
      .getAttribute("title"),
  ).toBe("GAME-5 Verify Unity builds\nReady to ship · Implement working");
});

test("a crew that errored or needs input shows its own glyph and names its state", async () => {
  const { slot } = render({
    ...seeded,
    tasks: [
      task({ key: "BBP-50", crew: { threadId: "thr_err", role: "Review", state: "errored" } }),
      task({
        key: "BBP-51",
        crew: { threadId: "thr_ask", role: "Implement", state: "needs-input" },
      }),
      task({ key: "BBP-52" }),
    ],
  });
  const errored = await slot.findByRole("button", { name: "Open BBP-50's Review thread, errored" });
  const asking = slot.getByRole("button", { name: "Open BBP-51's Implement thread, needs input" });
  const idle = slot.getByRole("button", { name: "Open BBP-52's Implement thread, idle" });
  expect(errored.className).toContain("text-destructive");
  expect(asking.className).toContain("text-warning-text");
  expect(idle.className).toContain("text-muted-foreground");
  const glyph = (button: HTMLElement) =>
    button.querySelector("[data-icon]")?.getAttribute("data-icon");
  expect(glyph(errored)).toBe("AlertTriangle");
  expect(glyph(asking)).toBe("MessageQuestion");
  expect(glyph(idle)).toBe("MessageSquare");
});

test("a task's status is the link's description and the crew button's tooltip, not the row's name", async () => {
  const { slot } = render({
    ...seeded,
    tasks: [
      task({ key: "BBP-50", crew: { threadId: "thr_err", role: "Review", state: "errored" } }),
    ],
  });
  const tooltip = "BBP-50 Verify Unity builds\nIn progress · Review errored";
  const link = await slot.findByRole("link", { name: "BBP-50 Verify Unity builds" });
  expect(link.getAttribute("title")).toBe(tooltip);
  const button = slot.getByRole("button", { name: "Open BBP-50's Review thread, errored" });
  // Button takes no title; hovering it shows the nearest ancestor's.
  expect(button.closest("[title]")?.getAttribute("title")).toBe(tooltip);
  const row = link.closest("li")!;
  expect(row.hasAttribute("title")).toBe(false);
  expect(row.contains(button.closest("[title]"))).toBe(true);
});

test("Tasks holds one-line rows while it loads; Needs you keeps two-line ones", async () => {
  const { slot } = render({ ...seeded, pending: new Set(["asks", "tasks"]) });
  const tasks = await section(slot, "Tasks");
  const needs = await section(slot, "Needs you");
  const needsRows = [...needs.querySelectorAll("[aria-busy] > div")];
  expect(needsRows).toHaveLength(2);
  for (const row of needsRows) {
    expect(row.className).toContain("items-start");
    const text = row.querySelector(":scope > .flex.flex-col");
    expect(text?.querySelectorAll(":scope > .animate-pulse")).toHaveLength(2);
  }
  const rows = [...tasks.querySelectorAll("[aria-busy] > div")];
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.className).toContain("items-center");
    expect(row.querySelectorAll(".animate-pulse")).toHaveLength(2);
  }
});

test("retrying unavailable crew keeps the tasks listed and restores crew links", async () => {
  const state: State = {
    ...seeded,
    tasks: seeded.tasks.map((item) => ({ ...item, crew: null })),
    crewError: "bb did not answer",
  };
  const { slot } = render(state);
  const tasks = await section(slot, "Tasks");
  await within(tasks).findByText("Crew unavailable · bb did not answer");
  expect(within(tasks).getByText("Fix the sidebar")).not.toBeNull();
  state.crewError = null;
  state.tasks = seeded.tasks;
  fireEvent.click(within(tasks).getByRole("button", { name: "Retry" }));
  await within(tasks).findByRole("button", { name: "Open BBP-44's Review thread, working" });
  expect(within(tasks).queryByText(/Crew unavailable/u)).toBeNull();
});

test("Tasks counts with + when a repo had more open tasks than were read", async () => {
  const { slot } = render({ ...seeded, tasksTruncated: true });
  const tasks = await section(slot, "Tasks");
  await within(tasks).findByText("Fix the sidebar");
  expect(tasks.textContent).toContain("Tasks3+");
  expect(within(tasks).getByText("More in Tasks")).not.toBeNull();
});

test("Tasks counts every open task, and says how many the rows leave out", async () => {
  const { slot } = render({ ...seeded, tasksTotal: 140 });
  const tasks = await section(slot, "Tasks");
  await within(tasks).findByText("137 more in Tasks");
  expect(tasks.textContent).toContain("Tasks140");
});

test("an owner backfill still running is said above the tasks", async () => {
  const { slot } = render({ ...seeded, owners: "pending" });
  const tasks = await section(slot, "Tasks");
  await within(tasks).findByText("Matching older tasks to this Captain · some may be missing");
  expect(within(tasks).getByText("Fix the sidebar")).not.toBeNull();
});

test("an owner backfill waiting to retry is said, not shown as an empty list alone", async () => {
  const { slot } = render({ ...seeded, tasks: [], owners: "failed" });
  const tasks = await section(slot, "Tasks");
  await within(tasks).findByText("Couldn't match older tasks to this Captain yet · retrying");
});

test("a repo that could not be read is named above the others' tasks", async () => {
  const { slot } = render({ ...seeded, unavailable: ["rampage"] });
  const tasks = await section(slot, "Tasks");
  await within(tasks).findByText("Couldn't load rampage · the other repos are listed");
  expect(within(tasks).getByText("Fix the sidebar")).not.toBeNull();
});

test("a failed first read says so with Retry, and Retry loads it", async () => {
  const state: State = { ...seeded, failing: new Set(["tasks"]) };
  const { slot } = render(state);
  const tasks = await section(slot, "Tasks");
  await within(tasks).findByText(/Couldn't load · tasks unavailable/u);
  state.failing = new Set();
  fireEvent.click(within(tasks).getByRole("button", { name: "Retry" }));
  await within(tasks).findByText("Fix the sidebar");
  expect(within(tasks).queryByRole("status")).toBeNull();
});

test("a failed refresh keeps the loaded rows, labelled as not refreshed", async () => {
  const state: State = { ...seeded };
  const { slot } = render(state);
  const needs = await section(slot, "Needs you");
  await within(needs).findByText("Pick the cache backend");
  state.failing = new Set(["asks"]);
  await slot.behavior.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  await within(needs).findByText(/Couldn't refresh · asks unavailable/u);
  expect(within(needs).getByText("Pick the cache backend")).not.toBeNull();
});

test("offline, each section says so instead of pulsing", async () => {
  const { slot } = render(seeded, { connection: "reconnecting" });
  const drive = await section(slot, "Drive");
  await within(drive).findByText(/^Offline/u);
  expect(within(drive).getByRole("button", { name: "Retry" })).not.toBeNull();
});

test("the browser going offline labels loaded rows before bb's socket notices", async () => {
  const { slot } = render(seeded);
  const needs = await section(slot, "Needs you");
  await within(needs).findByText("Pick the cache backend");
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  try {
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await within(needs).findByText("Offline · showing the last loaded");
    expect(within(needs).getByText("Pick the cache backend")).not.toBeNull();
  } finally {
    // The prototype keeps the real getter; dropping the own property restores it.
    delete (navigator as { onLine?: boolean }).onLine;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
  }
  await waitFor(() => expect(within(needs).queryByText(/^Offline/u)).toBeNull());
});

test("Needs you counts and lists the banner's queue: an ask under Later is left out", async () => {
  const later: QueueItem = { ...ship, snoozedUntil: NOW + 3_600_000 };
  const { slot } = render({ ...seeded, asks: [decision, later] });
  const needs = await section(slot, "Needs you");
  await within(needs).findByText("Pick the cache backend");
  expect(needs.textContent).toContain("Needs you1");
  expect(within(needs).queryByText("Ship the sidebar fix")).toBeNull();
});

/** A tab whose asks and answer replies a test controls. */
function answering(rpc: { asks: () => QueueItem[]; resolveAsk: (input: unknown) => unknown }) {
  return renderSlot(tab as never, { threadId: CAPTAIN, environment: null } as never, {
    experimental_rpcContract: captainContract,
    rpc: {
      captains: () => ({ ids: [CAPTAIN] }),
      asks: () => ({ items: rpc.asks() }),
      tasks: () => ({
        tasks: [],
        total: 0,
        truncated: false,
        crewError: null,
        unavailable: [],
        owners: "ready",
      }),
      drive: () => ({ total: 0, truncated: false, files: [], folder: null }),
      resolveAsk: rpc.resolveAsk,
    } as never,
  });
}

/** Leave no ask open for the next test: the open ask outlives a remount on purpose. */
async function closeOpenAsk() {
  cleanup();
  const slot = answering({ asks: () => [decision], resolveAsk: () => undefined });
  const row = await slot.findByRole("button", { name: /Pick the cache backend/u });
  if (row.getAttribute("aria-expanded") === "true") fireEvent.click(row);
}

test("answering: no number shortcuts, Other… sends once, and focus stays in the panel as the ask leaves", async () => {
  let release: () => void = () => undefined;
  const sent: unknown[] = [];
  let asks: QueueItem[] = [decision];
  const slot = answering({
    asks: () => asks,
    resolveAsk: (input) => {
      sent.push(input);
      return new Promise((resolve) => {
        release = () => resolve({ state: "answered", warnings: [] });
      });
    },
  });
  fireEvent.click(await slot.findByRole("button", { name: /Pick the cache backend/u }));
  const answer = await slot.findByTestId("captain-overview-answer");
  expect(
    within(answer).getByRole("button", { name: /Redis/u }).hasAttribute("aria-keyshortcuts"),
  ).toBe(false);
  fireEvent.click(within(answer).getByRole("button", { name: "Other…" }));
  const box = within(answer).getByRole("textbox", { name: "Your answer" });
  fireEvent.change(box, { target: { value: "Valkey" } });
  fireEvent.submit(box.closest("form")!);
  fireEvent.submit(box.closest("form") ?? document.createElement("form"));
  await waitFor(() => expect(sent).toEqual([{ askId: "a1", answer: "Valkey" }]));
  // The form is gone and focus is on the panel, not the page.
  expect(within(answer).queryByRole("textbox")).toBeNull();
  expect(document.activeElement).toBe(answer);

  // The server takes it and delivers it: the ask leaves the list, and focus
  // moves to the section's toggle rather than falling to the page.
  asks = [];
  release();
  await slot.behavior.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  await waitFor(() => expect(slot.queryByTestId("captain-overview-answer")).toBeNull());
  const needs = await slot.findByRole("region", { name: "Needs you" });
  expect(document.activeElement).toBe(within(needs).getByRole("button", { name: /Needs you/u }));
  await closeOpenAsk();
});

test("a refused Other… answer keeps its draft for the next try", async () => {
  const slot = answering({
    asks: () => [decision],
    resolveAsk: () => {
      throw new Error("the Captain is not running");
    },
  });
  fireEvent.click(await slot.findByRole("button", { name: /Pick the cache backend/u }));
  const answer = await slot.findByTestId("captain-overview-answer");
  fireEvent.click(within(answer).getByRole("button", { name: "Other…" }));
  const box = within(answer).getByRole("textbox", { name: "Your answer" });
  fireEvent.change(box, { target: { value: "Valkey" } });
  fireEvent.submit(box.closest("form")!);
  await within(answer).findByText(/the Captain is not running/u);
  fireEvent.click(await within(answer).findByRole("button", { name: "Other…" }));
  const again = within(answer).getByRole("textbox", { name: "Your answer" });
  expect((again as HTMLInputElement).value).toBe("Valkey");
  // Escape drops the draft, so no other test starts with it.
  fireEvent.keyDown(again, { key: "Escape" });
  await closeOpenAsk();
});

test("a walk that stopped before finding a file is not an empty Drive", async () => {
  const { slot } = render({ asks: [], tasks: [], files: [], total: 0, truncated: true });
  const drive = await section(slot, "Drive");
  await within(drive).findByRole("button", { name: /^More in the Drive/u });
  expect(within(drive).queryByText("The Drive is empty.")).toBeNull();
  expect(drive.textContent).toContain("Drive0+");
});

test("the Drive says how many files the cards leave out, with + past the walk's bound", async () => {
  const { slot } = render({ ...seeded, total: 40, truncated: true });
  const drive = await section(slot, "Drive");
  await within(drive).findByRole("button", { name: /37\+ more in the Drive/u });
  expect(drive.textContent).toContain("Drive40+");
});

test("each section has an empty state", async () => {
  const { slot } = render({ asks: [], tasks: [], files: [] });
  await slot.findByText("Nothing needs you.");
  await slot.findByText(/No open tasks for this Captain\..*bb captain claim/u);
  await slot.findByText("The Drive is empty.");
  await slot.findByText(/Ask the Captain to set a routine/u);
});

test("Routines sits between Tasks and Drive, and a failed routines read leaves the others loaded", async () => {
  const { slot } = render({ ...seeded, failing: new Set(["routines"]) });
  await within(await section(slot, "Drive")).findByRole("button", {
    name: "Open briefs/BBP-43.md",
  });
  const order = [...slot.container.querySelectorAll("section[data-section]")].map((node) =>
    node.getAttribute("data-section"),
  );
  expect(order).toEqual(["needs", "tasks", "routines", "drive"]);
  const routines = await section(slot, "Routines");
  await within(routines).findByText(/Couldn't load · routines unavailable/u);
  await within(await section(slot, "Tasks")).findByText("Fix the sidebar");
});

test("a hidden tab reads nothing", async () => {
  const calls: string[] = [];
  renderSlot(tab as never, { threadId: CAPTAIN, environment: null } as never, {
    experimental_rpcContract: captainContract,
    tabVisible: false,
    rpc: {
      captains: () => ({ ids: [CAPTAIN] }),
      asks: () => (calls.push("asks"), { items: [] }),
      tasks: () => (
        calls.push("tasks"),
        { tasks: [], total: 0, truncated: false, crewError: null, unavailable: [], owners: "ready" }
      ),
      drive: () => (calls.push("drive"), { total: 0, truncated: false, files: [], folder: null }),
      routines: () => (calls.push("routines"), { routines: [], serverTimezone: "UTC" }),
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
