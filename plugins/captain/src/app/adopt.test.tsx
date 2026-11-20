// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { captainContract, type AdoptOptions, type AdoptResult } from "../contract/rpc.ts";
import { openAdopt, type AdoptData } from "./adopt.tsx";

Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

const app = await loadPluginApp(() => import("./app.tsx"));
const overlay = app.appOverlays.find((each) => each.id === "adopt")!;
const registration = app.threadActions.find((each) => each.id === "adopt")!;

afterEach(cleanup);

const CAPTAIN = "thr_captain";
const target = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "thr_side",
    projectId: "proj_plugins",
    parentThreadId: null,
    archivedAt: null,
    ...overrides,
  }) as never;
const data = (crewOf: Record<string, string | null> = {}): AdoptData => ({
  captains: new Set([CAPTAIN]),
  crewOf,
});
const item = (thread: never, value: AdoptData | null) =>
  registration.item({ thread, data: value } as never);

test("the action is registered for every thread menu", () => {
  expect(registration).toMatchObject({ title: "Adopt into Captain…", icon: "UserRoundPlus" });
  expect(registration.placement ?? "menu").toBe("menu");
});

test("hidden with no live Captain and on a Captain; disabled on crew on a task and archived", () => {
  expect(item(target(), null)).toBeNull();
  expect(item(target(), { captains: new Set(), crewOf: {} })).toBeNull();
  expect(item(target({ id: CAPTAIN }), data())).toBeNull();
  expect(item(target({ parentThreadId: CAPTAIN }), data({ thr_side: CAPTAIN }))).toMatchObject({
    disabled: true,
    detail: "Already a Captain's crew",
  });
  expect(item(target({ archivedAt: 1 }), data())).toMatchObject({ disabled: true });
  // A Captain's child on no task, such as a half-finished adopt, can be adopted.
  expect(item(target({ parentThreadId: CAPTAIN }), data({ thr_side: null }))?.disabled).toBe(
    undefined,
  );
  expect(item(target({ parentThreadId: "thr_other" }), data())?.disabled).toBeUndefined();
});

const captain = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name,
  repos: [{ key: "BBP", name: "bb-plugins", bbProjectId: "proj_plugins" }],
  tasks: [
    { key: "BBP-1", title: "Render PR images", status: "todo", held: [] },
    { key: "BBP-4", title: "Taken task", status: "todo", held: ["implement" as const] },
  ],
  blockers: [],
  ...overrides,
});
const base: AdoptOptions = {
  thread: { id: "thr_side", title: "Fix the sidebar flicker", projectId: "proj_plugins" },
  captains: [captain(CAPTAIN, "Plugins")],
  roles: [
    { value: "implement", label: "Implement" },
    { value: "review", label: "Review" },
  ],
  tasksError: null,
};
const adopted: AdoptResult = {
  ok: true,
  task: "BBP-2",
  created: true,
  detail: "contract on first tell",
  warnings: [],
};

type State = { options: AdoptOptions; adopt?: (input: unknown) => unknown };

function render(state: State = { options: base }) {
  const calls: { method: string; input: unknown }[] = [];
  const slot = renderSlot(overlay, {} as never, {
    experimental_rpcContract: captainContract,
    rpc: {
      adoptOptions: (input: unknown) => {
        calls.push({ method: "adoptOptions", input });
        return state.options;
      },
      adopt: (input: unknown) => {
        calls.push({ method: "adopt", input });
        return state.adopt === undefined ? adopted : state.adopt(input);
      },
    } as never,
  });
  const adoptInput = () => calls.find((call) => call.method === "adopt")?.input;
  return { slot, calls, adoptInput };
}

type Slot = ReturnType<typeof render>["slot"];

async function open(slot: Slot, threadId = "thr_side") {
  act(() => openAdopt(threadId));
  await slot.findByRole("button", { name: "Adopt" });
}

/** Open a picker by its label and choose the option with this name. */
async function choose(slot: Slot, label: string, option: string | RegExp) {
  const trigger = slot.getByLabelText(label);
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await slot.findByRole("option", { name: option }));
  await waitFor(() => expect(slot.queryByRole("listbox")).toBeNull());
}

const close = (slot: Slot) =>
  act(() => fireEvent.click(slot.getByRole("button", { name: /Cancel|Done/u })));

test("the overlay reads nothing until the action opens it", async () => {
  const { slot, calls } = render();
  await new Promise((settle) => setTimeout(settle, 20));
  expect(calls).toEqual([]);
  expect(slot.queryByRole("dialog")).toBeNull();
});

test("defaults to a new task from the title as Implement; focus moves to the form, then Done", async () => {
  const { slot, adoptInput } = render();
  await open(slot);
  expect((slot.getByLabelText("Title") as HTMLInputElement).value).toBe("Fix the sidebar flicker");
  // One Captain: no Captain picker; focus is on the first field, not Close.
  expect(slot.queryByLabelText("Captain")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(slot.getByLabelText("Task")));
  fireEvent.click(slot.getByRole("button", { name: "Adopt" }));
  await slot.findByText(/Adopted into Plugins as Implement on BBP-2 \(new task\)/u);
  expect(adoptInput()).toEqual({
    captainId: CAPTAIN,
    threadId: "thr_side",
    role: "implement",
    task: { kind: "new", projectKey: "BBP", title: "Fix the sidebar flicker" },
  });
  await waitFor(() =>
    expect(document.activeElement).toBe(slot.getByRole("button", { name: "Done" })),
  );
  close(slot);
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
});

