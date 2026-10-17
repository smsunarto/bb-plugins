import { afterEach, expect, test } from "bun:test";
import { cleanupSlots, setup } from "../lib/unity-slots-test-fixture.ts";

afterEach(cleanupSlots);

test("slot tools bind leases to the actual caller and refuse forged owners and capabilities", async () => {
  const { harness, slot } = await setup();
  const tool = harness.registrations.agentTools.find(
    (entry) => entry.name === "game_studio_slots",
  )!;
  expect(
    tool.parse({
      action: "acquire",
      hostId: "host",
      slotId: slot.id,
      ownerThreadId: "alice",
    }).ok,
  ).toBe(false);
  const claimed = await harness.behavior.callAgentTool(
    "game_studio_slots",
    {
      action: "acquire",
      hostId: "host",
      slotId: slot.id,
    },
    { threadId: "alice", projectId: "forged-project" },
  );
  const lease = JSON.parse(claimed as string);
  expect(lease).toMatchObject({ state: "leased", ownerThreadId: "alice", projectId: "project" });
  expect(typeof lease.leaseId).toBe("string");
  await expect(
    harness.behavior.callAgentTool(
      "game_studio_slots",
      {
        action: "release",
        hostId: "host",
        slotId: slot.id,
        leaseId: lease.leaseId,
      },
      { threadId: "bob" },
    ),
  ).rejects.toThrow("owned by this BB thread");
  await expect(
    harness.behavior.callAgentTool(
      "game_studio_slots",
      {
        action: "release",
        hostId: "host",
        slotId: slot.id,
        leaseId: "forged-capability",
      },
      { threadId: "alice" },
    ),
  ).rejects.toThrow("matching checkout lease");
  const released = await harness.behavior.callAgentTool(
    "game_studio_slots",
    {
      action: "release",
      hostId: "host",
      slotId: slot.id,
      leaseId: lease.leaseId,
    },
    { threadId: "alice" },
  );
  expect(JSON.parse(released as string)).toMatchObject({ state: "available", ownerThreadId: null });
});
