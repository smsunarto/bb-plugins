import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { GenerationRunner } from "../../host/generation.ts";
import { generationJob, type GenerationJob } from "../../shared/generation.ts";
import { Generations } from "./generations.ts";
import { GenerationWork } from "./generation-work.ts";
import { SlotStore } from "./slot-store.ts";
import { loadWorkspace } from "./studio.ts";
import { nodeDisk } from "../../host/canvas.ts";
import { canvasHostRouter } from "../../../test/canvas-host.ts";

type Start = Parameters<GenerationRunner["start"]>[0];
const shaA = "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd";
const reference = "references/hero.png";
const snapshot = `canvas/inputs/${shaA}.png`;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture({ registered = true } = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), "studio-canvas-inputs-"));
  const starts: { input: Start; images: string[] }[] = [];
  const capturePhases: string[] = [];
  const hostCalls: string[] = [];
  let captureGuard: ((phase: string) => void) | undefined;
  let failSourceRead = false;
  let hostJob: GenerationJob | undefined;
  let capturePause: { entered: () => void; released: Promise<void> } | undefined;
  const canvas = canvasHostRouter(
    () => nodeDisk,
    async (root) => ({
      workspacePath: root,
      jobs: hostJob ? [structuredClone(hostJob)] : [],
      stale: false,
    }),
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: threadId === "thread" ? "project" : "elsewhere",
            environmentId: "environment",
          }),
      },
      environments: {
        get: async () => ({ id: "environment", hostId: "host", path: rootPath }) as never,
      },
      files: {
        read: async ({ path }) => {
          const bytes = await readFile(path);
          const binary = /\.(png|jpe?g|webp)$/i.test(path);
          return {
            path,
            content: bytes.toString(binary ? "base64" : "utf8"),
            contentEncoding: binary ? "base64" : "utf8",
            sizeBytes: bytes.length,
            sha256: hash(bytes),
          } as never;
        },
        write: async ({ path, content, contentEncoding, expectedSha256, createParents }) => {
          const previous = await readFile(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (
            expectedSha256 !== undefined &&
            expectedSha256 !== (previous === null ? null : hash(previous))
          )
            return { outcome: "conflict", currentSha256: previous && hash(previous) } as never;
          if (createParents) await mkdir(dirname(path), { recursive: true });
          const bytes = Buffer.from(content, contentEncoding === "base64" ? "base64" : "utf8");
          await writeFile(path, bytes);
          return { outcome: "written", sha256: hash(bytes), sizeBytes: bytes.length } as never;
        },
        list: async () => ({ files: [], truncated: false }),
      },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      hostCalls.push(method);
      if (method === "captureCanvasInputs") {
        // The host reads the selected source, then writes its snapshot beside it.
        captureGuard?.("read");
        if (capturePause) {
          const pause = capturePause;
          capturePause = undefined;
          pause.entered();
          await pause.released;
        }
        if (failSourceRead) throw new Error("Reference temporarily unavailable");
        const captured = await canvas.call(method, input, hostId);
        captureGuard?.("write");
        return captured;
      }
      if (canvas.handles(method)) return canvas.call(method, input, hostId);
      if (method === "resolveWorkspace") return { workspacePath: rootPath };
      if (method === "status") {
        if (!hostJob) throw new Error("ENOENT: generation job has not been created");
        return structuredClone(hostJob);
      }
      if (method === "list") return hostJob ? [structuredClone(hostJob)] : [];
      if (method === "reconcileMissing") return { missing: hostJob === undefined };
      if (method !== "start") throw new Error(`Unexpected host call: ${method}`);
      const submitted = input as Start;
      if (submitted.request.kind !== "image") throw new Error("Expected an image request");
      // A source edit after capture must not change the bytes dispatched to the provider host.
      await writeFile(join(rootPath, reference), "B");
      const images = await Promise.all(
        submitted.request.images.map((path) => readFile(join(rootPath, path), "utf8")),
      );
      starts.push({ input: structuredClone(submitted), images });
      if (hostJob) return { created: false, job: structuredClone(hostJob) };
      hostJob = generationJob.parse({
        version: 1,
        id: submitted.jobId,
        threadId: submitted.threadId,
        origin: submitted.origin,
        createdAt: 1,
        updatedAt: 1,
        status: "running",
        request: submitted.request,
        target: submitted.target,
        outputs: [],
      });
      return { created: true, job: structuredClone(hostJob) };
    },
  });
  const seed = async (path: string, content: unknown) => {
    const absolute = join(rootPath, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, typeof content === "string" ? content : JSON.stringify(content));
  };
  await bb.storage.kv.set("game:orbit", {
    id: "orbit",
    name: "Orbit",
    projectId: "project",
    hostId: "host",
    rootPath,
    kind: "web",
    createdAt: 0,
    threadId: "thread",
  });
  await seed(reference, "A");
  await seed("canvas/index.json", {
    version: 1,
    boards: [{ id: "main", name: "Design board" }],
    documents: [],
  });
  await seed("canvas/assets.json", {
    version: 1,
    assets: { hero: { name: "Hero", path: reference } },
  });
  await seed("canvas/boards/main.json", {
    version: 1,
    id: "main",
    viewport: { width: 1280, height: 720 },
    nodes: [
      {
        id: "variation",
        type: "image",
        title: "Hero variation",
        data: { prompt: "Refine Hero", images: [{ type: "library", assetId: "hero" }] },
      },
    ],
    edges: [],
  });
  const slots = new SlotStore(bb.storage.database());
  const slot = registered ? slots.register("host", rootPath, "project") : undefined;
  const acquiring = slot && slots.acquire(slot.id, "host", "project", "thread");
  const leased = slot ? slots.completeAcquire(slot.id, acquiring!.leaseId!) : undefined;
  const generations = new Generations(
    bb,
    async () => ({ vertexProject: "studio-test-project" }),
    slots,
    { ask: async () => ({ outcome: "submitted" as const, value: { approved: true } }) },
  );
  const work = new GenerationWork(slots);
  captureGuard = (phase) => {
    if (leased)
      expect(() => slots.beginRelease(leased.id, "thread", leased.leaseId!)).toThrow(
        "generation jobs",
      );
    capturePhases.push(phase);
  };
  return {
    bb,
    rootPath,
    starts,
    capturePhases,
    hostCalls,
    generations,
    slots,
    leased: leased!,
    work,
    failSourceRead() {
      failSourceRead = true;
    },
    pauseSourceRead() {
      let entered!: () => void;
      let resume!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        resume = resolve;
      });
      capturePause = { entered, released };
      return { started, resume };
    },
    async completeHostJob() {
      if (!hostJob) throw new Error("No host job to complete");
      const path = "canvas/staging/variation-request/output.png";
      await seed(path, "complete");
      hostJob = {
        ...hostJob,
        status: "succeeded",
        outputs: [{ path, type: "image", sizeBytes: 8, sha256: hash(Buffer.from("complete")) }],
      };
      await seed(reference, "A");
    },
    async dispose() {
      await harness.lifecycle.dispose();
      await rm(rootPath, { recursive: true, force: true });
    },
  };
}

