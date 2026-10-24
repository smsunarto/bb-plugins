import { expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
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
  await slot.findByText("Reconnecting · showing saved tasks");
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
