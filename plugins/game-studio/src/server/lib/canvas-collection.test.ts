import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CanvasCollection, settledThreads } from "./canvas-collection.ts";
import { GenerationWork } from "./generation-work.ts";
import { SlotStore } from "./slot-store.ts";

function fixture({ threads = {} as Record<string, string> } = {}) {
  const calls: string[] = [];
  const inputs: Record<string, unknown> = {};
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
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (!threads[threadId]) throw new Error("HTTP 404: Thread not found");
          return { status: threads[threadId] } as never;
        },
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      calls.push(method);
      inputs[method] = input;
      if (method === "resolveWorkspace") return { workspacePath: "/games/orbit" };
      if (method === "mediaWriters") return { threads: [], unconfirmed: false };
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
    inputs,
    assets: () => Object.keys(JSON.parse(manifest).assets),
  };
}

async function game(bb: ReturnType<typeof fixture>["bb"], threadId: string | null = null) {
  await bb.storage.kv.set("game:orbit", {
    id: "orbit",
    name: "Orbit",
    projectId: "project",
    hostId: "host",
    rootPath: "/games/orbit",
    kind: "web",
    createdAt: 0,
    threadId,
  });
}

test("collection forgets freed and missing files in the catalog", async () => {
  const f = fixture();
  await game(f.bb);
  expect(await new CanvasCollection(f.bb, f.slots, f.work).collect("orbit")).toEqual([
    "canvas/staging/run/a.png",
  ]);
  expect(f.calls).toEqual(["resolveWorkspace", "mediaWriters", "collectCanvas"]);
  expect(f.assets()).toEqual(["kept"]);
});

test("the game's own thread at work holds off moving its media", async () => {
  const f = fixture({ threads: { main: "active" } });
  await game(f.bb, "main");
  await new CanvasCollection(f.bb, f.slots, f.work).collect("orbit");
  expect(f.inputs.collectCanvas).toMatchObject({ hold: true });
  const idle = fixture({ threads: { main: "idle" } });
  await game(idle.bb, "main");
  await new CanvasCollection(idle.bb, idle.slots, idle.work).collect("orbit");
  expect(idle.inputs.collectCanvas).toMatchObject({ hold: false, settled: ["main"] });
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

test("only threads BB reports stopped or gone count as settled", async () => {
  const status: Record<string, string> = { busy: "active", done: "idle", stopping: "stopping" };
  const bb = {
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "offline") throw new Error("HTTP 502: host unavailable");
          if (!status[threadId]) throw new Error("HTTP 404: Thread not found");
          return { status: status[threadId] };
        },
      },
    },
  } as never;
  expect(await settledThreads(bb, ["busy", "done", "stopping", "deleted", "offline"])).toEqual([
    "done",
    "deleted",
  ]);
});
