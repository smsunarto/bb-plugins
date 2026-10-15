import { afterEach, expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import {
  acquire,
  cleanupSlots,
  cliSlot,
  deferred,
  environment,
  list,
  project,
  trackHarness,
} from "./unity-slots-test-fixture.ts";

afterEach(cleanupSlots);

const seeded = {
  workspacePath: "/new-rampage",
  projectVersion: "6000.3.10f1",
  sourceCommit: "a".repeat(40),
  branch: "scott/slot-1",
  cacheSeed: "copy-on-write" as const,
};

async function setup() {
  const copies: unknown[] = [];
  const checked: string[] = [];
  const state = {
    busy: false,
    editorVisible: false,
    editorPath: "/rampage",
    environmentPath: "/rampage",
    provision: async () => seeded,
    stopped: async (_path: string) => {},
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      plugins: { list: async () => ({ plugins: [] }) },
      projects: { get: async () => ({ ...project, sources: [] }) },
      environments: {
        list: async () => [],
        get: async () => ({ ...environment, path: state.environmentPath }),
      },
      threads: {
        list: async () => [],
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "project",
            environmentId: "environment",
          }),
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      const { path } = input as { path: string };
      if (method === "inspectWorkspace")
        return { workspacePath: path, projectVersion: "6000.3.10f1" };
      if (method === "resolveWorkspace") return { workspacePath: path };
      if (method === "planSlotDestination") return { workspacePath: path };
      if (method === "workspaceStopped") {
        checked.push(path);
        await state.stopped(path);
        if (state.busy) throw new Error("Unity Editor is still running in this checkout");
        return { stopped: true };
      }
      if (method === "provisionSlot") {
        copies.push(input);
        return state.provision();
      }
      if (method === "discover")
        return {
          instances: state.editorVisible
            ? [
                {
                  id: "main",
                  projectPath: state.editorPath,
                  workspacePath: state.editorPath,
                  pid: 101,
                  port: 7800,
                  version: "6000.3.10f1",
                  startedAt: "birth",
                  clone: false,
                },
              ]
            : [],
          warnings: [],
        };
      if (method === "probe") return { pid: 101 };
      throw new Error(`Unexpected host method: ${method}`);
    },
  });
  trackHarness(harness);
  await plugin(bb);
  const source = await cliSlot(harness, [
    "slots",
    "register",
    "--host",
    "host",
    "--project",
    "project",
    "--path",
    "/rampage",
  ]);
  const create = (owner: string | null = "alice") =>
    harness.behavior.runCli(
      [
        "slots",
        "create",
        "--host",
        "host",
        "--source",
        source.id,
        "--path",
        "/new-rampage",
        "--branch",
        "scott/slot-1",
      ],
      { threadId: owner ?? undefined },
    );
  return { harness, source, state, copies, checked, create };
}

