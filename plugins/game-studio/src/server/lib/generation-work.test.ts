import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { SlotStore } from "./slot-store.ts";
import { GenerationWork } from "./generation-work.ts";
test("an admitted generation blocks checkout handoff until its saved task is accounted for", () => {
  const { bb } = createFakePluginHost({ pluginId: "game-studio" });
  const slots = new SlotStore(bb.storage.database()),
    jobs = new GenerationWork(slots);
  const registered = slots.register("host", "/game", "project");
  const preparing = slots.acquire(registered.id, "host", "project", "thread");
  const leased = slots.completeAcquire(registered.id, preparing.leaseId!);
  jobs.reserve("host", "/game", "request", "thread");
  expect(() => slots.beginRelease(leased.id, "thread", leased.leaseId!)).toThrow("generation jobs");
  expect(() => jobs.reserve("host", "/game", "other", "other-thread")).toThrow(
    "Checkout is leased",
  );
  jobs.settled("host", "/game", "request");
  expect(slots.beginRelease(leased.id, "thread", leased.leaseId!).state).toBe("releasing");
  expect(() => jobs.reserve("host", "/game", "late", "thread")).toThrow("Checkout is releasing");
});
