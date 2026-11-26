// @vitest-environment jsdom
import { getResolvedHeaderBar, resetHeaderBarRegistry } from "@bb-plugins/header-bar";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalThreadHeaderRowProps } from "@get-bb/plugin-sdk/app";
import type { CaptainIcon } from "../contract/icon.ts";
import { captainContract, type CrewRoster, type CrewRosterMember } from "../contract/rpc.ts";
import { CAPTAIN_OVERVIEW_TAB } from "./banner.tsx";
import { CompactViewportOverrideProvider } from "./components/ui/hooks/use-compact-viewport.tsx";
import { CAPTAIN_HEADER_ROW_ORDER, CAPTAIN_SEGMENT_PRIORITY } from "./header-row.tsx";

const app = await loadPluginApp(() => import("./app.tsx"));
const headerRow = app.threadHeaderRows.find((each) => each.id === "captain-crew")!;

afterEach(() => {
  cleanup();
  resetHeaderBarRegistry();
});

const CAPTAIN_A = "thr_captain_a";
const CAPTAIN_B = "thr_captain_b";
const CREW_1 = "thr_crew_1";
const CREW_2 = "thr_crew_2";
const UNRELATED = "thr_unrelated";

const member = (overrides: Partial<CrewRosterMember> & { threadId: string }): CrewRosterMember => ({
  title: "BBP-44 · Fix header row",
  role: "Implement",
  task: "BBP-44",
  taskTitle: "Fix header row",
  state: "working",
  updatedAt: 1_000,
  ...overrides,
});

const rosterOf = (
  captainId: string,
  name: string,
  members: CrewRosterMember[],
  icon: CaptainIcon = { kind: "default" },
): CrewRoster => ({
  captain: { threadId: captainId, name, icon },
  members,
});

type RenderOptions = {
  captains?: string[];
  crewOf?: Record<string, string | null>;
  rosters?: Record<string, CrewRoster | Error>;
  panelOpen?: boolean;
  compactViewport?: boolean;
};

function renderHeader(threadId: string, options: RenderOptions = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const openTabs: unknown[] = [];
  const captains = options.captains ?? [CAPTAIN_A];
  const crewOfMap = options.crewOf ?? {};
  const rosters = options.rosters ?? {};
  const BaseComponent = headerRow.component;
  const Wrapped =
    options.compactViewport === undefined
      ? headerRow
      : {
          ...headerRow,
          component: (props: ExperimentalThreadHeaderRowProps) => (
            <CompactViewportOverrideProvider isCompactViewport={options.compactViewport!}>
              <BaseComponent {...props} />
            </CompactViewportOverrideProvider>
          ),
        };

  const slot = renderSlot(
    Wrapped as never,
    { threadId, projectId: "proj_plugins", environment: null } as never,
    {
      experimental_rpcContract: captainContract,
      pluginId: "captain",
      experimental_panel: {
        openTab: (arg: unknown) => {
          openTabs.push(arg);
          return true;
        },
      },
      experimental_panelTabs: {
        open: options.panelOpen ?? false,
        selectedKey: options.panelOpen ? "overview" : null,
        tabs: [],
      },
      rpc: {
        captains: (input: unknown) => {
          calls.push({ method: "captains", input });
          return { ids: captains };
        },
        crewOf: (input: unknown) => {
          calls.push({ method: "crewOf", input });
          const { keys = [] } = (input ?? {}) as { keys?: string[] };
          const out: Record<string, string | null> = {};
          for (const key of keys) out[key] = crewOfMap[key] ?? null;
          return out;
        },
        crewRoster: (input: unknown) => {
          calls.push({ method: "crewRoster", input });
          const { captainId } = input as { captainId: string };
          const result = rosters[captainId];
          if (result instanceof Error) throw result;
          return result ?? rosterOf(captainId, "Plugins", []);
        },
      },
    },
  );
  return { slot, calls, openTabs };
}

test("registers captain-crew threadHeaderRow at order 20 and renders no direct DOM", () => {
  expect(headerRow).toBeDefined();
  expect(headerRow.order).toBe(CAPTAIN_HEADER_ROW_ORDER);

  const { slot } = renderHeader(UNRELATED, { captains: [] });
  expect(slot.container.innerHTML).toBe("");
});

test("unrelated threads publish zero segments and never call crewRoster", async () => {
  const { calls } = renderHeader(UNRELATED, {
    captains: [CAPTAIN_A],
    crewOf: { [UNRELATED]: null },
  });

  await waitFor(() => {
    expect(calls.some((call) => call.method === "crewOf")).toBe(true);
  });
  expect(calls.some((call) => call.method === "crewRoster")).toBe(false);
  expect(getResolvedHeaderBar(UNRELATED).isEmpty).toBe(true);
});