for (const control of ["directControl", "control"] as const) {
  test(`${control} waits for pending capture before checking a missing host job`, async () => {
    const f = await fixture();
    const pause = f.pauseSourceRead();
    const pending: Promise<unknown>[] = [];
    try {
      const workspace = await loadWorkspace(f.bb, "orbit");
      const submission = f.generations.direct({
        gameId: "orbit",
        boardId: "main",
        nodeId: "variation",
        revision: workspace.boards[0]!.revision,
        requestId: "variation-request",
        threadId: "thread",
      });
      pending.push(submission);
      await pause.started;
      const input = { gameId: "orbit", jobId: "variation-request", action: "status" as const };
      let statusReturned = false;
      const status = (
        control === "directControl"
          ? f.generations.directControl({ ...input, threadId: "thread" })
          : f.generations.control(input, "thread")
      ).then((result) => {
        statusReturned = true;
        return result;
      });
      pending.push(status);
      // Run the status request's asynchronous authorization while the input read remains held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(statusReturned).toBe(false);
      expect(f.hostCalls.filter((method) => method === "reconcileMissing")).toEqual([]);
      expect(f.work.owner("host", f.rootPath, "variation-request")).toBe("thread");
      expect(() => f.slots.beginRelease(f.leased.id, "thread", f.leased.leaseId!)).toThrow(
        "generation jobs",
      );
      pause.resume();
      expect((await submission).jobs[0]!.status).toBe("running");
      expect(await status).toMatchObject({
        job: {
          id: "variation-request",
          status: "running",
          request: { images: [snapshot] },
          target: { imageRevisions: [{ path: reference, sha256: shaA }] },
        },
      });
      expect(f.work.owner("host", f.rootPath, "variation-request")).toBe("thread");
      expect(() => f.slots.beginRelease(f.leased.id, "thread", f.leased.leaseId!)).toThrow(
        "generation jobs",
      );
    } finally {
      pause.resume();
      await Promise.allSettled(pending);
      await f.dispose();
    }
  });
}

