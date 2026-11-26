import { expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import { RPIV_TODO_CHANNEL } from "../src/shared/rpiv-todo.ts";
installDom();
const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { TodoBanner } = await import("../src/app/rpiv-todo/banner.tsx");
const result = (text: string) => ({
  items: [{ id: "1", text, status: "pending" }],
  truncated: false,
});

test("registers the RPIV banner for thread and queue composers, which include side chats", async () => {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  expect(app.composerCustomizations.find(({ id }) => id === "rpiv-todo")?.scopes).toEqual([
    "thread",
    "queued-message",
  ]);
});

test("rejects stale responses across thread switches and refreshes after reconnect", async () => {
  let resolveOld: (value: ReturnType<typeof result>) => void = () => {};
  const old = new Promise<ReturnType<typeof result>>((resolve) => {
    resolveOld = resolve;
  });
  let current = "Current task";
  const slot = renderSlot(
    { component: TodoBanner },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "old" } },
      sdk: { subscribe: () => () => {} },
      rpc: {
        getRpivTodos: (input: unknown) =>
          input && typeof input === "object" && "threadId" in input && input.threadId === "old"
            ? old
            : Promise.resolve(result(current)),
      },
    },
  );
  await slot.behavior.setComposerScope({ kind: "thread", threadId: "new" });
  await slot.findByText("#1 Current task");
  await act(async () => resolveOld(result("Stale task")));
  expect(slot.queryByText("#1 Stale task")).toBeNull();
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  expect(slot.queryByRole("status")).toBeNull();
  expect(slot.queryByText(/Reconnecting|Connecting/)).toBeNull();
  expect(slot.getByText("#1 Current task")).toBeDefined();
  current = "Refreshed task";
  await slot.behavior.setRealtimeConnectionState("connected");
  await slot.findByText("#1 Refreshed task");
  slot.unmount();
});

test("sorts active tasks first and keeps the manual collapsed state on refresh", async () => {
  const slot = renderSlot(
    { component: TodoBanner },
    {},
    {
      sdk: { subscribe: () => () => {} },
      // A side chat's ThreadChat composer reports its own thread.
      composer: { scope: { kind: "thread", threadId: "side" } },
      rpc: {
        getRpivTodos: () => ({
          items: [
            { id: "1", text: "Done", status: "completed" },
            { id: "2", text: "Current", status: "in_progress", activeForm: "Inspecting" },
          ],
          truncated: false,
        }),
      },
    },
  );
  const button = await slot.findByRole("button", { name: /To-do list/ });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(slot.container.querySelector("li")?.textContent).toContain("#2 Current");
  fireEvent.click(button);
  expect(slot.container.querySelector("section")?.hasAttribute("inert")).toBe(true);
  await slot.behavior.emitRealtime(RPIV_TODO_CHANNEL, { threadId: "side" });
  await waitFor(() => expect(button.getAttribute("aria-expanded")).toBe("false"));
  slot.unmount();
});

test("an idle context clear refreshes the banner through the public SDK subscription", async () => {
  let notify = () => {};
  let cleared = false;
  let unsubscribed = false;
  const slot = renderSlot(
    { component: TodoBanner },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "clear-test" } },
      sdk: {
        subscribe: (input: unknown) => {
          if (
            input &&
            typeof input === "object" &&
            "callback" in input &&
            typeof input.callback === "function"
          ) {
            const callback = input.callback;
            notify = () =>
              callback({
                entity: "thread",
                id: "clear-test",
                changes: ["events-appended"],
                metadata: { eventTypes: ["system/operation"] },
              });
          }
          return () => {
            unsubscribed = true;
          };
        },
      },
      rpc: { getRpivTodos: () => (cleared ? { items: [], truncated: false } : result("Old task")) },
    },
  );
  await slot.findByText("#1 Old task");
  cleared = true;
  await act(async () => notify());
  await waitFor(() => expect(slot.queryByText("#1 Old task")).toBeNull());
  slot.unmount();
  expect(unsubscribed).toBe(true);
});

