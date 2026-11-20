// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RoutineRun, RoutineView } from "../contract/routines.ts";
import { captainContract, type SaveRoutineResult } from "../contract/rpc.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
const tab = app.tabs.find((each) => each.id === "overview")!;

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const NOW = Date.now();
let captains = 0;
/** A fresh Captain per test: the Routines UI state is kept per Captain for the page's life. */
const nextCaptain = () => `thr_captain${++captains}`;

const routine = (overrides: Partial<RoutineView> = {}): RoutineView => ({
  id: "r1",
  captainId: "thr_captain",
  name: "Stalled crew sweep",
  instruction: "Nudge each crew thread stalled over two hours.",
  schedule: { cron: "0 9 * * 1-5", timezone: "Europe/Berlin" },
  automationId: "auto_1",
  createdAt: NOW,
  updatedAt: NOW,
  firedAt: null,
  deliveredAt: null,
  when: "Every weekday at 9:00 AM",
  automation: { enabled: true, nextRunAt: NOW + 3_600_000, lastRunAt: null },
  automationError: null,
  done: false,
  missed: false,
  lastRun: null,
  ...overrides,
});

const paused = routine({
  id: "r2",
  name: "Friday digest",
  schedule: { cron: "0 16 * * 5", timezone: "UTC" },
  when: "Every Friday at 4:00 PM",
  automation: { enabled: false, nextRunAt: null, lastRunAt: null },
});

type Calls = { method: string; input: Record<string, unknown> }[];

function render(
  captainId: string,
  state: {
    routines: RoutineView[];
    runs?: RoutineRun[];
    save?: (input: Record<string, unknown>) => SaveRoutineResult;
    /** routineAction refuses with this message. */
    refuse?: string;
  },
) {
  const calls: Calls = [];
  const log = (method: string, input: unknown) =>
    calls.push({ method, input: input as Record<string, unknown> });
  const slot = renderSlot(tab as never, { threadId: captainId, environment: null } as never, {
    experimental_rpcContract: captainContract,
    pluginId: "captain",
    rpc: {
      captains: () => ({ ids: [captainId] }),
      asks: () => ({ items: [] }),
      tasks: () => ({ tasks: [], total: 0, truncated: false, crewError: null, unavailable: [] }),
      drive: () => ({ total: 0, truncated: false, files: [], folder: null }),
      routines: () => ({ routines: state.routines, serverTimezone: "UTC" }),
      routineRuns: (input: unknown) => (log("routineRuns", input), { runs: state.runs ?? [] }),
      routineAction: (input: { routineId: string; action: string }) => {
        log("routineAction", input);
        if (state.refuse !== undefined) throw new Error(state.refuse);
        if (input.action === "delete")
          state.routines = state.routines.filter((each) => each.id !== input.routineId);
        return { runId: input.action === "run" ? "arun_1" : null };
      },
      saveRoutine: (input: Record<string, unknown>) => {
        log("saveRoutine", input);
        return (
          state.save?.(input) ?? {
            ok: true,
            routine: routine({ id: "r9", name: String((input.routine as { name: string }).name) }),
          }
        );
      },
    } as never,
  });
  const routinesSection = () => slot.findByRole("region", { name: "Routines" });
  return { slot, calls, routinesSection };
}

test("a row shows its schedule in words and next run, or Paused, with a switch", async () => {
  const { routinesSection } = render(nextCaptain(), { routines: [routine(), paused] });
  const section = await routinesSection();
  await within(section).findByText("Stalled crew sweep");
  expect(section.textContent).toContain("Routines2");
  expect(section.textContent).toMatch(/Every weekday at 9:00 AM · next /u);
  const active = within(section).getByRole("switch", { name: "Stalled crew sweep: active" });
  expect(active.getAttribute("aria-checked")).toBe("true");
  const off = within(section).getByRole("switch", { name: "Friday digest: paused" });
  expect(off.getAttribute("aria-checked")).toBe("false");
  expect(within(section).getByText("Paused")).toBeTruthy();
});

test("the switch pauses at once, before the server answers", async () => {
  const { routinesSection, calls } = render(nextCaptain(), { routines: [routine()] });
  const section = await routinesSection();
  const toggle = await within(section).findByRole("switch", { name: /Stalled crew sweep/u });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  await waitFor(() =>
    expect(calls).toContainEqual({
      method: "routineAction",
      input: expect.objectContaining({ routineId: "r1", action: "pause" }),
    }),
  );
});

