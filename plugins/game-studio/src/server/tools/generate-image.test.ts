import { expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { mediaRequest, generationJob } from "../../shared/generation.ts";
import { generationApprovalPayload } from "../../shared/approvals.ts";

type Approver = {
  pendingInteractions: readonly { id: string }[];
  submitInteraction(id: string, value: { approved: boolean }): void;
};
/** Answers every approval form the way a person approving everything would, while `action` runs. */
async function approving<T>(harness: Approver, action: () => Promise<T>): Promise<T> {
  const answered = new Set<string>();
  const timer = setInterval(() => {
    for (const { id } of harness.pendingInteractions)
      if (!answered.has(id)) {
        answered.add(id);
        harness.submitInteraction(id, { approved: true });
      }
  }, 2);
  try {
    return await action();
  } finally {
    clearInterval(timer);
  }
}

test("native generation tools dispatch typed requests to the game's host and keep secrets out of results", async () => {
  const calls: { hostId: unknown; method: string; input: unknown }[] = [];
  const game = {
    id: "game",
    name: "Orbit",
    projectId: "project",
    hostId: "remote",
    rootPath: "/game",
    kind: "unity",
    createdAt: 0,
    threadId: "thread",
    previewPath: "index.html",
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    settings: {
      falOAuthCredentials: JSON.stringify({
        accessToken: "test-fal-access",
        refreshToken: "test-fal-refresh",
        expiresAt: Date.now() + 3600000,
        account: "test@example.com",
      }),
    },
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({ id: "thread", projectId: "project", environmentId: "environment" }),
      },
      environments: { get: async () => ({ hostId: "remote", path: "/game" }) as never },
    },
    experimental_callHostRpc: ({ hostId, method, input }) => {
      if (method === "mediaDir") return { dir: "/game/canvas" };
      calls.push({ hostId, method, input });
      if (method === "resolveWorkspace") return { workspacePath: "/game" };
      if (method === "start") {
        const args = input as { jobId: string; request: unknown };
        return {
          created: true,
          job: generationJob.parse({
            version: 1,
            id: args.jobId,
            threadId: "thread",
            createdAt: 1,
            updatedAt: 1,
            status: "queued",
            request: mediaRequest.parse(args.request),
            outputs: [],
          }),
        };
      }
      throw new Error("Unexpected host call");
    },
  });
  await plugin(bb);
  await bb.storage.kv.set("game:game", game);
  for (const [name, input] of [
    ["game_studio_generate_image", { prompt: "A moon icon" }],
    ["game_studio_generate_video", { prompt: "A rotating moon", model: { provider: "fal" } }],
    ["game_studio_generate_3d_asset", { approvedImagePath: "canvas/staging/moon.png" }],
  ] as const) {
    const result = JSON.parse(
      (await approving(harness, () =>
        harness.callAgentTool(
          name,
          { gameId: "game", requestId: name, ...input },
          { threadId: "thread" },
        ),
      )) as string,
    );
    expect(result.job.status).toBe("queued");
    expect(result.job.id).toBe(name);
  }
  const starts = calls.filter((call) => call.method === "start");
  expect(starts.map((call) => call.hostId)).toEqual(["remote", "remote", "remote"]);
  expect((starts[0]!.input as { request: unknown }).request).toMatchObject({
    kind: "image",
    model: { provider: "google", id: "gemini-nano-banana-2.1" },
    outputCount: 1,
  });
  expect((starts[1]!.input as { request: unknown }).request).toMatchObject({
    kind: "video",
    model: { provider: "fal" },
    resolution: "768p",
  });
  expect((starts[2]!.input as { request: unknown }).request).toMatchObject({
    kind: "model-3d",
    model: { provider: "tripo", id: "tripo-p2" },
  });
  const image = harness.registrations.agentTools.find(
    (tool) => tool.name === "game_studio_generate_image",
  )!;
  expect(
    image.parse({ gameId: "game", requestId: "unsafe", prompt: "Icon", args: "--repeat 100" }).ok,
  ).toBe(false);
});