test("renders nothing on initial load failure with no tasks, and keeps loaded tasks with retry on refresh failure", async () => {
  let fail = true;
  const slot = renderSlot(
    { component: TodoBanner },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "empty-error" } },
      sdk: { subscribe: () => () => {} },
      rpc: {
        getRpivTodos: () => {
          if (fail) throw new Error("offline");
          return result("Loaded task");
        },
      },
    },
  );
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
  await act(async () => {});
  // No banner pops up when loading fails before any real tasks exist.
  expect(slot.container.childNodes).toHaveLength(0);

  // Once real tasks load, a later refresh failure keeps the tasks visible and shows Retry.
  fail = false;
  await slot.behavior.emitRealtime(RPIV_TODO_CHANNEL, { threadId: "empty-error" });
  await slot.findByText("#1 Loaded task");

  fail = true;
  await slot.behavior.emitRealtime(RPIV_TODO_CHANNEL, { threadId: "empty-error" });
  await slot.findByRole("button", { name: "Retry" });
  expect(slot.getByText("#1 Loaded task")).toBeDefined();
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  expect(slot.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(slot.getByText("#1 Loaded task")).toBeDefined();
  slot.unmount();
});

test("renders nothing while paging an empty truncated snapshot and shows no loading notice", async () => {
  const slot = renderSlot(
    { component: TodoBanner },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "truncated-loading" } },
      sdk: { subscribe: () => () => {} },
      rpc: { getRpivTodos: () => ({ items: [], truncated: true }) },
    },
  );
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
  await act(async () => {});
  expect(slot.queryByText(/Loading task history/)).toBeNull();
  expect(slot.container.childNodes).toHaveLength(0);
  slot.unmount();
});

test("keeps Loading task history notice when visible tasks are truncated", async () => {
  const slot = renderSlot(
    { component: TodoBanner },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "truncated-visible" } },
      sdk: { subscribe: () => () => {} },
      rpc: {
        getRpivTodos: () => ({
          items: [{ id: "1", text: "Visible task", status: "in_progress" }],
          truncated: true,
        }),
      },
    },
  );
  await slot.findByText("#1 Visible task");
  expect(slot.getByText(/Loading task history/)).toBeDefined();
  slot.unmount();
});

test("retries automatically on an idle thread when initial RPC fails while empty", async () => {
  let attempts = 0;
  const slot = renderSlot(
    { component: TodoBanner },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "idle-retry" }, isRunning: false },
      sdk: { subscribe: () => () => {} },
      rpc: {
        getRpivTodos: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient failure");
          return result("Recovered task");
        },
      },
    },
  );
  await waitFor(() => expect(attempts).toBe(1));
  // Never pops up a banner while empty and retrying.
  expect(slot.container.childNodes).toHaveLength(0);

  // Automatic bounded retry recovers without requiring realtime events or a Retry button.
  await waitFor(() => expect(slot.queryByText("#1 Recovered task")).not.toBeNull(), {
    timeout: 3000,
  });
  expect(attempts).toBe(2);
  slot.unmount();
});

/** A press the browser may not turn into a focus change, so a phone keeps the composer's keyboard up. */
function expectPressKeepsFocus(control: HTMLElement) {
  expect(fireEvent.pointerDown(control)).toBe(false);
  expect(fireEvent.mouseDown(control)).toBe(false);
}

test("pressing the to-do toggle or Retry leaves focus in the composer", async () => {
  let fail = false;
  const slot = renderSlot(
    { component: TodoBanner },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "keep-focus" } },
      sdk: { subscribe: () => () => {} },
      rpc: {
        getRpivTodos: () => {
          if (fail) throw new Error("offline");
          return result("Task");
        },
      },
    },
  );
  const toggle = await slot.findByRole("button", { name: /To-do list/ });
  fail = true;
  await slot.behavior.emitRealtime(RPIV_TODO_CHANNEL, { threadId: "keep-focus" });
  const retry = await slot.findByRole("button", { name: "Retry" });
  expectPressKeepsFocus(retry);
  fail = false;
  fireEvent.click(retry);
  await waitFor(() => expect(slot.queryByRole("button", { name: "Retry" })).toBeNull());
  expectPressKeepsFocus(toggle);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  slot.unmount();
});