test("create reserves its stopped source for the caller and publishes a verified available checkout", async () => {
  const { harness, source, state, copies, checked, create } = await setup();
  const entered = deferred();
  const finish = deferred();
  state.provision = async () => {
    entered.resolve();
    await finish.promise;
    return seeded;
  };
  const pending = create();
  await entered.promise;
  const reserved = await list(harness, "alice");
  const sourceLease = reserved.find((slot) => slot.id === source.id)!;
  expect(sourceLease).toMatchObject({ state: "seeding", ownerThreadId: "alice" });
  const target = reserved.find((slot) => slot.workspacePath === "/new-rampage")!;
  expect(target).toMatchObject({ state: "preparing", ownerThreadId: "alice" });
  const foreign = await harness.behavior.runCli(
    ["slots", "acquire", "--host", "host", "--slot", source.id],
    { threadId: "bob" },
  );
  expect(foreign).toMatchObject({ exitCode: 1 });
  expect(foreign.stderr).toContain("@thread:alice");
  state.editorVisible = true;
  const editorClaim = await harness.behavior.runCli(
    ["manage", "claim", "--host", "host", "--instance", "main", "--mode", "authoring"],
    { threadId: "bob" },
  );
  expect(editorClaim).toMatchObject({ exitCode: 1 });
  expect(editorClaim.stderr).toContain("@thread:alice");
  const ownClaim = await harness.behavior.runCli(
    ["manage", "claim", "--host", "host", "--instance", "main", "--mode", "authoring"],
    { threadId: "alice" },
  );
  expect(ownClaim).toMatchObject({ exitCode: 1 });
  expect(ownClaim.stderr).toContain("seeding");
  const ownRelease = await harness.behavior.runCli(
    ["slots", "release", "--host", "host", "--slot", source.id, "--lease", sourceLease.leaseId!],
    { threadId: "alice" },
  );
  expect(ownRelease).toMatchObject({ exitCode: 1 });
  expect(ownRelease.stderr).toContain("seeding");
  const reregistered = await cliSlot(
    harness,
    ["slots", "register", "--host", "host", "--project", "project", "--path", "/new-rampage"],
    "bob",
  );
  expect(reregistered).toMatchObject({ id: target.id, state: "preparing", ownerThreadId: "alice" });
  expect(reregistered).not.toHaveProperty("leaseId");
  state.environmentPath = "/new-rampage";
  const targetLease = await harness.behavior.runCli(
    ["slots", "acquire", "--host", "host", "--slot", target.id],
    { threadId: "bob" },
  );
  expect(targetLease).toMatchObject({ exitCode: 1 });
  expect(targetLease.stderr).toContain("preparing");
  state.editorPath = "/new-rampage";
  const targetClaim = await harness.behavior.runCli(
    ["manage", "claim", "--host", "host", "--instance", "main", "--mode", "authoring"],
    { threadId: "bob" },
  );
  expect(targetClaim).toMatchObject({ exitCode: 1 });
  expect(targetClaim.stderr).toContain("preparing");
  state.editorVisible = false;
  finish.resolve();
  const result = await pending;
  expect(result).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(result.stdout!)).toMatchObject({
    ...seeded,
    slot: { workspacePath: "/new-rampage", state: "available", ownerThreadId: null },
  });
  expect(copies).toEqual([
    {
      sourcePath: "/rampage",
      path: "/new-rampage",
      branch: "scott/slot-1",
      operationId: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  ]);
  expect(checked).toContain("/new-rampage");
  expect((await list(harness)).find((slot) => slot.id === source.id)).toMatchObject({
    state: "available",
    ownerThreadId: null,
  });
});

test("create retains the caller's existing source lease after seeding", async () => {
  const { harness, source, create } = await setup();
  const lease = await acquire(harness, source.id);
  expect(await create()).toMatchObject({ exitCode: 0 });
  expect((await list(harness, "alice")).find((slot) => slot.id === source.id)).toMatchObject({
    state: "leased",
    ownerThreadId: "alice",
    leaseId: lease.leaseId,
  });
});

test("creation refuses an already registered destination and preserves its owner's lease", async () => {
  const { harness, state, copies, create } = await setup();
  const existing = await cliSlot(harness, [
    "slots",
    "register",
    "--host",
    "host",
    "--project",
    "project",
    "--path",
    "/new-rampage",
  ]);
  state.environmentPath = "/new-rampage";
  const lease = await acquire(harness, existing.id, "bob");
  const failed = await create();
  expect(failed).toMatchObject({ exitCode: 1 });
  expect(failed.stderr).toContain("registered");
  expect((await list(harness, "bob")).find((slot) => slot.id === existing.id)).toEqual(lease);
  expect(copies).toEqual([]);
});

test("a busy source is quarantined before copying and another owner's source is refused", async () => {
  const { harness, source, state, copies, create } = await setup();
  const lease = await acquire(harness, source.id, "bob");
  const occupied = await create();
  expect(occupied).toMatchObject({ exitCode: 1 });
  expect(occupied.stderr).toContain("@thread:bob");
  expect((await list(harness, "bob"))[0]).toEqual(lease);
  await cliSlot(
    harness,
    ["slots", "release", "--host", "host", "--slot", source.id, "--lease", lease.leaseId!],
    "bob",
  );
  state.busy = true;
  const busy = await create();
  expect(busy).toMatchObject({ exitCode: 1 });
  expect(busy.stderr).toContain("Unity Editor is still running");
  expect(await list(harness, "alice")).toMatchObject([
    { workspacePath: "/rampage", state: "quarantined", ownerThreadId: "alice" },
  ]);
  expect(copies).toEqual([]);
});

