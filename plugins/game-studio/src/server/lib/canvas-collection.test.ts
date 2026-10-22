import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CanvasCollection } from "./canvas-collection.ts";
import { GenerationWork } from "./generation-work.ts";
import { SlotStore } from "./slot-store.ts";

function fixture() {
  const calls: string[] = [];
  let manifest = JSON.stringify({
    version: 1,
    assets: {
      freed: { name: "a.png", path: "canvas/staging/run/a.png" },
      gone: { name: "b.png", path: "canvas/staging/run/b.png" },
      kept: { name: "c.png", path: "canvas/staging/run/c.png" },
    },
  });
  const { bb } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      files: {
        read: async () =>
          ({ content: manifest, contentEncoding: "utf8", sha256: "m", sizeBytes: 1 }) as never,
        write: async ({ content }) => {
          manifest = content;
          return { outcome: "written", sha256: "n", sizeBytes: 1 } as never;
        },
      },
    },
    experimental_callHostRpc: async ({ method }) => {
      calls.push(method);
      if (method === "resolveWorkspace") return { workspacePath: "/games/orbit" };
      return { deleted: ["canvas/staging/run/a.png"], missing: ["canvas/staging/run/b.png"] };
    },
  });
  const slots = new SlotStore(bb.storage.database());
  const work = new GenerationWork(slots);
  return {
    bb,
    slots,
    work,
    calls,
    assets: () => Object.keys(JSON.parse(manifest).assets),
  };
}

async function game(bb: ReturnType<typeof fixture>["bb"]) {
  await bb.storage.kv.set("game:orbit", {
    id: "orbit",
    name: "Orbit",
    projectId: "project",
    hostId: "host",
    rootPath: "/games/orbit",
    kind: "web",
    createdAt: 0,
    threadId: null,
  });
}

test("collection forgets freed and missing files in the catalog", async () => {
  const f = fixture();
  await game(f.bb);
  expect(await new CanvasCollection(f.bb, f.slots, f.work).collect("orbit")).toEqual([
    "canvas/staging/run/a.png",
  ]);
  expect(f.calls).toEqual(["resolveWorkspace", "collectCanvas"]);
  expect(f.assets()).toEqual(["kept"]);
});

test("a registered checkout is collected only while leased", async () => {
  const f = fixture();
  await game(f.bb);
  const slot = f.slots.register("host", "/games/orbit", "project");
  const collection = new CanvasCollection(f.bb, f.slots, f.work);
  expect(await collection.collect("orbit")).toEqual([]);
  expect(f.calls).toEqual(["resolveWorkspace"]);
  const preparing = f.slots.acquire(slot.id, "host", "project", "thread");
  f.slots.completeAcquire(slot.id, preparing.leaseId!);
  await collection.collect("orbit");
  expect(f.calls.at(-1)).toBe("collectCanvas");
});

test("a collection a restart cut off no longer holds its checkout", async () => {
  const f = fixture();
  const slot = f.slots.register("host", "/games/orbit", "project");
  const preparing = f.slots.acquire(slot.id, "host", "project", "thread");
  f.slots.completeAcquire(slot.id, preparing.leaseId!);
  f.work.reserve("host", "/games/orbit", "collect-1", "thread");
  f.work.reserve("host", "/games/orbit", "job", "thread");
  new CanvasCollection(f.bb, f.slots, f.work);
  expect(f.work.owner("host", "/games/orbit", "collect-1")).toBeNull();
  expect(f.work.owner("host", "/games/orbit", "job")).toBe("thread");
});
