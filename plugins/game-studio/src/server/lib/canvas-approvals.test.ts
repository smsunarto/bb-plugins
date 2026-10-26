import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginInteractionRequest, PluginInteractionResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { GenerationRunner } from "../../host/generation.ts";
import { generationJob, type GenerationJob } from "../../shared/generation.ts";
import { generationApprovalPayload } from "../../shared/approvals.ts";
import { canvasEditInput } from "../../shared/canvas-agent.ts";
import { Generations } from "./generations.ts";
import { SlotStore } from "./slot-store.ts";
import { loadWorkspace } from "./studio.ts";
import { nodeDisk } from "../../host/canvas.ts";
import { canvasHostRouter } from "../../../test/canvas-host.ts";
import { ApprovalStore } from "./canvas-approvals.ts";
import { CanvasRunStore } from "./canvas-runs.ts";

/*
 * A paid run an agent starts asks the person once, for everything it will make, and the
 * answer binds to the request ids it runs under. These tests drive the agent's tool path with
 * a stubbed form, so they pin what is asked, what runs after, and what never starts.
 */

type Start = Parameters<GenerationRunner["start"]>[0];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(answer: () => PluginInteractionResult) {
  const rootPath = await mkdtemp(join(tmpdir(), "studio-approvals-"));
  const starts: Start[] = [];
  const asked: PluginInteractionRequest[] = [];
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
      recipe: "nano-banana",
      prompt,
      images: inputs.map((nodeId) => ({ type: "node", nodeId, studioEdgeId: `${nodeId}-${id}` })),
      ...data,
    },
  });
  const board = {
    version: 1,
    id: "main",
    viewport: { width: 1280, height: 720 },
    edges: [],
    nodes: [
      { id: "note", type: "text", title: "Brief", data: { text: "A brass key" } },
      image("concept", "Concept art", ["note"]),
      image("final", "Final render", ["concept"], { review: { enabled: true, retries: 1 } }),
      image("alt", "Alternate render", ["concept"]),
    ],
  };
  await seed("canvas/boards/main.json", board);
  const slots = new SlotStore(bb.storage.database());
  const slot = slots.register("host", rootPath, "project");
  const acquiring = slots.acquire(slot.id, "host", "project", "thread");
  slots.completeAcquire(slot.id, acquiring.leaseId!);
  const generations = new Generations(bb, async () => ({ vertexProject: "studio-test" }), slots, {
    ask: async (request) => {
      asked.push(request);
      return answer();
    },
  });
  const approvals = new ApprovalStore(bb.storage.database());
  const runs = new CanvasRunStore(bb.storage.database());
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
  /** The agent's tool call: a run to a node with its missing inputs first. */
  const agentRun = async (nodeId: string, requestId = `${nodeId}-request`) => {
    const workspace = await loadWorkspace(bb, "orbit");
    return generations.canvas(
      {
        gameId: "orbit",
        boardId: "main",
        nodeId,
        revision: workspace.boards[0]!.revision,
        requestId,
        upstream: true,
      },
      "thread",
    );
  };
  const items = (request: PluginInteractionRequest) =>
    generationApprovalPayload.parse(request.payload).items;
  return {
    bb,
    rootPath,
    starts,
    asked,
    items,
    generations,
    approvals,
    runs,
    completeHostJob,
    agentRun,
    seed,
  };
}