test("crew thread publishes lineage + crew menu at priority 10 and navigates cleanly", async () => {
  const { slot } = renderHeader(CREW_1, {
    captains: [CAPTAIN_A],
    crewOf: { [CREW_1]: CAPTAIN_A },
    rosters: {
      [CAPTAIN_A]: rosterOf(CAPTAIN_A, "Plugins", [
        member({ threadId: CREW_1, state: "needs-input", role: "Implement", task: "BBP-44" }),
        member({
          threadId: CREW_2,
          state: "working",
          role: "Review",
          task: "BBP-45",
          title: "Review row",
        }),
      ]),
    },
  });

  await waitFor(() => {
    expect(getResolvedHeaderBar(CREW_1).isEmpty).toBe(false);
  });

  expect(slot.container.innerHTML).toBe("");
  const resolved = getResolvedHeaderBar(CREW_1);
  expect(resolved.slots.lineage?.owner).toBe("captain");
  expect(resolved.slots.lineage?.priority).toBe(CAPTAIN_SEGMENT_PRIORITY);
  expect(resolved.slots.lineage?.label).toBe("Plugins");
  expect(resolved.slots.lineage?.tag).toBe("Implement");
  expect(resolved.slots.threads?.menu?.triggerLabel).toBe("2 crew");
  expect(resolved.slots.threads?.menu?.glyph).toEqual({ kind: "dot", tone: "warning" });

  act(() => {
    resolved.slots.lineage?.onClick?.();
  });
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
    method: "toThread",
    threadId: CAPTAIN_A,
  });

  const siblingItem = resolved.slots.threads?.menu?.items.find((item) => item.id === CREW_2);
  act(() => {
    siblingItem?.onSelect();
  });
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
    method: "toThread",
    threadId: CREW_2,
  });

  slot.unmount();
  expect(getResolvedHeaderBar(CREW_1).isEmpty).toBe(true);
});

test("captain thread publishes crew dropdown and conditional Overview action", async () => {
  const { openTabs } = renderHeader(CAPTAIN_A, {
    captains: [CAPTAIN_A],
    panelOpen: false,
    compactViewport: false,
    rosters: {
      [CAPTAIN_A]: rosterOf(CAPTAIN_A, "Plugins", [
        member({ threadId: CREW_1, state: "working", title: "Worker A" }),
      ]),
    },
  });

  await waitFor(() => {
    expect(getResolvedHeaderBar(CAPTAIN_A).slots.action).toBeDefined();
  });

  const resolved = getResolvedHeaderBar(CAPTAIN_A);
  expect(resolved.slots.lineage?.label).toBe("Captain");
  expect(resolved.slots.threads?.menu?.triggerLabel).toBe("1 crew");
  expect(resolved.slots.action?.label).toBe("Overview");

  act(() => {
    resolved.slots.action?.onClick?.();
  });
  expect(openTabs.at(-1)).toMatchObject({ tab: CAPTAIN_OVERVIEW_TAB });
});

test("captain thread publishes nothing when crew is empty and desktop side panel is open", async () => {
  const { calls } = renderHeader(CAPTAIN_A, {
    captains: [CAPTAIN_A],
    panelOpen: true,
    compactViewport: false,
    rosters: {
      [CAPTAIN_A]: rosterOf(CAPTAIN_A, "Plugins", []),
    },
  });

  await waitFor(() => {
    expect(calls.some((call) => call.method === "crewRoster")).toBe(true);
  });
  expect(getResolvedHeaderBar(CAPTAIN_A).isEmpty).toBe(true);
});

test("degraded crewRoster error retains back-to-captain lineage and Retry action", async () => {
  const { calls } = renderHeader(CREW_1, {
    captains: [CAPTAIN_A],
    crewOf: { [CREW_1]: CAPTAIN_A },
    rosters: { [CAPTAIN_A]: new Error("Tasks unavailable") },
  });

  await waitFor(() => {
    expect(getResolvedHeaderBar(CREW_1).slots.action?.label).toBe("Retry");
  });

  const resolved = getResolvedHeaderBar(CREW_1);
  expect(resolved.slots.lineage?.label).toBe("Captain");
  const before = calls.filter((call) => call.method === "crewRoster").length;
  act(() => {
    resolved.slots.action?.onClick?.();
  });
  await waitFor(() => {
    expect(calls.filter((call) => call.method === "crewRoster").length).toBeGreaterThan(before);
  });
});

test("split panes keep Captain A and Captain B segments isolated", async () => {
  renderHeader(CAPTAIN_A, {
    captains: [CAPTAIN_A, CAPTAIN_B],
    rosters: {
      [CAPTAIN_A]: rosterOf(CAPTAIN_A, "Alpha", [member({ threadId: CREW_1 })]),
    },
  });
  renderHeader(CAPTAIN_B, {
    captains: [CAPTAIN_A, CAPTAIN_B],
    rosters: {
      [CAPTAIN_B]: rosterOf(CAPTAIN_B, "Beta", [
        member({ threadId: CREW_1 }),
        member({ threadId: CREW_2 }),
      ]),
    },
  });

  await waitFor(() => {
    expect(getResolvedHeaderBar(CAPTAIN_A).slots.threads?.menu?.triggerLabel).toBe("1 crew");
    expect(getResolvedHeaderBar(CAPTAIN_B).slots.threads?.menu?.triggerLabel).toBe("2 crew");
  });
});