test("a failed dispatch with no host job can be reconciled and releases its checkout reservation", async () => {
  const { SlotStore } = await import("../lib/slot-store.ts");
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({ id: "thread", projectId: "project", environmentId: "environment" }),
      },
      environments: { get: async () => ({ hostId: "remote", path: "/game" }) as never },
    },
    experimental_callHostRpc: ({ method }) => {
      if (method === "mediaDir") return { dir: "/game/canvas" };
      calls.push(method);
      if (method === "resolveWorkspace") return { workspacePath: "/game" };
      if (method === "start") throw new Error("Host disconnected before dispatch");
      if (method === "status") throw new Error("ENOENT: no such file or directory");
      if (method === "reconcileMissing") return { missing: true };
      throw new Error("Unexpected host call");
    },
  });
  await plugin(bb);
  await bb.storage.kv.set("game:game", {
    id: "game",
    name: "Orbit",
    projectId: "project",
    hostId: "remote",
    rootPath: "/game",
    kind: "unity",
    createdAt: 0,
    threadId: "thread",
    previewPath: "index.html",
  });
  const slots = new SlotStore(bb.storage.database());
  const slot = slots.register("remote", "/game", "project");
  const preparing = slots.acquire(slot.id, "remote", "project", "thread"),
    leased = slots.completeAcquire(slot.id, preparing.leaseId!);
  await expect(
    approving(harness, () =>
      harness.callAgentTool(
        "game_studio_generate_image",
        { gameId: "game", requestId: "lost", prompt: "A moon" },
        { threadId: "thread" },
      ),
    ),
  ).rejects.toThrow("Host disconnected");
  expect(() => slots.beginRelease(leased.id, "thread", leased.leaseId!)).toThrow("generation jobs");
  const result = JSON.parse(
    (await harness.callAgentTool(
      "game_studio_generation",
      { gameId: "game", jobId: "lost", action: "status" },
      { threadId: "thread" },
    )) as string,
  );
  expect(result.status).toBe("not-submitted");
  expect(slots.beginRelease(leased.id, "thread", leased.leaseId!).state).toBe("releasing");
  expect(calls.filter((method) => method === "reconcileMissing")).toEqual(["reconcileMissing"]);
});

test("status defers adoption outside a checkout lease and fences release during concurrent adoption", async () => {
  const { SlotStore } = await import("../lib/slot-store.ts");
  const { GenerationWork } = await import("../lib/generation-work.ts");
  for (const state of ["quarantined", "releasing", "leased"] as const) {
    let writes = 0;
    let allowRead!: () => void, observedRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      allowRead = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      observedRead = resolve;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "game-studio",
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({
              id: "thread",
              projectId: "project",
              environmentId: "environment",
            }),
        },
        environments: { get: async () => ({ hostId: "remote", path: "/game" }) as never },
        files: {
          read: async () => {
            observedRead();
            await readGate;
            throw new Error("ENOENT");
          },
          write: async () => {
            writes++;
            return { outcome: "written", sha256: "a".repeat(64) } as never;
          },
        },
      },
      experimental_callHostRpc: ({ method }) => {
        if (method === "mediaDir") return { dir: "/game/canvas" };
        if (method === "resolveWorkspace") return { workspacePath: "/game" };
        if (method === "status")
          return generationJob.parse({
            version: 1,
            id: "finished",
            threadId: "thread",
            createdAt: 1,
            updatedAt: 1,
            status: "succeeded",
            request: mediaRequest.parse({ kind: "image", prompt: "A moon" }),
            outputs: [],
          });
        throw new Error("Unexpected host call");
      },
    });
    await plugin(bb);
    await bb.storage.kv.set("game:game", {
      id: "game",
      name: "Orbit",
      projectId: "project",
      hostId: "remote",
      rootPath: "/game",
      kind: "unity",
      createdAt: 0,
      threadId: "thread",
      previewPath: "index.html",
    });
    const slots = new SlotStore(bb.storage.database()),
      work = new GenerationWork(slots);
    const slot = slots.register("remote", "/game", "project");
    const preparing = slots.acquire(slot.id, "remote", "project", "thread");
    const leased = slots.completeAcquire(slot.id, preparing.leaseId!);
    if (state === "quarantined") {
      work.reserve("remote", "/game", "finished", "thread");
      slots.quarantine(slot.id, leased.leaseId!, "Interrupted Editor");
    } else if (state === "releasing") slots.beginRelease(slot.id, "thread", leased.leaseId!);
    const status = () =>
      harness.callAgentTool(
        "game_studio_generation",
        { gameId: "game", jobId: "finished", action: "status" },
        { threadId: "thread" },
      );
    const first = status();
    if (state === "leased") {
      await reading;
      const second = status();
      // Let the second RPC reach the adoption while the first file read is held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(() => slots.beginRelease(slot.id, "thread", leased.leaseId!)).toThrow(
        "generation jobs",
      );
      allowRead();
      await Promise.all([first, second]);
      expect(writes).toBe(1);
      expect(slots.beginRelease(slot.id, "thread", leased.leaseId!).state).toBe("releasing");
    } else {
      const result = JSON.parse((await first) as string);
      expect(result.adoption.deferred).toBe(true);
      expect(writes).toBe(0);
      expect(work.owner("remote", "/game", "finished")).toBeNull();
      allowRead();
    }
  }
});

