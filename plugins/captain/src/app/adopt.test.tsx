// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { captainContract, type AdoptOptions } from "../contract/rpc.ts";
import { adoptItem, openAdopt } from "./adopt.tsx";

const app = await loadPluginApp(() => import("./app.tsx"));
const overlay = app.appOverlays.find((each) => each.id === "adopt")!;

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
const live = new Set([CAPTAIN]);

test("the action is registered for every thread menu", () => {
  const registration = app.threadActions.find((each) => each.id === "adopt");
  expect(registration).toMatchObject({ title: "Adopt into Captain…" });
  expect(registration?.placement ?? "menu").toBe("menu");
});

test("hidden with no live Captain and on a Captain; disabled on a Captain's crew", () => {
  expect(adoptItem({ thread: target(), data: null })).toBeNull();
  expect(adoptItem({ thread: target(), data: new Set() })).toBeNull();
  expect(adoptItem({ thread: target({ id: CAPTAIN }), data: live })).toBeNull();
  expect(adoptItem({ thread: target({ parentThreadId: CAPTAIN }), data: live })).toMatchObject({
    disabled: true,
    detail: "Already a Captain's crew",
  });
  expect(adoptItem({ thread: target({ archivedAt: 1 }), data: live })?.disabled).toBe(true);
  // A child of a thread that is not a Captain can be adopted.
  expect(adoptItem({ thread: target({ parentThreadId: "thr_other" }), data: live })).toMatchObject({
    label: "Adopt into Captain…",
  });
  expect(adoptItem({ thread: target(), data: live })?.disabled).toBeUndefined();
});

const options: AdoptOptions = {
  thread: { id: "thr_side", title: "Fix the sidebar flicker", projectId: "proj_plugins" },
  captains: [
    {
      id: CAPTAIN,
      name: "Plugins",
      repos: [{ key: "BBP", name: "bb-plugins", bbProjectId: "proj_plugins" }],
      tasks: [{ key: "BBP-1", title: "Render PR images", status: "todo" }],
      blockers: [],
    },
  ],
  roles: [
    { value: "plan", label: "Plan" },
    { value: "implement", label: "Implement" },
    { value: "review", label: "Review" },
  ],
  tasksError: null,
};

function render(adoptOptions: AdoptOptions = options) {
  const calls: { method: string; input: unknown }[] = [];
  const slot = renderSlot(overlay, {} as never, {
    experimental_rpcContract: captainContract,
    rpc: {
      adoptOptions: (input: unknown) => {
        calls.push({ method: "adoptOptions", input });
        return adoptOptions;
      },
      adopt: (input: unknown) => {
        calls.push({ method: "adopt", input });
        return {
          ok: true,
          task: "BBP-2",
          created: true,
          state: "adopted",
          adopted: true,
          detail: "contract on first tell",
          blockers: [],
          warnings: ["warning: thr_side runs in auto permission mode"],
        };
      },
    } as never,
  });
  return { slot, calls };
}

test("the overlay reads nothing until the action opens it", async () => {
  const { slot, calls } = render();
  await new Promise((settle) => setTimeout(settle, 20));
  expect(calls).toEqual([]);
  expect(slot.queryByRole("dialog")).toBeNull();
});

test("Adopt defaults to a new task from the thread's title as Implement and calls adopt", async () => {
  const { slot, calls } = render();
  act(() => openAdopt("thr_side"));
  const title = (await slot.findByLabelText("Title")) as HTMLInputElement;
  expect(calls[0]).toEqual({ method: "adoptOptions", input: { threadId: "thr_side" } });
  expect(title.value).toBe("Fix the sidebar flicker");
  // One Captain: no Captain picker.
  expect(slot.queryByLabelText("Captain")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Adopt" }));
  await slot.findByText(/Adopted into Plugins as Implement on BBP-2 \(new task\)/u);
  slot.getByText("warning: thr_side runs in auto permission mode");
  expect(calls.find((call) => call.method === "adopt")?.input).toEqual({
    captainId: CAPTAIN,
    threadId: "thr_side",
    role: "implement",
    task: { kind: "new", projectKey: "BBP", title: "Fix the sidebar flicker" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
});

test("a Captain that cannot take the thread shows why, and Adopt stays off", async () => {
  const blocked: AdoptOptions = {
    ...options,
    captains: [
      {
        ...options.captains[0]!,
        blockers: [{ reason: "thr_side is a fork", fix: "start a new thread" }],
      },
    ],
  };
  const { slot, calls } = render(blocked);
  act(() => openAdopt("thr_side"));
  await slot.findByText("thr_side is a fork");
  expect((slot.getByRole("button", { name: "Adopt" }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some((call) => call.method === "adopt")).toBe(false);
  act(() => fireEvent.click(slot.getByRole("button", { name: "Cancel" })));
});