test("a row Automations did not answer says Schedule unavailable, its switch off, with Retry", async () => {
  const { routinesSection } = render(nextCaptain(), {
    routines: [
      routine({
        automation: null,
        automationError: "Schedule unavailable: bb Automations did not answer in time",
      }),
    ],
  });
  const section = await routinesSection();
  await within(section).findByText("Schedule unavailable");
  expect((within(section).getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(section).getByRole("button", { name: /Stalled crew sweep/u }));
  await within(section).findByText(/did not answer in time/u);
  within(section).getByRole("button", { name: "Retry" });
});

test("an opened routine shows its instruction, when to run and last runs; Test sends one", async () => {
  const captainId = nextCaptain();
  const { routinesSection, calls } = render(captainId, {
    routines: [routine()],
    runs: [
      { id: 2, routineId: "r1", trigger: "test", status: "sent", reason: null, at: NOW - 60_000 },
      {
        id: 1,
        routineId: "r1",
        trigger: "schedule",
        status: "skipped",
        reason: "previous run still queued",
        at: NOW - 86_400_000,
      },
    ],
  });
  const section = await routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: /Stalled crew sweep/u }));
  const panel = await within(section).findByTestId("captain-routine-panel");
  expect(panel.textContent).toContain("InstructionNudge each crew thread stalled over two hours.");
  expect(panel.textContent).toContain("When to runEvery weekday at 9:00 AM · Europe/Berlin");
  await within(panel).findByText(/Test · Sent/u);
  within(panel).getByText(/Scheduled · Skipped: previous run still queued/u);
  expect(calls).toContainEqual({
    method: "routineRuns",
    input: { captainId, routineId: "r1", limit: 5 },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Test" }));
  await within(panel).findByText(/Test sent/u);
});

test("Delete asks first, then removes the routine", async () => {
  const { routinesSection, calls } = render(nextCaptain(), { routines: [routine()] });
  const section = await routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: /Stalled crew sweep/u }));
  fireEvent.click(await within(section).findByRole("button", { name: "Delete" }));
  expect(calls.some((call) => call.method === "routineAction")).toBe(false);
  fireEvent.click(within(section).getByRole("button", { name: "Delete routine" }));
  await within(section).findByText(/Ask the Captain to set a routine/u);
  expect(calls).toContainEqual({
    method: "routineAction",
    input: expect.objectContaining({ routineId: "r1", action: "delete" }),
  });
});

test("the empty state's New routine opens the form; it creates with the browser's zone", async () => {
  const captainId = nextCaptain();
  const { routinesSection, calls } = render(captainId, { routines: [] });
  const section = await routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: "New routine" }));
  const form = await within(section).findByRole("form", { name: "New routine" });
  expect(document.activeElement).toBe(within(form).getByLabelText("Name"));
  expect(within(form).getByTestId("captain-routine-words").textContent).toMatch(
    /^When to run · Every weekday at 9:00 AM \(/u,
  );
  const create = within(form).getByRole("button", { name: "Create routine" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Sweep" } });
  fireEvent.change(within(form).getByLabelText("Instruction"), {
    target: { value: "Nudge stalled crew." },
  });
  fireEvent.click(create);
  await waitFor(() =>
    expect(calls).toContainEqual({
      method: "saveRoutine",
      input: {
        captainId,
        routine: {
          name: "Sweep",
          instruction: "Nudge stalled crew.",
          schedule: {
            cron: "0 9 * * 1-5",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        },
      },
    }),
  );
  await waitFor(() => expect(within(section).queryByRole("form")).toBeNull());
});

test("Edit prefills the routine, shows a custom cron in words as typed, and saves by id", async () => {
  const captainId = nextCaptain();
  const custom = routine({
    schedule: { cron: "30 8 1 * *", timezone: "Asia/Tokyo" },
    when: "Monthly on the 1st at 8:30 AM",
  });
  const { routinesSection, calls } = render(captainId, { routines: [custom] });
  const section = await routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: /Stalled crew sweep/u }));
  fireEvent.click(await within(section).findByRole("button", { name: "Edit" }));
  const form = await within(section).findByRole("form", { name: "Edit Stalled crew sweep" });
  expect((within(form).getByLabelText("Time zone") as HTMLInputElement).value).toBe("Asia/Tokyo");
  const cron = within(form).getByLabelText("Cron") as HTMLInputElement;
  expect(cron.value).toBe("30 8 1 * *");
  const words = within(form).getByTestId("captain-routine-words");
  expect(words.textContent).toBe("When to run · Monthly on the 1st at 8:30 AM (Asia/Tokyo)");
  fireEvent.change(cron, { target: { value: "*/5 * * * *" } });
  expect(words.textContent).toMatch(/runs 5 minutes apart/u);
  fireEvent.change(cron, { target: { value: "0 9 * * 1" } });
  expect(words.textContent).toBe("When to run · Every Monday at 9:00 AM (Asia/Tokyo)");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(calls).toContainEqual({
      method: "saveRoutine",
      input: expect.objectContaining({
        captainId,
        routineId: "r1",
        routine: expect.objectContaining({
          schedule: { cron: "0 9 * * 1", timezone: "Asia/Tokyo" },
        }),
      }),
    }),
  );
});

