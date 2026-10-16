import { expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { checkoutChatTargetInputSchema } from "../../shared/schema.ts";
import { checkoutChatTarget } from "./checkout-chat-target.ts";

const checkout = { hostId: "host-2", path: "/alias/task" };
const input = {
  threadId: "parent",
  environmentId: "env-main",
  checkout,
  repositoryKey: "repos/api",
};
const ready = {
  state: "ready",
  projectId: "project-1",
  hostId: "host-2",
  environmentId: "env-task",
  path: "/canonical/task",
} as const;

function environment(overrides: Record<string, unknown> = {}) {
  return {
    id: "env-task",
    projectId: "project-1",
    hostId: "host-2",
    path: "/canonical/task",
    status: "ready",
    lifecycle: { phase: "active" },
    hostLifecycle: "active",
    ...overrides,
  };
}

function visibleThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "existing-task-thread",
    environmentId: "env-task",
    projectId: "project-1",
    environmentHostId: "host-2",
    archivedAt: null,
    deletedAt: null,
    visibility: "visible",
    ...overrides,
  };
}

function context() {
  let parentEnvironment = { id: "env-main", hostId: "host-1", path: "/main", status: "ready" };
  const environments = [environment()];
  const threads = [visibleThread()];
  const host = { id: "host-2", name: "Build", status: "connected", lifecycle: { phase: "active" } };
  const calls: { method: string; input: Record<string, unknown>; hostId: string }[] = [];
  const spawned: unknown[] = [];
  let onOrigin = () => {};
  let onEnvironmentRead = () => {};
  const bb = {
    sdk: {
      threads: {
        get: async () => ({
          id: "parent",
          projectId: "project-1",
          environmentId: parentEnvironment.id,
          environment: { ...parentEnvironment },
        }),
        list: async ({ limit, offset }: { limit: number; offset: number }) =>
          threads.slice(offset, offset + limit),
        spawn: async (request: unknown) => {
          spawned.push(request);
          return { id: "unexpected-agent" };
        },
      },
      hosts: {
        get: async ({ hostId }: { hostId: string }) => {
          if (hostId !== "host-2") throw new Error("Machine not found");
          return host;
        },
        list: async () => [host],
      },
      projects: { list: async () => [{ sources: [{ hostId: "host-2", path: "/known" }] }] },
      environments: {
        list: async ({ limit, offset = 0 }: { limit?: number; offset?: number }) =>
          environments.slice(offset, limit ? offset + limit : undefined),
        get: async ({ environmentId }: { environmentId: string }) => {
          onEnvironmentRead();
          const found = environments.find(({ id }) => id === environmentId);
          if (!found) throw Object.assign(new Error("Environment not found"), { status: 404 });
          return found;
        },
      },
    },
    hosts: {
      experimental_client: () => ({
        call: async (
          method: string,
          value: Record<string, unknown>,
          options: { hostId: string },
        ) => {
          calls.push({ method, input: value, hostId: options.hostId });
          if (method === "origin") {
            onOrigin();
            return { path: "/main/repos/api", origin: "github.com/acme/api" };
          }
          if (method !== "checkoutIdentity") throw new Error(`Unexpected host method: ${method}`);
          if (!["/alias/task", "/canonical/task"].includes(String(value.environmentPath)))
            throw new Error("That checkout is no longer registered for this repository.");
          return {
            key: ".",
            identity: {
              path: "/canonical/task",
              origin: "github.com/acme/api",
              commonDir: "/canonical/main/.git",
              kind: "git",
              branch: "scott/task",
              head: "a".repeat(40),
            },
          };
        },
      }),
    },
  } as unknown as BbPluginApi;
  return {
    ctx: { bb } as never,
    environments,
    threads,
    host,
    calls,
    spawned,
    move: () => {
      parentEnvironment = { ...parentEnvironment, id: "env-moved", path: "/moved" };
    },
    duringOrigin: (callback: () => void) => {
      onOrigin = callback;
    },
    duringEnvironmentRead: (callback: () => void) => {
      onEnvironmentRead = callback;
    },
  };
}

test("returns the exact existing checkout environment without starting an agent", async () => {
  const fixture = context();
  expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual(ready);
  expect(fixture.spawned).toEqual([]);
  expect(fixture.calls).toContainEqual({
    method: "checkoutIdentity",
    hostId: "host-2",
    input: {
      environmentPath: "/alias/task",
      repositoryKey: ".",
      checkout: { paths: ["/known", "/canonical/task"], origin: "github.com/acme/api" },
    },
  });
});

test("accepts the selected checkout alias but does not scan unrelated environment repositories", async () => {
  const fixture = context();
  fixture.environments[0] = environment({ path: "/alias/task" });
  fixture.environments.push(environment({ id: "wrapper", path: "/wrapper" }));
  expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual(ready);
  expect(
    fixture.calls
      .filter(({ method }) => method === "checkoutIdentity")
      .map(({ input }) => input.environmentPath),
  ).toEqual(["/alias/task", "/alias/task"]);
});

