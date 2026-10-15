import { afterEach, expect, test } from "bun:test";
import {
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import type { Slot } from "./slot-store.ts";
import {
  acquire,
  cleanupSlots,
  cliSlot,
  deferred,
  environment,
  list,
  project,
  setup,
  trackHarness,
} from "./unity-slots-test-fixture.ts";

afterEach(cleanupSlots);

test("public inventory and foreign callers cannot recover a lease capability by forging threadId", async () => {
  const { harness, slot } = await setup();
  const lease = await acquire(harness, slot.id);
  const inventory = (await harness.behavior.callRpc("listUnityEditors", {
    hostId: "host",
    threadId: "alice",
  })) as { slots: Array<{ lifecycle: Slot }> };
  expect(inventory.slots[0]!.lifecycle).toMatchObject({ state: "leased", ownerThreadId: "alice" });
  expect(inventory.slots[0]!.lifecycle).not.toHaveProperty("leaseId");
  expect((await list(harness, "bob"))[0]).not.toHaveProperty("leaseId");
  expect((await list(harness))[0]).not.toHaveProperty("leaseId");
  expect((await list(harness, "alice"))[0]!.leaseId).toBe(lease.leaseId);
});

test("provider retries and restore retain the slot lease while refusing another thread", async () => {
  const { harness, slot, provider, provision } = await setup();
  const first = await provider.create(provision("alice"));
  expect(first).toEqual({
    status: "created",
    path: "/rampage",
    ownsPath: false,
    resource: { slotId: slot.id, hostId: "host", path: "/rampage" },
  });
  const lease = (await list(harness, "alice"))[0]!;
  expect(await provider.create({ ...provision("alice"), attempt: 2 })).toEqual(first);
  expect(
    await provider.restore!({
      ...provision("alice", "replacement-launch"),
      previous: { environment, resource: null },
    }),
  ).toEqual(first);
  expect((await list(harness, "alice"))[0]!.leaseId).toBe(lease.leaseId);
  expect(await provider.create(provision("bob"))).toMatchObject({
    status: "failed",
    message: expect.stringContaining("@thread:alice"),
  });
  expect(provider.policy.retireGraceMs).toBeNull();
  await harness.behavior.emitThreadEvent("thread.archived", {
    thread: makeThreadResponse({ id: "alice", projectId: "project", archivedAt: 1 }),
  });
  expect((await list(harness, "alice"))[0]).toMatchObject({
    state: "leased",
    leaseId: lease.leaseId,
  });
});

test("provider retirement refuses leased checkouts and preserves adopted files after release", async () => {
  const { harness, slot, provider, provision } = await setup();
  const created = await provider.create(provision("alice"));
  if (created.status !== "created") throw new Error(created.message);
  const lease = (await list(harness, "alice"))[0]!;
  const removal: Parameters<typeof provider.remove>[0] = {
    environment,
    hostId: "host",
    path: "/rampage",
    pathKey: "launch-alice",
    resource: created.resource!,
    attempt: 1,
    report: { step() {}, log() {} },
    signal: new AbortController().signal,
  };
  expect(await provider.remove(removal)).toMatchObject({
    status: "failed",
    message: expect.stringContaining("leased"),
  });
  expect((await list(harness, "alice"))[0]!.leaseId).toBe(lease.leaseId);
  expect(
    await cliSlot(
      harness,
      ["slots", "release", "--host", "host", "--slot", slot.id, "--lease", lease.leaseId!],
      "alice",
    ),
  ).toMatchObject({ state: "available", ownerThreadId: null });
  expect(await provider.remove(removal)).toEqual({ status: "removed" });
  expect(await provider.remove({ ...removal, attempt: 2 })).toEqual({ status: "removed" });
  expect((await list(harness))[0]).toMatchObject({ state: "retired", workspacePath: "/rampage" });
  expect(harness.experimental_hostRpcCalls.map((call) => call.method)).not.toContain(
    "removeWorkspace",
  );
});

test("busy release quarantines the checkout until confirmed recovery by its owner", async () => {
  const { state, harness, slot } = await setup();
  const lease = await acquire(harness, slot.id);
  state.busy = true;
  const release = await harness.behavior.runCli(
    ["slots", "release", "--host", "host", "--slot", slot.id, "--lease", lease.leaseId!],
    { threadId: "alice" },
  );
  expect(release).toMatchObject({ exitCode: 1 });
  expect(release.stderr).toContain("Unity Editor is still running");
  expect((await list(harness, "alice"))[0]).toMatchObject({
    state: "quarantined",
    ownerThreadId: "alice",
    leaseId: lease.leaseId,
    reason: "Unity Editor is still running in this checkout",
  });
  const recovery = [
    "slots",
    "recover",
    "--host",
    "host",
    "--slot",
    slot.id,
    "--note",
    "Editor shut down cleanly; no background work remains",
  ];
  const unconfirmed = await harness.behavior.runCli(recovery, { threadId: "alice" });
  expect(unconfirmed).toMatchObject({ exitCode: 1 });
  expect(unconfirmed.stderr).toContain("explicit confirmation");
  const foreign = await harness.behavior.runCli([...recovery, "--confirm"], { threadId: "bob" });
  expect(foreign).toMatchObject({ exitCode: 1 });
  expect(foreign.stderr).toContain("@thread:alice");
  state.busy = false;
  const recovered = await harness.behavior.runCli([...recovery, "--confirm"], {
    threadId: "alice",
  });
  expect(recovered).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(recovered.stdout!)).toMatchObject({
    slot: { state: "available", ownerThreadId: null },
  });
  const next = await acquire(harness, slot.id, "bob");
  expect(next).toMatchObject({ state: "leased", ownerThreadId: "bob" });
  expect(next.leaseId).not.toBe(lease.leaseId);
});