test("another thread can read a completed job and adopt it without replacing its request owner", async () => {
  const { Generations } = await import("../lib/generations.ts");
  const { SlotStore } = await import("../lib/slot-store.ts");
  const { GenerationWork } = await import("../lib/generation-work.ts");
  let catalog = "",
    writes = 0;
  const { bb } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, projectId: "project", environmentId: "environment" }),
      },
      environments: { get: async () => ({ hostId: "remote", path: "/game" }) as never },
      files: {
        read: async () => {
          throw new Error("ENOENT");
        },
        write: async ({ content }) => {
          writes++;
          catalog = content;
          return { outcome: "written", sha256: "a".repeat(64) } as never;
        },
      },
    },
    experimental_callHostRpc: ({ method }) => {
      if (method === "mediaDir") return { dir: "/game/canvas" };
      if (method === "resolveWorkspace") return { workspacePath: "/game" };
      if (method === "status")
        return generationJob.parse({
          version: 1,
          id: "finished",
          threadId: "requester",
          createdAt: 1,
          updatedAt: 1,
          status: "succeeded",
          request: mediaRequest.parse({ kind: "image", prompt: "A moon" }),
          outputs: [
            {
              path: "canvas/staging/finished/moon.png",
              type: "image",
              sizeBytes: 4,
              sha256: "a".repeat(64),
            },
          ],
        });
      throw new Error("Unexpected host call");
    },
  });
  await bb.storage.kv.set("game:game", {
    id: "game",
    name: "Orbit",
    projectId: "project",
    hostId: "remote",
    rootPath: "/game",
    kind: "unity",
    createdAt: 0,
    threadId: "requester",
    previewPath: "index.html",
  });
  const slots = new SlotStore(bb.storage.database()),
    generations = new Generations(bb, async () => ({}), slots, {
      ask: async () => ({ outcome: "submitted" as const, value: { approved: true } }),
    }),
    work = new GenerationWork(slots);
  work.reserve("remote", "/game", "finished", "requester");
  const result = await generations.control(
    { gameId: "game", jobId: "finished", action: "status" },
    "observer",
  );
  expect(result.job?.status).toBe("succeeded");
  expect(writes).toBe(1);
  expect(catalog).toContain("canvas/staging/finished/moon.png");
  expect(work.owner("remote", "/game", "finished")).toBeNull();
});