test("native failure quarantines both paths and registration cannot make the partial destination available", async () => {
  const { harness, state, copies, create } = await setup();
  state.provision = async () => {
    throw new Error("CoW cloning is unsupported");
  };
  const failed = await create();
  expect(failed).toMatchObject({ exitCode: 1 });
  expect(failed.stderr).toContain("CoW cloning is unsupported");
  expect(copies).toHaveLength(1);
  expect(await list(harness, "alice")).toMatchObject([
    {
      workspacePath: "/new-rampage",
      state: "quarantined",
      ownerThreadId: "alice",
      reason: "CoW cloning is unsupported",
    },
    {
      workspacePath: "/rampage",
      state: "quarantined",
      ownerThreadId: "alice",
      reason: "CoW cloning is unsupported",
    },
  ]);
  const registered = await cliSlot(
    harness,
    ["slots", "register", "--host", "host", "--project", "project", "--path", "/new-rampage"],
    "bob",
  );
  expect(registered).toMatchObject({ workspacePath: "/new-rampage", state: "quarantined" });
  expect(registered).not.toHaveProperty("leaseId");
});

test("completed retries preserve the destination without copying or acquiring an occupied source", async () => {
  const { harness, source, state, copies, create } = await setup();
  const first = await create();
  expect(first).toMatchObject({ exitCode: 0 });
  const foreign = await acquire(harness, source.id, "bob");
  state.provision = async () => {
    throw new Error("would overwrite the user's changed Library");
  };
  const repeated = await create();
  expect(repeated).toEqual(first);
  expect(copies).toHaveLength(1);
  expect((await list(harness, "bob")).find((slot) => slot.id === source.id)).toEqual(foreign);
  state.environmentPath = "/new-rampage";
  const destination = JSON.parse(first.stdout!).slot;
  const occupied = await acquire(harness, destination.id, "bob");
  const reused = await create();
  expect(reused).toMatchObject({ exitCode: 0 });
  const visible = JSON.parse(reused.stdout!).slot;
  expect(visible).toMatchObject({ state: "leased", ownerThreadId: "bob" });
  expect(visible).not.toHaveProperty("leaseId");
  expect((await list(harness, "bob")).find((slot) => slot.id === destination.id)).toEqual(occupied);
  expect(copies).toHaveLength(1);
});

test("a copied destination stays unavailable until checkout readiness verification completes", async () => {
  const { harness, state, create } = await setup();
  const entered = deferred();
  const finish = deferred();
  state.stopped = async (path) => {
    if (path !== "/new-rampage") return;
    entered.resolve();
    await finish.promise;
  };
  const pending = create();
  await entered.promise;
  const target = (await list(harness)).find((slot) => slot.workspacePath === "/new-rampage")!;
  expect(target).toMatchObject({ state: "preparing", ownerThreadId: "alice" });
  state.environmentPath = "/new-rampage";
  const attempt = await harness.behavior.runCli(
    ["slots", "acquire", "--host", "host", "--slot", target.id],
    { threadId: "bob" },
  );
  expect(attempt).toMatchObject({ exitCode: 1 });
  expect(attempt.stderr).toContain("preparing");
  finish.resolve();
  expect(await pending).toMatchObject({ exitCode: 0 });
  expect((await list(harness)).find((slot) => slot.id === target.id)).toMatchObject({
    state: "available",
    ownerThreadId: null,
  });
});

test("creation rejects caller-forged ownership and requires an actual BB thread", async () => {
  const { harness, source, copies, create } = await setup();
  const tool = harness.registrations.agentTools.find((entry) => entry.name === "game_studio_slots")!;
  expect(
    tool.parse({
      action: "create",
      hostId: "host",
      sourceSlotId: source.id,
      path: "/new-rampage",
      ownerThreadId: "alice",
    }).ok,
  ).toBe(false);
  const result = await create(null);
  expect(result).toMatchObject({ exitCode: 1 });
  expect(result.stderr).toContain("actual BB thread context");
  expect((await list(harness))[0]).toMatchObject({ state: "available", ownerThreadId: null });
  expect(copies).toEqual([]);
});