test("picks an existing task and another role", async () => {
  const { slot, adoptInput } = render({
    options: base,
    adopt: () => ({ ...adopted, task: "BBP-1", created: false }),
  });
  await open(slot);
  await choose(slot, "Task", /BBP-1 · Render PR images/u);
  expect(slot.queryByLabelText("Title")).toBeNull();
  await choose(slot, "Role", "Review");
  fireEvent.click(slot.getByRole("button", { name: "Adopt" }));
  await slot.findByText(/Adopted into Plugins as Review on BBP-1\./u);
  expect(adoptInput()).toMatchObject({ role: "review", task: { kind: "existing", key: "BBP-1" } });
  close(slot);
});

test("a task with a live thread in the role is disabled, with the reason", async () => {
  const { slot } = render();
  await open(slot);
  const trigger = slot.getByLabelText("Task");
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const taken = await slot.findByRole("option", { name: /BBP-4 · Taken task/u });
  expect(taken.getAttribute("aria-disabled")).toBe("true");
  expect(taken.textContent).toContain("Has a live Implement thread");
  fireEvent.keyDown(taken, { key: "Escape" });
  close(slot);
});

test("with two Captains, the picker chooses which one", async () => {
  const options = { ...base, captains: [captain(CAPTAIN, "Plugins"), captain("thr_b", "Rampage")] };
  const { slot, adoptInput } = render({ options });
  await open(slot);
  await waitFor(() => expect(document.activeElement).toBe(slot.getByLabelText("Captain")));
  await choose(slot, "Captain", "Rampage");
  fireEvent.click(slot.getByRole("button", { name: "Adopt" }));
  await slot.findByText(/Adopted into Rampage as Implement/u);
  expect(adoptInput()).toMatchObject({ captainId: "thr_b" });
  close(slot);
});

test("success names what was submitted, and fields are locked while the adopt runs", async () => {
  let finish: (value: AdoptResult) => void = () => {};
  const { slot } = render({
    options: base,
    adopt: () => new Promise<AdoptResult>((resolve) => (finish = resolve)),
  });
  await open(slot);
  fireEvent.click(slot.getByRole("button", { name: "Adopt" }));
  await slot.findByRole("button", { name: "Adopting…" });
  expect(slot.getByLabelText("Role").matches(":disabled")).toBe(true);
  expect(slot.getByLabelText("Title").matches(":disabled")).toBe(true);
  await act(async () => finish(adopted));
  await slot.findByText(/as Implement on BBP-2/u);
  close(slot);
});

test("a refusal shows its blockers; a call failure shows its message", async () => {
  const refusal: AdoptResult = {
    ok: false,
    blockers: [
      {
        reason: "BBP-1 already has a live Implement thread, thr_x",
        fix: "pick another task or role",
      },
    ],
  };
  const state: State = { options: base, adopt: () => refusal };
  const { slot } = render(state);
  await open(slot);
  fireEvent.click(slot.getByRole("button", { name: "Adopt" }));
  const alert = await slot.findByRole("alert");
  expect(alert.textContent).toContain("already has a live Implement thread");
  expect(alert.textContent).toContain("pick another task or role");
  expect(alert.textContent).not.toContain("--again");

  state.adopt = () => {
    throw new Error("bb did not answer");
  };
  fireEvent.click(slot.getByRole("button", { name: "Adopt" }));
  await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("bb did not answer"));
  close(slot);
});

test("a Captain that cannot take the thread shows why, and Adopt stays off", async () => {
  const blocked = {
    ...base,
    captains: [
      captain(CAPTAIN, "Plugins", {
        blockers: [{ reason: "thr_side is a fork", fix: "start a new crew thread" }],
      }),
    ],
  };
  const { slot, calls } = render({ options: blocked });
  await open(slot);
  await slot.findByText("thr_side is a fork");
  expect((slot.getByRole("button", { name: "Adopt" }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some((call) => call.method === "adopt")).toBe(false);
  close(slot);
});

// Review findings 7 and 9 on 8f210e0, from its repro tests.
test("a title over the limit is clamped, so Adopt sends a valid one", async () => {
  const long = "x".repeat(260);
  const { slot, adoptInput } = render({
    options: { ...base, thread: { ...base.thread, title: long } },
  });
  await open(slot);
  expect((slot.getByLabelText("Title") as HTMLInputElement).value).toHaveLength(200);
  fireEvent.click(slot.getByRole("button", { name: "Adopt" }));
  await slot.findByText(/Adopted into/u);
  expect(adoptInput()).toMatchObject({ task: { title: "x".repeat(200) } });
  close(slot);
});

test("each open reads fresh options: a renamed thread's new title reaches the field", async () => {
  const state: State = { options: base };
  const { slot, calls } = render(state);
  await open(slot);
  close(slot);
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());

  state.options = { ...base, thread: { ...base.thread, title: "Stop the flicker on resize" } };
  await open(slot);
  expect((slot.getByLabelText("Title") as HTMLInputElement).value).toBe(
    "Stop the flicker on resize",
  );
  expect(calls.filter((call) => call.method === "adoptOptions")).toHaveLength(2);
  close(slot);
});

test("a picked Captain archived while open falls back to a live one", async () => {
  const state: State = {
    options: { ...base, captains: [captain(CAPTAIN, "Plugins"), captain("thr_b", "Rampage")] },
  };
  const { slot } = render(state);
  await open(slot);
  state.options = { ...base, captains: [captain("thr_b", "Rampage")] };
  await slot.experimental_invalidateRpc(["captains"]);
  await waitFor(() => expect(slot.queryByLabelText("Captain")).toBeNull());
  expect(slot.queryByText(/No live Captain/u)).toBeNull();
  expect(slot.getByRole("button", { name: "Adopt" })).toBeTruthy();
  close(slot);
});