test("canvas job controls work without a main chat thread and cannot control agent-origin work", async () => {
  const { Generations } = await import("../lib/generations.ts");
  const { SlotStore } = await import("../lib/slot-store.ts");
  const { GenerationWork } = await import("../lib/generation-work.ts");
  let missing = false,
    agentOrigin = false;
  const calls: string[] = [];
  const job = generationJob.parse({
    version: 1,
    id: "direct-job",
    threadId: null,
    origin: { kind: "canvas", gameId: "game" },
    createdAt: 1,
    updatedAt: 1,
    status: "running",
    request: { kind: "image", prompt: "A key" },
    outputs: [],
  });
  const { bb } = createFakePluginHost({
    pluginId: "game-studio",
    experimental_callHostRpc: ({ method }) => {
      if (method === "mediaDir") return { dir: "/game/canvas" };
      calls.push(method);
      if (method === "resolveWorkspace") return { workspacePath: "/game" };
      if (method === "status") {
        if (missing) throw new Error("ENOENT: no such file or directory");
        return { ...job, origin: agentOrigin ? { kind: "agent" } : job.origin };
      }
      if (method === "cancel") return { ...job, status: "cancelled" };
      if (method === "reconcileMissing") return { missing: true };
      throw new Error(`Unexpected ${method}`);
    },
  });
  await bb.storage.kv.set("game:game", {
    id: "game",
    name: "Orbit",
    projectId: "project",
    hostId: "host",
    rootPath: "/game",
    kind: "unity",
    createdAt: 0,
    threadId: null,
  });
  const slots = new SlotStore(bb.storage.database()),
    work = new GenerationWork(slots);
  const service = new Generations(
    bb,
    async () => {
      throw new Error("Status must not request provider credentials");
    },
    slots,
    { ask: async () => ({ outcome: "submitted" as const, value: { approved: true } }) },
  );
  const input = { gameId: "game", jobId: "direct-job", threadId: null, action: "status" as const };
  expect((await service.directControl(input)).job?.status).toBe("running");
  agentOrigin = true;
  await expect(service.directControl({ ...input, action: "cancel" })).rejects.toThrow(
    "not started from this canvas",
  );
  expect(calls.filter((method) => method === "cancel")).toEqual([]);
  agentOrigin = false;
  expect((await service.directControl({ ...input, action: "cancel" })).job?.status).toBe(
    "cancelled",
  );
  work.reserve("host", "/game", "missing", "canvas:game");
  missing = true;
  expect((await service.directControl({ ...input, jobId: "missing" })).job).toBeNull();
  expect(work.owner("host", "/game", "missing")).toBeNull();
  expect(calls.filter((method) => method === "reconcileMissing")).toEqual(["reconcileMissing"]);
});

test("a paid agent request waits for the person, and a decline submits nothing", async () => {
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, projectId: "project", environmentId: "env" }),
      },
      environments: { get: async () => ({ id: "env", hostId: "remote", path: "/game" }) as never },
    },
    experimental_callHostRpc: async ({ method }) => {
      calls.push(method);
      if (method === "resolveWorkspace") return { workspacePath: "/game" };
      throw new Error(`Unexpected host call ${method}`);
    },
  });
  await plugin(bb);
  await bb.storage.kv.set("game:game", {
    id: "game",
    name: "Moon",
    projectId: "project",
    hostId: "remote",
    rootPath: "/game",
    kind: "unity",
    createdAt: 0,
    threadId: "thread",
    previewPath: "index.html",
  });
  const call = harness.callAgentTool(
    "game_studio_generate_image",
    { gameId: "game", requestId: "declined", prompt: "A moon icon", outputCount: 4 },
    { threadId: "thread" },
  );
  while (!harness.pendingInteractions.length) await new Promise((r) => setTimeout(r, 2));
  const form = harness.pendingInteractions[0]!;
  expect(form.threadId).toBe("thread");
  expect(form.title).toBe("Approve a generation for Moon");
  expect(generationApprovalPayload.parse(form.payload).items).toEqual([
    expect.objectContaining({
      requestId: "declined",
      provider: "google",
      model: "gemini-nano-banana-2.1",
      count: 4,
    }),
  ]);
  harness.submitInteraction(form.id, { approved: false });
  expect(JSON.parse((await call) as string)).toMatchObject({ declined: true });
  expect(calls).not.toContain("start");
});