test("listing an older successful job cannot release a checkout while its retry captures inputs", async () => {
  const f = await fixture();
  let pause: ReturnType<typeof f.pauseSourceRead> | undefined;
  const pending: Promise<unknown>[] = [];
  try {
    const workspace = await loadWorkspace(f.bb, "orbit");
    const input = {
      gameId: "orbit",
      boardId: "main",
      nodeId: "variation",
      revision: workspace.boards[0]!.revision,
      requestId: "variation-request",
      threadId: "thread",
    };
    expect((await f.generations.direct(input)).jobs[0]!.status).toBe("running");
    await f.completeHostJob();
    pause = f.pauseSourceRead();
    const retry = f.generations.direct(input);
    pending.push(retry);
    await pause.started;
    const listing = f.generations.list("orbit");
    pending.push(listing);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.work.owner("host", f.rootPath, "variation-request")).toBe("thread");
    expect(() => f.slots.beginRelease(f.leased.id, "thread", f.leased.leaseId!)).toThrow(
      "generation jobs",
    );
    pause.resume();
    expect(await retry).toMatchObject({ jobs: [{ status: "succeeded" }], waiting: [] });
    expect(await listing).toMatchObject([{ id: "variation-request", status: "succeeded" }]);
    expect(f.slots.beginRelease(f.leased.id, "thread", f.leased.leaseId!).state).toBe("releasing");
  } finally {
    pause?.resume();
    await Promise.allSettled(pending);
    await f.dispose();
  }
});

for (const entry of ["direct", "canvas"] as const) {
  test(`${entry} dispatch freezes referenced bytes and binds their original source revision`, async () => {
    const f = await fixture();
    try {
      const workspace = await loadWorkspace(f.bb, "orbit");
      const input = {
        gameId: "orbit",
        boardId: "main",
        nodeId: "variation",
        revision: workspace.boards[0]!.revision,
        requestId: "variation-request",
      };
      const result =
        entry === "direct"
          ? (await f.generations.direct({ ...input, threadId: "thread" })).jobs[0]!
          : ((await f.generations.canvas(input, "thread")) as { created: boolean; job: unknown })
              .job;
      expect(result).toMatchObject({
        id: "variation-request",
        request: { kind: "image", prompt: "Refine Hero", images: [snapshot] },
        target: {
          boardId: "main",
          nodeId: "variation",
          imageRevisions: [{ path: reference, sha256: shaA }],
        },
      });
      expect(f.starts).toHaveLength(1);
      expect(f.capturePhases).toEqual(["read", "write"]);
      expect(f.starts[0]).toMatchObject({
        input: {
          rootPath: f.rootPath,
          request: { kind: "image", images: [snapshot] },
          target: { imageRevisions: [{ path: reference, sha256: shaA }] },
        },
        images: ["A"],
      });
      expect(await readFile(join(f.rootPath, reference), "utf8")).toBe("B");
      expect(await readFile(join(f.rootPath, snapshot), "utf8")).toBe("A");
    } finally {
      await f.dispose();
    }
  });
}

for (const existing of [false, true]) {
  test(`capture failure ${existing ? "preserves an existing" : "releases a new"} checkout reservation`, async () => {
    const f = await fixture();
    try {
      const workspace = await loadWorkspace(f.bb, "orbit");
      if (existing) f.work.reserve("host", f.rootPath, "variation-request", "thread");
      f.failSourceRead();
      await expect(
        f.generations.direct({
          gameId: "orbit",
          boardId: "main",
          nodeId: "variation",
          revision: workspace.boards[0]!.revision,
          requestId: "variation-request",
          threadId: "thread",
        }),
      ).rejects.toThrow("Reference temporarily unavailable");
      expect(f.capturePhases).toEqual(["read"]);
      expect(f.starts).toEqual([]);
      if (existing) {
        expect(f.work.owner("host", f.rootPath, "variation-request")).toBe("thread");
        expect(() => f.slots.beginRelease(f.leased.id, "thread", f.leased.leaseId!)).toThrow(
          "generation jobs",
        );
      } else {
        expect(f.slots.beginRelease(f.leased.id, "thread", f.leased.leaseId!).state).toBe(
          "releasing",
        );
      }
    } finally {
      await f.dispose();
    }
  });
}

test("canvas runs ignore a thread from another project unless it holds the checkout lease", async () => {
  const input = async (f: Awaited<ReturnType<typeof fixture>>) => ({
    gameId: "orbit",
    boardId: "main",
    nodeId: "variation",
    revision: (await loadWorkspace(f.bb, "orbit")).boards[0]!.revision,
    requestId: "variation-request",
    threadId: "other",
  });
  const open = await fixture({ registered: false });
  try {
    const result = await open.generations.direct(await input(open));
    expect(result.jobs.map((job) => job.threadId)).toEqual([null]);
  } finally {
    await open.dispose();
  }
  const leased = await fixture();
  try {
    await expect(leased.generations.direct(await input(leased))).rejects.toThrow(
      "Checkout is leased by @thread:thread",
    );
    expect(leased.starts).toEqual([]);
  } finally {
    await leased.dispose();
  }
});