test("an agent's run asks once for everything it will make, then runs under that approval", async () => {
  const f = await fixture(() => ({ outcome: "submitted", value: { approved: true } }));
  const result = await f.agentRun("final");
  expect(f.asked).toHaveLength(1);
  expect(f.asked[0]!.title).toBe("Approve 2 generations for Orbit");
  // The form lists the concept (made first) and the final render, with the retry its review may add.
  expect(f.items(f.asked[0]!)).toEqual([
    expect.objectContaining({ nodeId: "concept", provider: "google", count: 1, retries: 0 }),
    expect.objectContaining({ nodeId: "final", requestId: "final-request", count: 1, retries: 1 }),
  ]);
  expect(result).toMatchObject({ waiting: ["final"] });
  expect("jobs" in result && result.jobs.map((job) => job.target?.nodeId)).toEqual(["concept"]);
  // The approval binds to the request ids the plan runs under, with the budget each may spend.
  const conceptId = f.starts[0]!.jobId;
  expect(f.approvals.get("orbit", conceptId)).toMatchObject({ budget: 1, used: 1 });
  expect(f.approvals.get("orbit", "final-request")).toMatchObject({ budget: 2, used: 0 });
  expect(f.runs.get("orbit", "main", "final")?.options).toMatchObject({
    approved: { provider: "google", model: "gemini-nano-banana-2.1" },
  });
  // The concept lands: the held run dispatches without asking again.
  await f.completeHostJob(conceptId);
  await f.generations.list("orbit");
  expect(f.starts.map((start) => start.jobId)).toEqual([conceptId, "final-request"]);
  expect(f.asked).toHaveLength(1);
  expect(f.approvals.get("orbit", "final-request")).toMatchObject({ used: 1 });
  // Another run asks again: nothing was granted for the game.
  await f.completeHostJob("final-request");
  await f.generations.list("orbit");
  await f.agentRun("alt");
  expect(f.asked).toHaveLength(2);
});

test("an edit that runs asks before anything is saved, then saves and runs as one", async () => {
  let nodesWhenAsked = 0;
  const f = await fixture(() => ({ outcome: "submitted", value: { approved: true } }));
  const boardFile = () =>
    JSON.parse(readFileSync(join(f.rootPath, "canvas/boards/main.json"), "utf8"));
  f.generations.setGrant("orbit", null);
  const ask = f.asked;
  const editRun = async (approved: boolean) => {
    const workspace = await loadWorkspace(f.bb, "orbit");
    return f.generations.editCanvas(
      canvasEditInput.parse({
        gameId: "orbit",
        boardId: "main",
        revision: workspace.boards[0]!.revision,
        operations: [
          { op: "add_node", node: { id: "hero", type: "image", data: { prompt: "Hero shot" } } },
        ],
        run: { nodeId: "hero", requestId: `hero-${approved ? "yes" : "no"}` },
      }),
      "thread",
    );
  };
  // Approval is asked for from the edited board, before it is saved.
  const generations = new Generations(
    f.bb,
    async () => ({ vertexProject: "studio-test" }),
    new SlotStore(f.bb.storage.database()),
    {
      ask: async (request) => {
        nodesWhenAsked = boardFile().nodes.length;
        ask.push(request);
        return { outcome: "submitted", value: { approved: false } };
      },
    },
  );
  cleanups.push(async () => generations.dispose());
  const declined = await (async () => {
    const workspace = await loadWorkspace(f.bb, "orbit");
    return generations.editCanvas(
      canvasEditInput.parse({
        gameId: "orbit",
        boardId: "main",
        revision: workspace.boards[0]!.revision,
        operations: [
          { op: "add_node", node: { id: "hero", type: "image", data: { prompt: "Hero shot" } } },
        ],
        run: { nodeId: "hero", requestId: "hero-no" },
      }),
      "thread",
    );
  })();
  expect(nodesWhenAsked).toBe(4);
  expect(f.items(ask[0]!)).toEqual([
    expect.objectContaining({ nodeId: "hero", requestId: "hero-no", provider: "google" }),
  ]);
  expect(declined).toMatchObject({ declined: true, saved: false });
  expect(boardFile().nodes).toHaveLength(4);
  expect(f.starts).toHaveLength(0);
  // Approved: the edit lands and the run starts from the saved board under the same ids.
  const result = await editRun(true);
  expect(result).toMatchObject({
    saved: true,
    editId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    run: {
      waiting: [],
      jobs: [
        expect.objectContaining({
          id: "hero-yes",
          target: expect.objectContaining({ boardId: "main", nodeId: "hero" }),
        }),
      ],
    },
  });
  expect(boardFile().nodes).toHaveLength(5);
  expect(f.starts.map((start) => start.jobId)).toEqual(["hero-yes"]);
  expect(f.approvals.get("orbit", "hero-yes")).toMatchObject({ budget: 1, used: 1 });
  expect((await loadWorkspace(f.bb, "orbit")).boards[0]!.revision).toBe(result.revision);
  // A dry run plans without asking or saving.
  const workspace = await loadWorkspace(f.bb, "orbit");
  const dry = await f.generations.editCanvas(
    canvasEditInput.parse({
      gameId: "orbit",
      boardId: "main",
      revision: workspace.boards[0]!.revision,
      dryRun: true,
      operations: [{ op: "update_node", id: "alt", patch: { data: { prompt: "Alt shot" } } }],
      run: { nodeId: "alt", requestId: "alt-dry" },
    }),
    "thread",
  );
  expect(dry).toMatchObject({ saved: false, run: { planned: ["concept", "alt"] } });
  expect(f.asked).toHaveLength(2);
});

