import { expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";

// The DOM must exist before the SDK's render harness is evaluated.
installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent } = await import("@testing-library/react");
const { experimental_PluginRpcCallError: PluginRpcCallError } =
  await import("@get-bb/plugin-sdk/app");

const sentEntry = {
  id: "e1",
  ts: "2026-11-02T10:00:00.000Z",
  action: "message",
  target_bot: "research",
  textPreview: "hello",
  context: { thread_id: "thr_1", project: "bb-plugins", branch: "scott/grokbot" },
  ok: true,
  status: 200,
  error: null,
  durationMs: 42,
};

function server(state: "ready" | "missing") {
  const entries: unknown[] = [];
  return {
    status: async () =>
      state === "ready"
        ? {
            state,
            configPath: "/home/scott/.config/bb-grokbot/config.json",
            bots: [{ id: "research", name: "Research" }],
          }
        : {
            state,
            configPath: "/home/scott/.config/bb-grokbot/config.json",
            reason: "No config file at /home/scott/.config/bb-grokbot/config.json.",
          },
    log: async () => ({ entries: [...entries] }),
    threadContext: async (input: unknown) => ({
      thread_id: (input as { threadId: string }).threadId,
      project: "bb-plugins",
      branch: "scott/grokbot",
      title: "Build grokbot",
    }),
    send: async () => {
      entries.unshift(sentEntry);
      return {
        outcome: { ok: true, status: 200, error: null, durationMs: 42 },
        entry: sentEntry,
        logged: true,
      };
    },
  };
}

async function registrations() {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const page = captured.navPanels.find((panel) => panel.id === "grokbot");
  const tab = captured.tabs.find((candidate) => candidate.id === "send-thread");
  expect(page?.path).toBe("grokbot");
  expect(tab?.availability).toBe("action");
  expect(tab?.context).toEqual({ kind: "thread" });
  return {
    page: { component: page!.component as ComponentType<PluginNavPanelProps> },
    tab: { component: tab!.component as ComponentType<{ threadId: string; params: null }> },
  };
}

test("a missing config shows the not-configured state and disables sending", async () => {
  const { page } = await registrations();
  const slot = renderSlot(page, { subPath: "" }, { rpc: server("missing") });
  await slot.findByText("Not configured");
  expect((slot.getByRole("button", { name: "Ping" }) as HTMLButtonElement).disabled).toBe(true);
  expect((slot.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  expect((slot.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
  slot.unmount();
});

test("the thread action sends the message with the picked bot and this thread's id", async () => {
  const { tab } = await registrations();
  const slot = renderSlot(tab, { threadId: "thr_1", params: null }, { rpc: server("ready") });
  await slot.findByText("Build grokbot");
  await slot.findByText("Configured");

  fireEvent.change(slot.getByLabelText("Target bot"), { target: { value: "research" } });
  fireEvent.change(slot.getByLabelText("Message"), { target: { value: "hello" } });
  fireEvent.click(slot.getByRole("button", { name: "Send thread" }));

  await slot.findByText("Message sent · HTTP 200 · 42ms");
  expect(slot.rpcCalls.filter((call) => call.method === "send").map((call) => call.input)).toEqual([
    { action: "message", targetBot: "research", text: "hello", threadId: "thr_1" },
  ]);
  slot.unmount();
});

test("a refused send says not sent; a lost response says delivery is unknown", async () => {
  const { page } = await registrations();
  const failures = [
    new PluginRpcCallError({ code: "invalid", message: 'Unknown bot "nope"' }),
    new PluginRpcCallError({ code: "transport_error", message: "Network request failed" }),
  ];
  const rpc = {
    ...server("ready"),
    send: async () => {
      throw failures.shift();
    },
  };
  const slot = renderSlot(page, { subPath: "" }, { rpc });
  await slot.findByText("Configured");

  fireEvent.click(slot.getByRole("button", { name: "Ping" }));
  await slot.findByText('Not sent: Unknown bot "nope"');
  fireEvent.click(slot.getByRole("button", { name: "Ping" }));
  await slot.findByText(
    "Delivery unknown: Network request failed · Check Recent sends before sending again",
  );
  slot.unmount();
});
