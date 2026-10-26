import { afterEach, expect, test } from "bun:test";
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
import { CanvasRunStore } from "./canvas-runs.ts";

/*
 * A run from the canvas makes the inputs it is missing first. These tests drive the real
 * server over a temporary checkout and a fake host that records every dispatch, so they pin
 * what starts now, what waits, and what starts once an input lands.
 */

type Start = Parameters<GenerationRunner["start"]>[0];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "studio-canvas-runs-"));
  const starts: Start[] = [];
  const hostJobs = new Map<string, GenerationJob>();
  const canvas = canvasHostRouter(
    () => nodeDisk,
    async (root) => ({
      workspacePath: root,
      jobs: [...hostJobs.values()].map((job) => structuredClone(job)),
      stale: false,
    }),
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, projectId: "project", environmentId: "environment" }),
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
      if (canvas.handles(method)) return canvas.call(method, input, hostId);
      if (method === "resolveWorkspace") return { workspacePath: rootPath };
      const target = input as { jobId?: string };
      if (method === "status") {
        const job = hostJobs.get(target.jobId!);
        if (!job) throw new Error("ENOENT: generation job has not been created");
        return structuredClone(job);
      }
      if (method === "list") return [...hostJobs.values()].map((job) => structuredClone(job));
      if (method === "reconcileMissing") return { missing: !hostJobs.has(target.jobId!) };
      if (method !== "start") throw new Error(`Unexpected host call: ${method}`);
      const submitted = input as Start;
      starts.push(structuredClone(submitted));
      const existing = hostJobs.get(submitted.jobId);
      if (existing) return { created: false, job: structuredClone(existing) };
      const job = generationJob.parse({
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
      hostJobs.set(job.id, job);
      return { created: true, job: structuredClone(job) };
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
  await seed("canvas/index.json", {
    version: 1,
    boards: [{ id: "main", name: "Design board" }],
    documents: [],
  });
  await seed("canvas/assets.json", { version: 1, assets: {} });
  const image = (id: string, prompt: string, inputs: string[], data = {}) => ({
    id,
    type: "image",
    title: id,
    data: {
      prompt,
      images: inputs.map((nodeId) => ({ type: "node", nodeId, studioEdgeId: `${nodeId}-${id}` })),
      ...data,
    },
  });
  await seed("canvas/boards/main.json", {
    version: 1,
    id: "main",
    viewport: { width: 1280, height: 720 },
    edges: [],
    nodes: [
      { id: "note", type: "text", title: "Brief", data: { text: "A brass key" } },
      image("concept", "Concept art", ["note"]),
      image("final", "Final render", ["concept"]),
      image("alt", "Alternate render", ["concept"]),
      image("sketch", "Poster sketch", ["concept"]),
      image("poster", "Poster", ["sketch"]),
      {
        id: "mesh",
        type: "model-3d",
        title: "Mesh",
        data: {
          recipe: "model-3d",
          images: [{ type: "node", nodeId: "concept", port: "front", studioEdgeId: "c-m" }],
        },
      },
    ],
  });
  const slots = new SlotStore(bb.storage.database());
  const slot = slots.register("host", rootPath, "project");
  const acquiring = slots.acquire(slot.id, "host", "project", "thread");
  slots.completeAcquire(slot.id, acquiring.leaseId!);
  const generations = new Generations(bb, async () => ({ vertexProject: "studio-test" }), slots, {
    ask: async () => ({ outcome: "submitted" as const, value: { approved: true } }),
  });
  const runs = new CanvasRunStore(bb.storage.database());
  const work = new GenerationWork(slots);
  cleanups.push(async () => {
    generations.dispose();
    await harness.lifecycle.dispose();
    await rm(rootPath, { recursive: true, force: true });
  });
  const completeHostJob = async (id: string) => {
    const job = hostJobs.get(id)!;
    const path = `canvas/staging/${id}/out.png`;
    const bytes = Buffer.from(`image ${id}`);
    await seed(path, bytes.toString());
    hostJobs.set(id, {
      ...job,
      status: "succeeded",
      updatedAt: 2,
      outputs: [{ path, type: "image", sizeBytes: bytes.length, sha256: hash(bytes) }],
    });
  };
  const run = async (nodeId: string, requestId = `${nodeId}-request`) => {
    const workspace = await loadWorkspace(bb, "orbit");
    return generations.direct({
      gameId: "orbit",
      boardId: "main",
      nodeId,
      revision: workspace.boards[0]!.revision,
      requestId,
      threadId: "thread",
      upstream: true,
    });
  };
  return { bb, rootPath, starts, hostJobs, generations, runs, work, completeHostJob, run };
}

test("running a node makes its missing inputs first, then runs it once they land", async () => {
  const f = await fixture();
  const first = await f.run("final");
  // The concept has no output, so it runs now; the final render waits for it.
  expect(first.jobs.map((job) => job.target?.nodeId)).toEqual(["concept"]);
  expect(first.waiting).toEqual(["final"]);
  expect(first.gate).toBeUndefined();
  const [conceptId] = f.starts.map((start) => start.jobId);
  expect(conceptId).not.toBe("final-request");
  expect(f.runs.get("orbit", "main", "final")).toMatchObject({
    requestId: "final-request",
    threadId: "thread",
    batch: 1,
  });
  // A second run that needs the same input waits for the one generation of it.
  const second = await f.run("alt");
  expect(second).toMatchObject({ jobs: [], waiting: ["concept", "alt"] });
  expect(f.starts).toHaveLength(1);
  const shown = await f.generations.refresh(
    (await loadWorkspace(f.bb, "orbit")).game,
    await (await import("./studio.ts")).loadCanvas(f.bb, "orbit"),
  );
  expect(Object.keys(shown.pending.main!).sort()).toEqual(["alt", "final"]);
  // The concept lands: its first take becomes its pick, and both held runs dispatch under
  // the thread that owns the checkout, with the new pick captured as their input.
  await f.completeHostJob(conceptId!);
  await f.generations.list("orbit");
  expect(f.starts.map((start) => start.jobId).sort()).toEqual(
    ["alt-request", conceptId!, "final-request"].sort(),
  );
  const final = f.starts.find((start) => start.jobId === "final-request")!;
  expect(final.threadId).toBe("thread");
  expect(final.request).toMatchObject({ kind: "image", prompt: "Final render" });
  expect((final.request as { images: string[] }).images[0]).toMatch(/^canvas\/inputs\//);
  expect(f.work.owner("host", f.rootPath, "final-request")).toBe("thread");
  expect(f.runs.list("orbit")).toEqual([]);
  const workspace = await loadWorkspace(f.bb, "orbit");
  expect(workspace.boards[0]!.freshness).toMatchObject({ note: "fresh", concept: "fresh" });
  // Running the concept again with its pick in place is a reroll, not a cascade.
  await f.completeHostJob("final-request");
  await f.generations.list("orbit");
  const reroll = await f.run("concept", "concept-again");
  expect(reroll).toMatchObject({ waiting: [] });
  expect(reroll.jobs.map((job) => job.id)).toEqual(["concept-again"]);
});

test("a run stops before a step whose approved input it just made, and a held run can be dropped", async () => {
  const f = await fixture();
  const result = await f.run("mesh");
  expect(result.jobs.map((job) => job.target?.nodeId)).toEqual(["concept"]);
  expect(result.waiting).toEqual([]);
  expect(result.gate).toEqual({ nodeId: "mesh", port: "front", sourceId: "concept" });
  expect(f.runs.list("orbit")).toEqual([]);
  // The concept is already in flight, so a run that needs it waits rather than making another.
  const held = await f.run("final");
  expect(held).toMatchObject({ jobs: [], waiting: ["concept", "final"] });
  // A held run is the server's: cancelling names the request so a newer hold survives.
  expect(
    await f.generations.cancel({
      gameId: "orbit",
      boardId: "main",
      nodeId: "final",
      requestId: "someone-elses",
      threadId: "thread",
    }),
  ).toEqual({ cancelled: false });
  expect(
    await f.generations.cancel({
      gameId: "orbit",
      boardId: "main",
      nodeId: "final",
      requestId: "final-request",
      threadId: "thread",
    }),
  ).toEqual({ cancelled: true });
  expect(f.runs.list("orbit")).toEqual([]);
  // Once cancelled, the landing input dispatches nothing.
  await f.completeHostJob(f.starts[0]!.jobId);
  await f.generations.list("orbit");
  expect(f.starts).toHaveLength(1);
});

test("a held run whose job already exists is released without a second submission", async () => {
  const f = await fixture();
  await f.run("final");
  const [conceptId] = f.starts.map((start) => start.jobId);
  await f.completeHostJob(conceptId!);
  await f.generations.list("orbit");
  expect(f.starts).toHaveLength(2);
  // The release after dispatch was lost: the next advance finds the job by id and lets it be.
  f.runs.hold({
    gameId: "orbit",
    boardId: "main",
    nodeId: "final",
    requestId: "final-request",
    threadId: "thread",
    agent: null,
    options: null,
    origin: null,
    batch: 1,
  });
  await f.generations.advance("orbit");
  expect(f.starts).toHaveLength(2);
  expect(f.runs.list("orbit")).toEqual([]);
  // A batch whose first request reached the host before a crash finishes with the rest.
  f.hostJobs.set(
    "batch-request-b0",
    generationJob.parse({
      version: 1,
      id: "batch-request-b0",
      threadId: "thread",
      origin: { kind: "canvas", gameId: "orbit" },
      createdAt: 1,
      updatedAt: 1,
      status: "running",
      request: { kind: "image", prompt: "Final render" },
      target: { boardId: "main", nodeId: "final", fingerprint: "f" },
      outputs: [],
    }),
  );
  f.runs.hold({
    gameId: "orbit",
    boardId: "main",
    nodeId: "final",
    requestId: "batch-request",
    threadId: "thread",
    agent: null,
    options: null,
    origin: null,
    batch: 4,
  });
  await f.generations.advance("orbit");
  expect(
    f.starts
      .slice(2)
      .map((start) => start.jobId)
      .sort(),
  ).toEqual(["batch-request-b1", "batch-request-b2", "batch-request-b3"]);
  expect(f.runs.list("orbit")).toEqual([]);
});

test("cancelling a waiting run drops the inputs it was making that still wait", async () => {
  const f = await fixture();
  // poster <- sketch <- concept: the concept starts, the sketch and poster wait.
  const result = await f.run("poster");
  expect(result.jobs.map((job) => job.target?.nodeId)).toEqual(["concept"]);
  expect(result.waiting).toEqual(["sketch", "poster"]);
  expect(
    f.runs
      .list("orbit")
      .map((run) => [run.nodeId, run.origin])
      .sort(),
  ).toEqual([
    ["poster", null],
    ["sketch", "poster-request"],
  ]);
  await f.generations.cancel({
    gameId: "orbit",
    boardId: "main",
    nodeId: "poster",
    requestId: "poster-request",
    threadId: "thread",
  });
  expect(f.runs.list("orbit")).toEqual([]);
  // The concept keeps generating and lands as its own take; nothing else starts.
  await f.completeHostJob(f.starts[0]!.jobId);
  await f.generations.list("orbit");
  expect(f.starts).toHaveLength(1);
});