test("a declined run starts nothing and tells the agent so", async () => {
  const f = await fixture(() => ({ outcome: "submitted", value: { approved: false } }));
  const result = await f.agentRun("final");
  expect(result).toMatchObject({ declined: true });
  expect(f.starts).toHaveLength(0);
  expect(f.runs.list("orbit")).toEqual([]);
  expect(f.approvals.get("orbit", "final-request")).toBeUndefined();
});

test("a game approved in advance stops asking until the person turns it off", async () => {
  const f = await fixture(() => ({
    outcome: "submitted",
    value: { approved: true, grantGame: true },
  }));
  await f.agentRun("final");
  expect(f.asked).toHaveLength(1);
  expect(f.generations.grant("orbit")).toMatchObject({ threadId: "thread" });
  await f.agentRun("alt");
  expect(f.asked).toHaveLength(1);
  // The budget is still recorded, so a granted run spends like an approved one.
  expect(f.approvals.get("orbit", "alt-request")).toMatchObject({ budget: 1 });
  f.generations.setGrant("orbit", null);
  await f.completeHostJob(f.starts[0]!.jobId);
  await f.generations.list("orbit");
  await f.agentRun("final", "final-again");
  expect(f.asked).toHaveLength(2);
});

test("a held run whose model changed after approval waits for a new one instead of running", async () => {
  const f = await fixture(() => ({ outcome: "submitted", value: { approved: true } }));
  await f.agentRun("final");
  const [conceptId] = f.starts.map((start) => start.jobId);
  // The final render switches to Midjourney while its input generates.
  const current = JSON.parse(await readFile(join(f.rootPath, "canvas/boards/main.json"), "utf8"));
  current.nodes[2].data.recipe = "concept-art";
  await f.seed("canvas/boards/main.json", current);
  await f.completeHostJob(conceptId!);
  await f.generations.list("orbit");
  expect(f.starts).toHaveLength(1);
  expect(f.runs.get("orbit", "main", "final")?.error).toMatch(/model changed after approval/);
});

test("a lineage's budget is spent by dispatches and refuses what exceeds it", async () => {
  const f = await fixture(() => ({ outcome: "submitted", value: { approved: true } }));
  f.approvals.grant({
    gameId: "orbit",
    root: "r",
    threadId: "thread",
    boardId: "main",
    nodeId: "final",
    budget: 2,
    spec: { provider: "google" },
  });
  expect(f.approvals.consume("orbit", "r", 1)).toBe(true);
  expect(f.approvals.consume("orbit", "r", 2)).toBe(false);
  expect(f.approvals.consume("orbit", "r", 1)).toBe(true);
  expect(f.approvals.consume("orbit", "r", 1)).toBe(false);
  // A lineage nobody approved, such as a run from the canvas, is unrestricted.
  expect(f.approvals.consume("orbit", "ui-run", 4)).toBe(true);
});