test("a refused save shows the server's reasons and keeps what was typed", async () => {
  const { routinesSection } = render(nextCaptain(), {
    routines: [routine()],
    save: () => ({
      ok: false,
      blockers: [
        { reason: 'routine r1 is already named "Stalled crew sweep"', fix: "pick another --name" },
      ],
    }),
  });
  const section = await routinesSection();
  await within(section).findByText("Stalled crew sweep");
  fireEvent.click(within(section).getByRole("button", { name: "New routine" }));
  const form = await within(section).findByRole("form", { name: "New routine" });
  fireEvent.change(within(form).getByLabelText("Name"), {
    target: { value: "Stalled crew sweep" },
  });
  fireEvent.change(within(form).getByLabelText("Instruction"), { target: { value: "Again." } });
  fireEvent.click(within(form).getByRole("button", { name: "Create routine" }));
  const alert = await within(form).findByRole("alert");
  expect(alert.textContent).toBe('Not saved · routine r1 is already named "Stalled crew sweep"');
  expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe(
    "Stalled crew sweep",
  );
});

test("the form keeps its text, focus and caret when bb remounts the tab", async () => {
  const captainId = nextCaptain();
  const first = render(captainId, { routines: [] });
  const section = await first.routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: "New routine" }));
  const instruction = (await within(section).findByLabelText("Instruction")) as HTMLTextAreaElement;
  instruction.focus();
  fireEvent.change(instruction, { target: { value: "Half typed" } });
  instruction.setSelectionRange(4, 4);
  fireEvent.select(instruction);
  cleanup();

  const again = render(captainId, { routines: [] });
  const restored = (await within(await again.routinesSection()).findByLabelText(
    "Instruction",
  )) as HTMLTextAreaElement;
  expect(restored.value).toBe("Half typed");
  await waitFor(() => expect(document.activeElement).toBe(restored));
  expect(restored.selectionStart).toBe(4);
});

test("a closed row shows its last run, a failure in red", async () => {
  const { routinesSection } = render(nextCaptain(), {
    routines: [
      routine({
        lastRun: {
          id: 3,
          routineId: "r1",
          trigger: "schedule",
          status: "skipped",
          reason: "previous run still queued",
          at: NOW - 60_000,
        },
      }),
    ],
  });
  const section = await routinesSection();
  await within(section).findByText(/^Last run .* · Skipped: previous run still queued$/u);
});

test("a refused switch says why under the closed row", async () => {
  const { routinesSection } = render(nextCaptain(), {
    routines: [routine()],
    refuse: "bb Automations did not take it: plugin automations is not running",
  });
  const section = await routinesSection();
  fireEvent.click(await within(section).findByRole("switch", { name: /Stalled crew sweep/u }));
  const alert = await within(section).findByRole("alert");
  expect(alert.textContent).toMatch(/did not take it/u);
  expect(within(section).queryByTestId("captain-routine-panel")).toBeNull();
  await waitFor(() =>
    expect(within(section).getByRole("switch").getAttribute("aria-checked")).toBe("true"),
  );
});

test("editing a one-shot's name sends its stored time back to the millisecond", async () => {
  const captainId = nextCaptain();
  // Off the whole minute, as `--in 90m` makes it.
  const at = NOW + 2 * 3_600_000 + 12_345;
  const { routinesSection, calls } = render(captainId, {
    routines: [routine({ schedule: { at }, when: "Once" })],
  });
  const section = await routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: /Stalled crew sweep/u }));
  fireEvent.click(await within(section).findByRole("button", { name: "Edit" }));
  const form = await within(section).findByRole("form", { name: "Edit Stalled crew sweep" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Renamed" } });
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(calls).toContainEqual({
      method: "saveRoutine",
      input: expect.objectContaining({
        routineId: "r1",
        routine: expect.objectContaining({ name: "Renamed", schedule: { at } }),
      }),
    }),
  );
});
