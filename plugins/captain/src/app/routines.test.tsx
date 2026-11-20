// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { routinesTag, type RoutineRun } from "../contract/routines.ts";
import { captainContract, type RoutineRow, type SaveRoutineResult } from "../contract/rpc.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
const tab = app.tabs.find((each) => each.id === "overview")!;

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const NOW = Date.now();
/** When the server takes a Test in these tests. */
const REQUESTED = NOW + 1_000;
let captains = 0;
/** A fresh Captain per test: the Routines UI state is kept per Captain for the page's life. */
const nextCaptain = () => `thr_captain${++captains}`;

const routine = (overrides: Partial<RoutineRow> = {}): RoutineRow => ({
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
  scheduleLoading: false,
  ...overrides,
});

/** A routine as a save returns it: the view without the list's loading flag. */
const saved = (overrides: Partial<RoutineRow>) => {
  const { scheduleLoading: _, ...view } = routine(overrides);
  return view;
};

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
    routines: RoutineRow[];
    runs?: RoutineRun[];
    save?: (input: Record<string, unknown>) => SaveRoutineResult | Promise<SaveRoutineResult>;
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
        return { runId: input.action === "run" ? "arun_1" : null, requestedAt: REQUESTED };
      },
      saveRoutine: (input: Record<string, unknown>) => {
        log("saveRoutine", input);
        return (
          state.save?.(input) ?? {
            ok: true,
            routine: saved({ id: "r9", name: String((input.routine as { name: string }).name) }),
          }
        );
      },
    } as never,
  });
  const routinesSection = () => slot.findByRole("region", { name: "Routines" });
  return { slot, calls, routinesSection, state };
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

test("an opened routine shows its instruction, when to run and last runs, each wrapped whole", async () => {
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
  const skipped = within(panel).getByText(/Scheduled · Skipped: previous run still queued/u);
  // The whole entry shows, wrapped, rather than clipped behind a hover title.
  expect(skipped.className).toContain("break-words");
  expect(skipped.className).not.toContain("truncate");
  expect(calls).toContainEqual({
    method: "routineRuns",
    input: { captainId, routineId: "r1", limit: 5 },
  });
});

test("Test shows requested until its run is recorded, then that run's result", async () => {
  const captainId = nextCaptain();
  const { routinesSection, slot, state } = render(captainId, {
    routines: [routine()],
    // An older test run must not count as this one's result.
    runs: [{ id: 1, routineId: "r1", trigger: "test", status: "sent", reason: null, at: NOW }],
  });
  const section = await routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: /Stalled crew sweep/u }));
  const panel = await within(section).findByTestId("captain-routine-panel");
  fireEvent.click(within(panel).getByRole("button", { name: "Test" }));
  const outcome = await within(panel).findByTestId("captain-routine-test");
  expect(outcome.textContent).toBe("Test requested · waiting for it to reach the Captain");
  state.runs = [
    {
      id: 2,
      routineId: "r1",
      trigger: "test",
      status: "skipped",
      reason: "previous run still queued",
      at: REQUESTED + 50,
    },
    ...(state.runs ?? []),
  ];
  await slot.behavior.experimental_invalidateRpc([routinesTag(captainId)]);
  await waitFor(() =>
    expect(within(panel).getByTestId("captain-routine-test").textContent).toBe(
      "Test skipped: previous run still queued",
    ),
  );
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
      stale: false,
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