test("recovery rechecks an archived owner after host verification before freeing the checkout", async () => {
  const { state, harness, slot } = await setup();
  await acquire(harness, slot.id);
  state.archived = true;
  state.stopped = async () => {
    state.archived = false;
  };
  const result = await harness.behavior.runCli(
    [
      "slots",
      "recover",
      "--host",
      "host",
      "--slot",
      slot.id,
      "--confirm",
      "--note",
      "Archived owner stopped all Editor work",
    ],
    { threadId: "bob" },
  );
  expect(result).toMatchObject({ exitCode: 1 });
  expect(result.stderr).toContain("became active again");
  expect((await list(harness, "alice"))[0]).toMatchObject({
    state: "quarantined",
    ownerThreadId: "alice",
  });
});

test("preparation excludes both duplicate acquisition and Editor access until host checks complete", async () => {
  const { state, harness, slot, provider, provision } = await setup();
  const entered = deferred();
  const finish = deferred();
  state.stopped = async () => {
    entered.resolve();
    await finish.promise;
  };
  const pending = harness.behavior.runCli(
    ["slots", "acquire", "--host", "host", "--slot", slot.id],
    { threadId: "alice" },
  );
  await entered.promise;
  const duplicate = await harness.behavior.runCli(
    ["slots", "acquire", "--host", "host", "--slot", slot.id],
    { threadId: "alice" },
  );
  expect(duplicate).toMatchObject({ exitCode: 1 });
  expect(duplicate.stderr).toContain("preparing");
  state.editorVisible = true;
  const claim = await harness.behavior.runCli(
    ["manage", "claim", "--host", "host", "--instance", "main", "--mode", "authoring"],
    { threadId: "alice" },
  );
  expect(claim).toMatchObject({ exitCode: 1 });
  expect(claim.stderr).toContain("preparing");
  expect(await provider.create(provision("bob"))).toMatchObject({
    status: "failed",
    message: expect.stringContaining("preparing"),
  });
  finish.resolve();
  const acquired = await pending;
  expect(acquired).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(acquired.stdout!)).toMatchObject({ state: "leased", ownerThreadId: "alice" });
});

test("reload preserves leases and quarantines an interrupted host verification", async () => {
  const { state, harness, slot } = await setup();
  const lease = await acquire(harness, slot.id);
  const reloaded = await harness.lifecycle.reload(plugin);
  trackHarness(reloaded.harness);
  expect((await list(reloaded.harness, "alice"))[0]).toMatchObject({
    state: "leased",
    ownerThreadId: "alice",
    leaseId: lease.leaseId,
  });
  const entered = deferred();
  const finish = deferred();
  state.stopped = async () => {
    entered.resolve();
    await finish.promise;
  };
  const pending = reloaded.harness.behavior.runCli(
    ["slots", "release", "--host", "host", "--slot", slot.id, "--lease", lease.leaseId!],
    { threadId: "alice" },
  );
  await entered.promise;
  const interrupted = await reloaded.harness.lifecycle.reload(plugin);
  trackHarness(interrupted.harness);
  const quarantined = (await list(interrupted.harness, "alice"))[0]!;
  expect(quarantined).toMatchObject({
    state: "quarantined",
    ownerThreadId: "alice",
    leaseId: lease.leaseId,
  });
  expect(quarantined.reason).toContain("interrupted");
  finish.resolve();
  expect(await pending).toMatchObject({ exitCode: 1 });
  expect((await list(interrupted.harness, "alice"))[0]!.state).toBe("quarantined");
});

test("dispatch admission protects an adopted path even when BB directly reuses its environment", async () => {
  const { harness, slot } = await setup();
  const dispatch = harness.registrations.hooks["message.dispatch"]!;
  const context = (owner: string) =>
    makeMessageDispatchHookContext({
      thread: { id: owner, projectId: "project", environmentId: "environment" },
      project,
      environment,
      host: makeHostResponse({ id: "host" }),
    });
  expect(await dispatch(context("alice"))).toEqual({ action: "proceed" });
  const lease = (await list(harness, "alice"))[0]!;
  expect(lease).toMatchObject({ state: "leased", ownerThreadId: "alice" });
  expect(await dispatch(context("bob"))).toMatchObject({
    action: "reject",
    message: expect.stringContaining("@thread:alice"),
  });
  expect(await dispatch(context("alice"))).toEqual({ action: "proceed" });
  await cliSlot(
    harness,
    ["slots", "release", "--host", "host", "--slot", slot.id, "--lease", lease.leaseId!],
    "alice",
  );
  expect(await dispatch(context("bob"))).toEqual({ action: "proceed" });
  expect((await list(harness, "bob"))[0]).toMatchObject({ state: "leased", ownerThreadId: "bob" });
});

