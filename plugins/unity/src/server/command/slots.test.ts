import { afterEach, expect, test } from "bun:test";
import { acquire, cleanupSlots, list, setup } from "../lib/unity-slots-test-fixture.ts";

afterEach(cleanupSlots);

test("registered Rampage slots require a real thread lease before Editor authoring", async () => {
  const { harness, state, slot } = await setup();
  expect(slot).toMatchObject({
    workspacePath: "/rampage",
    projectId: "project",
    state: "available",
    ownerThreadId: null,
  });
  const anonymous = await harness.behavior.runCli([
    "slots",
    "acquire",
    "--host",
    "host",
    "--slot",
    slot.id,
  ]);
  expect(anonymous).toMatchObject({ exitCode: 1 });
  expect(anonymous.stderr).toContain("actual BB thread");
  const lease = await acquire(harness, slot.id);
  expect(lease).toMatchObject({ state: "leased", ownerThreadId: "alice" });
  expect(typeof lease.leaseId).toBe("string");
  expect(await acquire(harness, slot.id)).toEqual(lease);
  const conflict = await harness.behavior.runCli(
    ["slots", "acquire", "--host", "host", "--slot", slot.id],
    { threadId: "bob" },
  );
  expect(conflict).toMatchObject({ exitCode: 1 });
  expect(conflict.stderr).toContain("@thread:alice");
  state.editorVisible = true;
  const claimArgs = [
    "manage",
    "claim",
    "--host",
    "host",
    "--instance",
    "main",
    "--mode",
    "authoring",
  ];
  const foreign = await harness.behavior.runCli(claimArgs, { threadId: "bob" });
  expect(foreign).toMatchObject({ exitCode: 1 });
  expect(foreign.stderr).toContain("@thread:alice");
  const claimResult = await harness.behavior.runCli(claimArgs, { threadId: "alice" });
  expect(claimResult).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(claimResult.stdout!)).toMatchObject({
    ownerThreadId: "alice",
    mode: "authoring",
  });
  const release = await harness.behavior.runCli(
    ["slots", "release", "--host", "host", "--slot", slot.id, "--lease", lease.leaseId!],
    { threadId: "alice" },
  );
  expect(release).toMatchObject({ exitCode: 1 });
  expect(release.stderr).toContain("Release all Editor claims");
  expect((await list(harness, "alice"))[0]).toMatchObject({
    state: "leased",
    leaseId: lease.leaseId,
  });
});