test("a row whose live schedule is still loading shows its words, its switch waiting", async () => {
  const { routinesSection } = render(nextCaptain(), {
    routines: [routine({ automation: null, scheduleLoading: true })],
  });
  const section = await routinesSection();
  await within(section).findByText("Every weekday at 9:00 AM · loading schedule…");
  expect((within(section).getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
});

test("a stale edit is refused with Reload, which starts again from the routine as it is", async () => {
  const captainId = nextCaptain();
  const { routinesSection, calls, state, slot } = render(captainId, {
    routines: [routine()],
    save: () => ({
      ok: false,
      stale: true,
      blockers: [{ reason: "this routine changed elsewhere", fix: "reload" }],
    }),
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
      input: expect.objectContaining({ routineId: "r1", updatedAt: NOW }),
    }),
  );
  const alert = await within(form).findByRole("alert");
  expect(alert.textContent).toContain("changed elsewhere since you opened it");
  state.routines = [routine({ name: "Changed elsewhere", updatedAt: NOW + 5 })];
  await slot.behavior.experimental_invalidateRpc([routinesTag(captainId)]);
  await waitFor(() => expect(within(section).queryByText("Changed elsewhere")).not.toBeNull());
  fireEvent.click(within(alert).getByRole("button", { name: "Reload" }));
  const reloaded = await within(section).findByRole("form", { name: "Edit Changed elsewhere" });
  expect((within(reloaded).getByLabelText("Name") as HTMLInputElement).value).toBe(
    "Changed elsewhere",
  );
  expect(within(reloaded).queryByRole("alert")).toBeNull();
});

test("a save that finishes after its draft was replaced leaves the new draft alone", async () => {
  let finish: (result: SaveRoutineResult) => void = () => {};
  const { routinesSection } = render(nextCaptain(), {
    routines: [],
    save: () => new Promise<SaveRoutineResult>((resolve) => (finish = resolve)),
  });
  const section = await routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: "New routine" }));
  let form = await within(section).findByRole("form", { name: "New routine" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Draft A" } });
  fireEvent.change(within(form).getByLabelText("Instruction"), { target: { value: "A" } });
  fireEvent.click(within(form).getByRole("button", { name: "Create routine" }));
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(section).getAllByRole("button", { name: "New routine" })[0]!);
  form = await within(section).findByRole("form", { name: "New routine" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Draft B" } });
  finish({ ok: true, routine: saved({ id: "r9", name: "Draft A" }) });
  await new Promise((settle) => setTimeout(settle, 50));
  form = within(section).getByRole("form", { name: "New routine" });
  expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("Draft B");
});

test("a refusal stays with its draft when bb remounts the tab", async () => {
  const captainId = nextCaptain();
  const refusing = {
    routines: [] as RoutineRow[],
    save: (): SaveRoutineResult => ({
      ok: false,
      stale: false,
      blockers: [{ reason: "a Captain has at most 20 routines", fix: "remove one" }],
    }),
  };
  const first = render(captainId, refusing);
  const section = await first.routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: "New routine" }));
  const form = await within(section).findByRole("form", { name: "New routine" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "One more" } });
  fireEvent.change(within(form).getByLabelText("Instruction"), { target: { value: "x" } });
  fireEvent.click(within(form).getByRole("button", { name: "Create routine" }));
  await within(form).findByRole("alert");
  cleanup();
  const again = render(captainId, refusing);
  const alert = await within(await again.routinesSection()).findByRole("alert");
  expect(alert.textContent).toBe("Not saved · a Captain has at most 20 routines");
});

test("typing in the form re-renders no row", async () => {
  const captainId = nextCaptain();
  const many = Array.from({ length: 20 }, (_, index) =>
    routine({ id: `r${index + 1}`, name: `Routine ${index + 1}` }),
  );
  const { routinesSection } = render(captainId, { routines: many });
  const section = await routinesSection();
  await within(section).findByText("Routine 20");
  fireEvent.click(within(section).getAllByRole("button", { name: "New routine" })[0]!);
  const form = await within(section).findByRole("form", { name: "New routine" });
  // `format` is a getter on the prototype; count each read of it.
  const proto = Intl.DateTimeFormat.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "format")!;
  let reads = 0;
  Object.defineProperty(proto, "format", {
    ...original,
    get(this: Intl.DateTimeFormat) {
      reads += 1;
      return original.get!.call(this);
    },
  });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "S" } });
  await waitFor(() =>
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("S"),
  );
  // Each row formats its next run; none ran for a keystroke.
  Object.defineProperty(proto, "format", original);
  expect(reads).toBe(0);
});

test("editing a field clears the last refusal", async () => {
  const { routinesSection } = render(nextCaptain(), {
    routines: [],
    save: () => ({
      ok: false,
      stale: false,
      blockers: [{ reason: 'routine r1 is already named "Sweep"', fix: "rename" }],
    }),
  });
  const section = await routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: "New routine" }));
  const form = await within(section).findByRole("form", { name: "New routine" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Sweep" } });
  fireEvent.change(within(form).getByLabelText("Instruction"), { target: { value: "x" } });
  fireEvent.click(within(form).getByRole("button", { name: "Create routine" }));
  await within(form).findByRole("alert");
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Sweep 2" } });
  await waitFor(() => expect(within(form).queryByRole("alert")).toBeNull());
});

test("the form's fields lock while its save is on its way", async () => {
  let finish: (result: SaveRoutineResult) => void = () => {};
  const { routinesSection } = render(nextCaptain(), {
    routines: [],
    save: () => new Promise<SaveRoutineResult>((resolve) => (finish = resolve)),
  });
  const section = await routinesSection();
  fireEvent.click(await within(section).findByRole("button", { name: "New routine" }));
  const form = await within(section).findByRole("form", { name: "New routine" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Sweep" } });
  fireEvent.change(within(form).getByLabelText("Instruction"), { target: { value: "x" } });
  fireEvent.click(within(form).getByRole("button", { name: "Create routine" }));
  const instruction = within(form).getByLabelText("Instruction") as HTMLTextAreaElement;
  await waitFor(() => expect(instruction.closest("fieldset")?.disabled).toBe(true));
  finish({
    ok: false,
    stale: false,
    blockers: [{ reason: "refused", fix: "x" }],
  });
  await waitFor(() => expect(instruction.closest("fieldset")?.disabled).toBe(false));
});
