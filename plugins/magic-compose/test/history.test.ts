import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import plugin from "../server";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

it("pages through every thread and reads each first turn, skipping threads it cannot read", async () => {
  const now = Date.now();
  // 501 threads: a full page and one more. Thread 0 is the newest.
  const threads = Array.from({ length: 501 }, (_, index) => ({
    id: `t${index}`,
    projectId: "p1",
    providerId: "claude-code",
    createdAt: now - index * 1_000,
    parentThreadId: null,
    visibility: "visible",
    deletedAt: null,
    originPluginId: null,
  }));
  const { bb, harness } = createFakePluginHost({
    pluginId: "magic-compose",
    sdk: {
      projects: { list: async () => [{ id: "p1", name: "bb", kind: "repository", sources: [] }] },
      threads: {
        list: async (args?: { limit?: number; offset?: number }) =>
          threads.slice(args?.offset ?? 0, (args?.offset ?? 0) + (args?.limit ?? 500)),
        events: {
          list: async (args: { threadId: string }) => {
            if (args.threadId === "t1") throw new Error("unreadable");
            const index = Number(args.threadId.slice(1));
            return [
              {
                data: {
                  initiator: "user",
                  input: [{ type: "text", text: `prompt  ${index}` }],
                  execution: { model: index % 2 === 0 ? "opus" : "sonnet", reasoningLevel: "high" },
                },
              },
            ];
          },
        },
      },
    },
  });
  disposals.push(() => harness.lifecycle.dispose());
  await plugin(bb);

  const result = await harness.behavior.runCli(["history", "--json"]);

  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout ?? "") as {
    threads: number;
    rows: { threadId: string; model: string; prompt: string; project: string }[];
  };
  expect(harness.inspection.sdk.callsTo("threads.list")).toEqual([
    [expect.objectContaining({ limit: 500, offset: 0 })],
    [expect.objectContaining({ limit: 500, offset: 500 })],
  ]);
  expect(report.threads).toBe(500); // 501, less the unreadable one
  expect(report.rows.slice(0, 3)).toEqual([
    expect.objectContaining({ threadId: "t0", model: "opus", prompt: "prompt 0", project: "bb" }),
    expect.objectContaining({ threadId: "t2", model: "opus" }),
    expect.objectContaining({ threadId: "t3", model: "sonnet" }),
  ]);
  expect(report.rows.at(-1)?.threadId).toBe("t500");
});
