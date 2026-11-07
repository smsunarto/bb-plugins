// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { BOTS_PLUGIN_ID, BOT_TAGS, rpcContract } from "../contract";
import { ThreadBotPromptSection } from "../components/thread-bot-picker";

afterEach(cleanup);
const prompt = (botId: string | null) => ({ botId, tools: [], skills: [], sections: [] });
const memory = (botId: string, content = "Remember the user's preference.") => ({
  botId,
  file: "MEMORY.md",
  content,
  sha256: "a".repeat(64),
});
const routine = {
  id: "routine",
  botId: "bot",
  name: "Morning check",
  instruction: "Report only when something needs attention.",
  cron: "0 9 * * 1-5",
  timezone: "America/Los_Angeles",
  projectId: "project",
  automationId: "automation",
  threadId: null,
  createdAt: 1,
  updatedAt: 1,
  automationError: null,
  automation: {
    enabled: true,
    nextRunAt: Date.now() + 3_600_000,
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    runCount: 0,
  },
};
const options = {
  pluginId: BOTS_PLUGIN_ID,
  experimental_rpcContract: rpcContract,
  rpc: {
    thread_bot_prompt: () => prompt("bot"),
    state_read: () => memory("bot"),
    skills_list: () => ({
      skills: [{ name: "release-notes", description: "Write useful release notes." }],
    }),
    skill_read: () => ({
      name: "release-notes",
      content: "Read the diff before drafting notes.",
      sha256: "b".repeat(64),
    }),
    routines_list: () => ({ routines: [routine], projects: [] }),
  },
};

it("shows the selected bot's memory, skill and routine, reading skill content only on expansion", async () => {
  const slot = renderSlot(
    { component: ThreadBotPromptSection },
    { threadId: "chat", projectId: "project", environment: null },
    options,
  );
  await screen.findByText("Remember the user's preference.");
  expect(screen.getByText("release-notes")).toBeTruthy();
  expect(screen.getByText("Morning check")).toBeTruthy();
  expect(screen.getByText(/Next in/)).toBeTruthy();
  expect(slot.rpcCalls.some((call) => call.method === "skill_read")).toBe(false);
  fireEvent.click(screen.getByText("release-notes"));
  await screen.findByText("Read the diff before drafting notes.");
  expect(slot.rpcCalls.find((call) => call.method === "skill_read")?.input).toEqual({
    botId: "bot",
    name: "release-notes",
  });
  fireEvent.click(screen.getByText("Morning check"));
  expect(screen.getByText(routine.instruction)).toBeTruthy();
  slot.unmount();
});

it("keeps memory and routines usable while the skills host fails, with an explicit retry", async () => {
  let fail = true;
  const slot = renderSlot(
    { component: ThreadBotPromptSection },
    { threadId: "chat", projectId: "project", environment: null },
    {
      ...options,
      rpc: {
        ...options.rpc,
        skills_list: () => {
          if (fail) throw new Error("Host offline");
          return { skills: [] };
        },
      },
    },
  );
  await screen.findByText("Could not load skills.");
  expect(screen.getByText("Remember the user's preference.")).toBeTruthy();
  expect(screen.getByText("Morning check")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No skills yet.");
  slot.unmount();
});

it("refreshes memory on bot invalidation and retains cached data when refreshing fails", async () => {
  let content = "Original memory";
  let fail = false;
  const slot = renderSlot(
    { component: ThreadBotPromptSection },
    { threadId: "chat", projectId: "project", environment: null },
    {
      ...options,
      rpc: {
        ...options.rpc,
        state_read: () => {
          if (fail) throw new Error("Disconnected");
          return memory("bot", content);
        },
      },
    },
  );
  await screen.findByText("Original memory");
  content = "Updated memory";
  await slot.behavior.experimental_invalidateRpc([BOT_TAGS.bots]);
  await screen.findByText("Updated memory");
  fail = true;
  await slot.behavior.experimental_invalidateRpc([BOT_TAGS.bots]);
  await screen.findByText("Could not refresh memory. Showing saved data.");
  expect(screen.getByText("Updated memory")).toBeTruthy();
  slot.unmount();
});

it("rejects late results from the previous bot when switching conversations", async () => {
  let resolveOld: (value: ReturnType<typeof memory>) => void = () => {};
  const old = new Promise<ReturnType<typeof memory>>((resolve) => {
    resolveOld = resolve;
  });
  const slot = renderSlot(
    { component: ThreadBotPromptSection },
    { threadId: "old", projectId: "project", environment: null },
    {
      ...options,
      rpc: {
        ...options.rpc,
        thread_bot_prompt: (input) =>
          prompt(rpcContract.thread_bot_prompt.input.parse(input).threadId),
        state_read: (input) =>
          rpcContract.state_read.input.parse(input).botId === "old"
            ? old
            : memory("new", "New bot memory"),
        skills_list: () => ({ skills: [] }),
        routines_list: () => ({ routines: [], projects: [] }),
      },
    },
  );
  await waitFor(() =>
    expect(slot.rpcCalls.some((call) => call.method === "state_read")).toBe(true),
  );
  slot.rerender(<ThreadBotPromptSection threadId="new" projectId="project" environment={null} />);
  await screen.findByText("New bot memory");
  await act(async () => resolveOld(memory("old", "Old private memory")));
  await waitFor(() => expect(screen.queryByText("Old private memory")).toBeNull());
  expect(screen.getByText("New bot memory")).toBeTruthy();
  slot.unmount();
});

it("shows no private resource sections for an unassigned conversation", async () => {
  const slot = renderSlot(
    { component: ThreadBotPromptSection },
    { threadId: "chat", projectId: "project", environment: null },
    {
      ...options,
      rpc: { ...options.rpc, thread_bot_prompt: () => prompt(null) },
    },
  );
  await waitFor(() =>
    expect(slot.rpcCalls.some((call) => call.method === "thread_bot_prompt")).toBe(true),
  );
  expect(
    slot.rpcCalls.some((call) =>
      ["state_read", "skills_list", "routines_list"].includes(call.method),
    ),
  ).toBe(false);
  expect(screen.queryByText("Memory")).toBeNull();
  slot.unmount();
});