test("provider-intent dispatch leases an adopted path before core can reuse its environment", async () => {
  const { harness, provider, slot } = await setup();
  const dispatch = harness.registrations.hooks["message.dispatch"]!;
  const context = (owner: string) =>
    makeMessageDispatchHookContext({
      thread: { id: owner, projectId: "project", environmentId: null },
      project,
      environment: null,
      host: makeHostResponse({ id: "host" }),
      environmentIntent: {
        kind: "provider",
        environmentProviderId: "unity-rampage-slot",
        machine: { type: "existing", hostId: "host" },
        inputs: { slotId: slot.id },
      },
    });
  expect(await dispatch(context("alice"))).toEqual({ action: "proceed" });
  expect((await list(harness, "alice"))[0]).toMatchObject({
    state: "leased",
    ownerThreadId: "alice",
  });
  expect(provider.experimental_existingPath!({ slotId: slot.id })).toBe("/rampage");
  expect(await dispatch(context("bob"))).toMatchObject({
    action: "reject",
    message: expect.stringContaining("@thread:alice"),
  });
  expect(await dispatch(context("alice"))).toEqual({ action: "proceed" });
  expect((await list(harness, "alice"))[0]!.state).toBe("leased");
});

test("provider validation refuses foreign hosts and projects before selecting an existing path", async () => {
  const { provider, provision } = await setup();
  const context = provision("alice");
  expect(await provider.validate!(context)).toEqual({ action: "accept" });
  for (const foreign of [
    { ...context, host: makeHostResponse({ id: "other-host" }) },
    { ...context, project: { ...project, id: "other-project" } },
  ]) {
    expect(await provider.validate!(foreign)).toEqual({
      action: "refuse",
      message: "Select a registered Rampage slot on this host and BB project",
    });
  }
});

test("a symlink alias cannot dispatch into another thread's leased Rampage checkout", async () => {
  const { harness, slot } = await setup({
    resolve: (path) => (path === "/rampage-alias" ? "/rampage" : path),
  });
  await acquire(harness, slot.id);
  const dispatch = harness.registrations.hooks["message.dispatch"]!;
  const aliased = (owner: string) =>
    makeMessageDispatchHookContext({
      thread: { id: owner, projectId: "project", environmentId: "alias-environment" },
      project,
      environment: { ...environment, id: "alias-environment", path: "/rampage-alias" },
      host: makeHostResponse({ id: "host" }),
    });
  expect(await dispatch(aliased("bob"))).toMatchObject({
    action: "reject",
    message: expect.stringContaining("@thread:alice"),
  });
  expect(await dispatch(aliased("alice"))).toEqual({ action: "proceed" });
  expect((await list(harness, "alice"))[0]).toMatchObject({
    state: "leased",
    ownerThreadId: "alice",
  });
});

test("active alias environments block enrollment and handoff even after the first inventory page", async () => {
  const alias = { ...environment, id: "alias-environment", path: "/rampage-alias" };
  const active = makeThreadResponse({
    id: "busy-agent",
    projectId: "project",
    environmentId: alias.id,
    status: "active",
  });
  const resolve = (path: string) => (path === "/rampage-alias" ? "/rampage" : path);
  await expect(setup({ environments: [alias], threads: [active], resolve })).rejects.toThrow(
    "active agent: @thread:busy-agent",
  );
  const { state, harness, slot } = await setup({ resolve });
  state.environments = [
    ...Array.from({ length: 100 }, (_, index) => ({
      ...environment,
      id: `unrelated-${index}`,
      path: `/other-${index}`,
    })),
    alias,
  ];
  state.threads = [
    ...Array.from({ length: 100 }, (_, index) =>
      makeThreadResponse({
        id: `idle-agent-${index}`,
        environmentId: alias.id,
      }),
    ),
    active,
  ];
  const result = await harness.behavior.runCli(
    ["slots", "acquire", "--host", "host", "--slot", slot.id],
    { threadId: "alice" },
  );
  expect(result).toMatchObject({ exitCode: 1 });
  expect(result.stderr).toContain("active agent: @thread:busy-agent");
  expect((await list(harness, "alice"))[0]).toMatchObject({
    state: "quarantined",
    ownerThreadId: "alice",
    reason: "Checkout still has an active agent: @thread:busy-agent",
  });
});

test("registration refuses a path managed by another BB environment provider", async () => {
  await expect(
    setup({
      environments: [
        {
          ...environment,
          managed: true,
          environmentProviderId: "another-provider",
        },
      ],
    }),
  ).rejects.toThrow("another provider's managed path");
  const { slot } = await setup({
    environments: [
      {
        ...environment,
        managed: false,
        environmentProviderId: "project-checkout",
      },
    ],
  });
  expect(slot).toMatchObject({
    state: "available",
    workspacePath: "/rampage",
    projectId: "project",
  });
});