test("orphan, foreign, non-ready and retiring environments never fall back to the parent", async () => {
  for (const overrides of [
    { projectId: "another-project" },
    { hostId: "another-host" },
    { status: "destroyed" },
    { status: "provisioning" },
    { status: "error" },
    { lifecycle: { phase: "retiring" } },
    { hostLifecycle: "removing" },
    { path: null },
    { path: "/wrapper" },
  ]) {
    const fixture = context();
    fixture.environments[0] = environment(overrides);
    expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual({
      state: "unavailable",
      reason:
        "This checkout needs its own ready BB environment and a visible, unarchived thread before opening a new chat here.",
    });
    fixture.environments[0] = environment();
    expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual(ready);
  }
  const orphan = context();
  orphan.environments.length = 0;
  expect(await checkoutChatTarget.execute(orphan.ctx, input)).toMatchObject({
    state: "unavailable",
  });
});

test("requires a visible, unarchived thread belonging to the exact environment, project and host", async () => {
  for (const overrides of [
    { visibility: "hidden" },
    { archivedAt: 1 },
    { deletedAt: 1 },
    { environmentId: "env-main" },
    { projectId: "another-project" },
    { environmentHostId: "host-1" },
  ]) {
    const fixture = context();
    fixture.threads[0] = visibleThread(overrides);
    expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual({
      state: "unavailable",
      reason:
        "This checkout needs a visible, unarchived thread in its ready BB environment before opening a new chat here.",
    });
    fixture.threads[0] = visibleThread();
    expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual(ready);
  }
});

test("does not choose between ambiguous environments even if one has no sidebar thread", async () => {
  const fixture = context();
  fixture.environments.push(environment({ id: "duplicate" }));
  expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual({
    state: "unavailable",
    reason:
      "More than one BB environment matches this checkout. Open its existing thread to choose the intended environment.",
  });
  fixture.environments.pop();
  expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual(ready);
});

test("requires the checkout machine to be connected and active", async () => {
  const fixture = context();
  fixture.host.status = "disconnected";
  expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual({
    state: "unavailable",
    reason: "Build must be connected and active before opening a chat.",
  });
  fixture.host.status = "connected";
  fixture.host.lifecycle.phase = "suspended";
  expect(await checkoutChatTarget.execute(fixture.ctx, input)).toMatchObject({
    state: "unavailable",
  });
  fixture.host.lifecycle.phase = "active";
  expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual(ready);
});

test("a forged checkout cannot bypass host provenance validation or supply browser authority", async () => {
  expect(() =>
    checkoutChatTargetInputSchema.parse({
      ...input,
      checkout: { ...checkout, paths: ["/untrusted"] },
    }),
  ).toThrow();
  const fixture = context();
  await expect(
    checkoutChatTarget.execute(fixture.ctx, {
      ...input,
      checkout: { ...checkout, path: "/unrelated" },
    }),
  ).rejects.toThrow("no longer registered");
  expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual(ready);
  expect(fixture.spawned).toEqual([]);
});

test("a parent environment move before or during target resolution rejects the stale board", async () => {
  for (const phase of ["before", "origin", "environment"] as const) {
    const fixture = context();
    if (phase === "before") fixture.move();
    else if (phase === "origin") fixture.duringOrigin(fixture.move);
    else fixture.duringEnvironmentRead(fixture.move);
    await expect(checkoutChatTarget.execute(fixture.ctx, input)).rejects.toThrow(
      "moved to another environment",
    );
    expect(fixture.spawned).toEqual([]);
  }
  expect(await checkoutChatTarget.execute(context().ctx, input)).toEqual(ready);
});

test("rechecks environment readiness before returning a native reuse target", async () => {
  const fixture = context();
  fixture.duringEnvironmentRead(() => {
    fixture.environments[0] = environment({ status: "destroyed" });
  });
  expect(await checkoutChatTarget.execute(fixture.ctx, input)).toMatchObject({
    state: "unavailable",
  });
  expect(await checkoutChatTarget.execute(context().ctx, input)).toEqual(ready);
});

test("pages environment and visible-thread inventory without scanning unrelated checkout paths", async () => {
  const fixture = context();
  fixture.environments.unshift(
    ...Array.from({ length: 100 }, (_, index) =>
      environment({ id: `other-${index}`, path: `/other/${index}` }),
    ),
  );
  fixture.threads.unshift(
    ...Array.from({ length: 100 }, (_, index) =>
      visibleThread({ id: `hidden-${index}`, visibility: "hidden" }),
    ),
  );
  expect(await checkoutChatTarget.execute(fixture.ctx, input)).toEqual(ready);
  expect(
    fixture.calls
      .filter(({ method }) => method === "checkoutIdentity")
      .map(({ input }) => input.environmentPath),
  ).toEqual(["/alias/task", "/canonical/task"]);
});

test("SDK inventory failures are surfaced instead of being treated as missing checkouts", async () => {
  const fixture = context();
  fixture.duringEnvironmentRead(() => {
    throw new Error("Inventory lookup failed");
  });
  await expect(checkoutChatTarget.execute(fixture.ctx, input)).rejects.toThrow(
    "Inventory lookup failed",
  );
  expect(await checkoutChatTarget.execute(context().ctx, input)).toEqual(ready);
});
