import { expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import { requestSchema } from "../../shared/review.ts";
import { ReviewService } from "../lib/review-service.ts";

const signal = new AbortController().signal;
const models = async () => ({ claudeModel: "claude-test", codexModel: "gpt-test" });
const pinned = {
  repositoryPath: "/repo",
  branch: "scott/feature",
  base: "a".repeat(40),
  head: "b".repeat(40),
};
const request = requestSchema.parse({
  summary: "Simplify review",
  target: { branch: "scott/feature" },
});
const environment = { id: "env", hostId: "host", path: "/repo", status: "ready" };
type Spawn = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

function fixture() {
  const threads = new Map([
    [
      "parent",
      makeThreadResponse({
        id: "parent",
        projectId: "project",
        environmentId: "env",
        providerId: "codex",
      }),
    ],
    [
      "stranger",
      makeThreadResponse({ id: "stranger", projectId: "project", environmentId: "env" }),
    ],
  ]);
  const metadata = new Map<string, Record<string, unknown>>();
  const spawns: Spawn[] = [];
  const hostCalls: { method: string; input: unknown }[] = [];
  const state = {
    failProvider: "",
    evidence: "Tests passed for commit bbbb",
    snapshot: pinned,
    afterSpawn: undefined as (() => void) | undefined,
  };
  const host = createFakePluginHost({
    pluginId: "scott-engineering",
    agentSkillIds: readdirSync(fileURLToPath(new URL("../../../skills", import.meta.url))),
    experimental_callHostRpc: async ({ method, input }) => {
      hostCalls.push({ method, input });
      if (method === "reviewSnapshot") return state.snapshot;
      return { text: "pinned source", nextOffset: null, totalLength: 13 };
    },
    sdk: {
      files: { read: async () => ({ content: state.evidence, contentEncoding: "utf8" }) as never },
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread not found");
          return { ...thread, environment } as never;
        },
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
        spawn: async (args) => {
          spawns.push(args);
          if (args.providerId === state.failProvider || state.failProvider === "all")
            throw new Error("Transport timed out");
          const thread = makeThreadResponse({
            id: `reviewer-${spawns.length}`,
            projectId: "project",
            environmentId: "env",
            parentThreadId: args.parentThreadId,
            providerId: args.providerId,
            originPluginId: "scott-engineering",
            status: "active",
          });
          threads.set(thread.id, thread);
          metadata.set(thread.id, args.pluginMetadata as Record<string, unknown>);
          state.afterSpawn?.();
          return thread;
        },
      },
    },
  });
  // Review works without any plugin storage. Arena can still use its own database.
  const bb = new Proxy(host.bb, {
    get(target, key, receiver) {
      if (key === "storage") throw new Error("Review must not use plugin storage");
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    ...host,
    service: new ReviewService(bb, models),
    bbWithoutStorage: bb,
    threads,
    metadata,
    spawns,
    hostCalls,
    state,
  };
}

test("launches native Claude and Codex children with the same pinned inputs", async () => {
  const f = fixture();
  const receipt = await f.service.start(
    "parent",
    {
      ...request,
      brief: "Remove duplicate state",
      evidence: [{ label: "Tests", path: "/tmp/tests.txt" }],
    },
    signal,
  );
  expect(receipt.errors).toEqual([]);
  expect(receipt.reviewers.map((item) => item.threadId)).toEqual(["reviewer-1", "reviewer-2"]);
  expect(f.spawns.map((item) => item.providerId)).toEqual(["claude-code", "codex"]);
  expect(f.spawns[0]).toMatchObject({
    parentThreadId: "parent",
    environment: { type: "reuse", environmentId: "env" },
    visibility: "hidden",
    reasoningLevel: "high",
  });
  expect(f.spawns[0]!.prompt).toBe(f.spawns[1]!.prompt);
  expect(f.spawns[0]!.prompt).toContain("Remove duplicate state");
  expect(f.spawns[0]!.prompt).toContain("Tests passed for commit bbbb");
  expect(f.metadata.get("reviewer-1")).toEqual(f.metadata.get("reviewer-2"));
  expect(f.metadata.get("reviewer-1")!.reviewRun).toMatchObject({ target: pinned });
  expect(f.metadata.get("reviewer-1")!.reviewRun).not.toHaveProperty("status");
});

test("a fresh service reads the original pinned source after a reload", async () => {
  const f = fixture();
  await f.service.start("parent", request, signal);
  f.state.snapshot = { ...pinned, head: "c".repeat(40) };
  const reloaded = new ReviewService(f.bbWithoutStorage, models);
  expect(
    await reloaded.context("reviewer-1", { section: "diff", side: "head", offset: 0 }, signal),
  ).toMatchObject({ text: "pinned source" });
  expect(f.hostCalls.at(-1)).toEqual({
    method: "reviewRead",
    input: { target: pinned, section: "diff", side: "head", offset: 0 },
  });
});

test("each start launches new children and partial failures preserve returned thread IDs", async () => {
  const f = fixture();
  f.state.failProvider = "codex";
  const first = await f.service.start("parent", request, signal);
  expect(first.reviewers.map((item) => item.threadId)).toEqual(["reviewer-1"]);
  expect(first.errors).toMatchObject([
    { reviewer: { providerId: "codex" }, error: "Transport timed out" },
  ]);
  f.state.failProvider = "";
  const second = await f.service.start("parent", request, signal);
  expect(second.reviewers.map((item) => item.threadId)).toEqual(["reviewer-3", "reviewer-4"]);
});

test("only a reviewer or its parent can read pinned source", async () => {
  const f = fixture();
  await f.service.start("parent", request, signal);
  for (const caller of ["stranger", "reviewer-2"]) {
    await expect(
      f.service.context(
        caller,
        { threadId: "reviewer-1", section: "file", path: "secret.ts", side: "head", offset: 0 },
        signal,
      ),
    ).rejects.toThrow("Only the reviewer and its parent");
  }
  for (const caller of ["parent", "reviewer-1"]) {
    expect(
      await f.service.context(
        caller,
        { threadId: "reviewer-1", section: "diff", side: "head", offset: 0 },
        signal,
      ),
    ).toMatchObject({ text: "pinned source" });
  }
});

test("workers cannot recursively launch and implementation requires a fixed target", async () => {
  const f = fixture();
  await expect(
    f.service.start("parent", { ...request, target: undefined }, signal),
  ).rejects.toThrow("named GitButler branch");
  await f.service.start("parent", request, signal);
  await expect(f.service.start("reviewer-1", request, signal)).rejects.toThrow("Workers cannot");
  for (const branch of ["HEAD", "HEAD~1", "gitbutler/workspace"])
    expect(requestSchema.safeParse({ summary: "Review", target: { branch } }).success).toBe(false);
});

test("designs need no source target and use the same independent reviewers", async () => {
  const f = fixture();
  const receipt = await f.service.start(
    "parent",
    requestSchema.parse({ summary: "Design", kind: "design", brief: "Proposal" }),
    signal,
  );
  expect(receipt.target).toBeNull();
  expect(receipt.reviewers).toHaveLength(2);
  expect(f.spawns[0]!.reasoningLevel).toBe("high");
  await expect(
    f.service.context("reviewer-1", { section: "diff", side: "head", offset: 0 }, signal),
  ).rejects.toThrow("no repository target");
});

test("canonical and legacy review tools publish input defaults and enforce the existing review boundary", async () => {
  const f = fixture();
  await plugin(f.bb);
  try {
    const started = await f.harness.behavior.runCli(
      ["review-start", "--branch", "scott/feature", "--prompt", "Intent"],
      { threadId: "parent", signal },
    );
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain("bb thread output reviewer-1");
    const tools = f.harness.inspection.registrations.agentTools;
    const canonical = tools.find(({ name }) => name === "dev_mode_review_context")!;
    const alias = tools.find(({ name }) => name === "scott_engineering_review_context")!;
    expect(alias.inputSchema).toEqual(canonical.inputSchema);
    expect(canonical.inputSchema).toMatchObject({
      required: ["section"],
      properties: { side: { default: "head" }, offset: { default: 0 } },
    });
    for (const name of [canonical.name, alias.name]) {
      const context = await f.harness.behavior.callAgentTool(
        name,
        { section: "diff" },
        { threadId: "reviewer-1" },
      );
      expect(JSON.stringify(context)).toContain("pinned source");
      expect(f.hostCalls.at(-1)).toEqual({
        method: "reviewRead",
        input: { target: pinned, section: "diff", side: "head", offset: 0 },
      });
      await f.harness.behavior.callAgentTool(
        name,
        { section: "diff", side: "base", offset: 9 },
        { threadId: "reviewer-1" },
      );
      expect(f.hostCalls.at(-1)!.input).toMatchObject({ side: "base", offset: 9 });
      for (const caller of ["stranger", "reviewer-2"]) {
        await expect(
          f.harness.behavior.callAgentTool(
            name,
            { threadId: "reviewer-1", section: "diff" },
            { threadId: caller },
          ),
        ).rejects.toThrow("Only the reviewer and its parent");
      }
    }
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

for (const failure of ["codex", "all"]) {
  test(`CLI and tool agree on a ${failure === "all" ? "failed" : "partial"} launch`, async () => {
    const f = fixture();
    f.state.failProvider = failure;
    await plugin(f.bb);
    try {
      const cli = await f.harness.behavior.runCli(
        ["review-start", "--branch", "scott/feature", "--prompt", "Intent", "--json"],
        { threadId: "parent", signal },
      );
      expect(cli.exitCode).toBe(failure === "all" ? 1 : 0);
      const receipt = JSON.parse(cli.stdout!);
      expect(receipt.reviewers).toHaveLength(failure === "all" ? 0 : 1);
      expect(receipt.errors.length).toBeGreaterThan(0);
      const tool = await f.harness.behavior.callAgentTool(
        "dev_mode_review_start",
        { summary: "Intent", target: { branch: "scott/feature" } },
        { threadId: "parent" },
      );
      expect(tool).toMatchObject({ isError: failure === "all" });
    } finally {
      await f.harness.lifecycle.dispose();
    }
  });
}

test("cancellation rejects instead of returning a successful launch receipt", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.state.afterSpawn = () => controller.abort(new Error("Launch cancelled"));
  await expect(f.service.start("parent", request, controller.signal)).rejects.toThrow(
    "Launch cancelled",
  );
  expect(f.spawns).toHaveLength(1);
  expect(f.threads.has("reviewer-1")).toBe(true);
});
