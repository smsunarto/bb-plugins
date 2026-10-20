import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { CanvasText } from "./canvas-text.ts";
import { GenerationRunner } from "../../host/generation.ts";
import { generationJob } from "../../shared/generation.ts";
import { gameSchema } from "../../shared/schema.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const rootPath = await mkdtemp(join(tmpdir(), "studio-text-"));
  roots.push(rootPath);
  const game = gameSchema.parse({
    id: "game",
    name: "Orbit",
    hostId: "host",
    projectId: "project",
    rootPath,
    kind: "unity",
    threadId: null,
    createdAt: 0,
  });
  const starts: unknown[] = [];
  let state: "active" | "idle" | "stopping" = "active";
  let loseReply = false;
  const runner = new GenerationRunner(async () => {
    throw new Error("Text must not use a provider CLI");
  });
  const hash = (content: string) => createHash("sha256").update(content).digest("hex");
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      projects: { list: async () => [{ id: "personal-project", kind: "personal" }] as never },
      providers: { list: async () => [{ id: "selected-provider" }] as never },
      threads: {
        spawn: async (input) => {
          starts.push(input);
          if (loseReply) throw new Error("Lost reply");
          return makeThreadResponse({ id: "hidden-run", status: "active" });
        },
        get: async () => makeThreadResponse({ id: "hidden-run", status: state }),
        stop: async () => {
          state = "stopping";
          return makeThreadResponse({ id: "hidden-run", status: state }) as never;
        },
        output: async () => ({ output: "# Brass key\nUnlocks the observatory." }) as never,
      },
      files: {
        read: async ({ path }) => {
          const buffer = await readFile(path);
          const binary = path.endsWith(".png");
          const content = binary ? buffer.toString("base64") : buffer.toString("utf8");
          return {
            path,
            content,
            contentEncoding: binary ? "base64" : "utf8",
            sizeBytes: buffer.length,
            sha256: hash(content),
          } as never;
        },
        write: async ({ path, content, expectedSha256, createParents }) => {
          const previous = await readFile(path, "utf8").catch(() => null);
          if ((previous === null ? null : hash(previous)) !== expectedSha256)
            return { outcome: "conflict" } as never;
          if (createParents) await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content);
          return { outcome: "written", sha256: hash(content) } as never;
        },
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "start") return runner.start(input as Parameters<typeof runner.start>[0]);
      if (method === "stagedOutputs")
        return runner.stagedOutputs(input as Parameters<typeof runner.stagedOutputs>[0]);
      throw new Error(`Unexpected ${method}`);
    },
  });
  const job = generationJob.parse({
    version: 1,
    id: "request",
    threadId: null,
    origin: { kind: "canvas", gameId: "game" },
    createdAt: 1,
    updatedAt: 1,
    status: "queued",
    outputs: [],
    request: {
      kind: "text",
      prompt: "Write item lore",
      providerId: "selected-provider",
      model: { provider: "bb", id: "selected-model" },
      images: ["canvas/staging/ref.png"],
    },
  });
  await mkdir(join(rootPath, "canvas/staging"), { recursive: true });
  await writeFile(join(rootPath, "canvas/staging/ref.png"), "png-image");
  return {
    bb,
    harness,
    game,
    job,
    starts,
    runner,
    setState: (value: typeof state) => {
      state = value;
    },
    loseReply: () => {
      loseReply = true;
    },
  };
}
test("inline text uses the selected BB provider/model and image input in an isolated hidden run, then recovers after reload", async () => {
  const f = await setup(),
    text = new CanvasText(f.bb);
  const started = await text.start(f.game, f.job);
  expect(started.job.status).toBe("running");
  expect(started.job.threadId).toBeNull();
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]).toMatchObject({
    projectId: "personal-project",
    providerId: "selected-provider",
    model: "selected-model",
    visibility: "hidden",
    environment: { type: "host", hostId: "host", workspace: { type: "personal" } },
    input: [
      { type: "text", text: expect.stringContaining("Write item lore") },
      { type: "image", url: "data:image/png;base64,cG5nLWltYWdl" },
    ],
  });
  expect((await text.start(f.game, f.job)).created).toBe(false);
  expect(f.starts).toHaveLength(1);
  expect((await f.runner.status({ rootPath: f.game.rootPath, jobId: "request" })).status).toBe(
    "running",
  );
  f.setState("idle");
  const finished = await new CanvasText(f.bb).status(f.game, "request");
  expect(finished.status).toBe("succeeded");
  expect(finished.outputs[0]).toMatchObject({
    path: "canvas/staging/request/output.md",
    type: "text",
    sizeBytes: 36,
  });
  expect(await readFile(join(f.game.rootPath, "canvas/staging/request/output.md"), "utf8")).toBe(
    "# Brass key\nUnlocks the observatory.",
  );
  expect((await text.start(f.game, f.job)).created).toBe(false);
  expect(f.starts).toHaveLength(1);
});
test("BB text receives ordered reference labels with both image inputs", async () => {
  const f = await setup();
  await writeFile(join(f.game.rootPath, "canvas/staging/palette.png"), "palette-image");
  const job = generationJob.parse({
    ...f.job,
    request: {
      ...f.job.request,
      images: ["canvas/staging/ref.png", "canvas/staging/palette.png"],
      imageReferenceKey: `Attached image references (in attachment order):
1. ["Key shape (node: shape)", "Handle silhouette"]
2. ["Blue palette (asset: palette)"]`,
    },
  });
  expect((await new CanvasText(f.bb).start(f.game, job)).job.status).toBe("running");
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]).toMatchObject({
    providerId: "selected-provider",
    model: "selected-model",
    input: [
      {
        type: "text",
        text: expect.stringContaining(`Write item lore

Attached image references (in attachment order):
1. ["Key shape (node: shape)", "Handle silhouette"]
2. ["Blue palette (asset: palette)"]`),
      },
      { type: "image", url: "data:image/png;base64,cG5nLWltYWdl" },
      { type: "image", url: "data:image/png;base64,cGFsZXR0ZS1pbWFnZQ==" },
    ],
  });
});
test("lost BB spawn reply stays uncertain without a second submission, and retirement fences late starts", async () => {
  const f = await setup();
  f.loseReply();
  const text = new CanvasText(f.bb);
  expect((await text.start(f.game, f.job)).job.status).toBe("uncertain");
  expect((await new CanvasText(f.bb).start(f.game, f.job)).created).toBe(false);
  expect(f.starts).toHaveLength(1);
  await f.runner.reconcileMissing({ rootPath: f.game.rootPath, jobId: "retired" });
  await expect(text.start(f.game, { ...f.job, id: "retired" })).rejects.toThrow("retired");
  expect(f.starts).toHaveLength(1);
});
test("cancellation waits for BB to stop and never adopts a partial response", async () => {
  const f = await setup(),
    text = new CanvasText(f.bb);
  await text.start(f.game, f.job);
  expect((await text.status(f.game, "request", true)).status).toBe("uncertain");
  expect((await new CanvasText(f.bb).status(f.game, "request")).status).toBe("uncertain");
  f.setState("idle");
  const stopped = await text.status(f.game, "request");
  expect(stopped.status).toBe("cancelled");
  expect(stopped.outputs).toEqual([]);
  await expect(readFile(join(f.game.rootPath, "canvas/staging/request/output.md"))).rejects.toThrow(
    "ENOENT",
  );
});

test("a brief run follows the target model's prompting guide and returns only the prompt", async () => {
  const f = await setup();
  const { files } = await import("./instructions.ts");
  const job = generationJob.parse({
    ...f.job,
    request: { ...f.job.request, briefFor: "omni-video", prompt: "Draft brief:\ncoin spins" },
  });
  await new CanvasText(f.bb).start(f.game, job);
  expect(f.starts[0]).toMatchObject({ title: "Canvas brief · request" });
  const text = (f.starts[0] as { input: { text?: string }[] }).input[0]!.text!;
  expect(text.startsWith("Write the final generation prompt for Gemini Omni")).toBe(true);
  expect(text).toContain(files.read("prompting/omni-video"));
  expect(text).not.toContain(files.read("canvas-text"));
  expect(text.endsWith("Draft brief:\ncoin spins")).toBe(true);
});

test("an agent run works in a visible thread in the game's folder and returns the files it made", async () => {
  const f = await setup();
  const job = generationJob.parse({
    ...f.job,
    request: {
      kind: "agent",
      prompt: "## Mesh cleanup · **Blender**\nFix the mesh.",
      providerId: "selected-provider",
      model: { provider: "bb", id: "selected-model" },
      files: ["canvas/staging/raw.glb"],
    },
  });
  await writeFile(join(f.game.rootPath, "canvas/staging/raw.glb"), "raw-model");
  const text = new CanvasText(f.bb);
  await text.start(f.game, job);
  expect(f.starts[0]).toMatchObject({
    title: "Canvas agent: Mesh cleanup · Blender",
    projectId: "project",
    visibility: "visible",
    environment: {
      type: "host",
      hostId: "host",
      workspace: { type: "unmanaged", path: f.game.rootPath },
    },
  });
  const brief = (f.starts[0] as { input: { text?: string }[] }).input[0]!.text!;
  expect(brief).toContain(join(f.game.rootPath, "canvas/staging/raw.glb"));
  expect(brief).toContain("Fix the mesh.");
  await mkdir(join(f.game.rootPath, "canvas/staging/request/work"), { recursive: true });
  await writeFile(join(f.game.rootPath, "canvas/staging/request/clean.glb"), "clean-model");
  await writeFile(join(f.game.rootPath, "canvas/staging/request/work/scratch.glb"), "scratch");
  f.setState("idle");
  const finished = await text.status(f.game, "request");
  expect(finished.status).toBe("succeeded");
  expect(finished.outputs.map((output) => [output.path, output.type])).toEqual([
    ["canvas/staging/request/clean.glb", "model"],
    ["canvas/staging/request/report.md", "text"],
  ]);
});

test("3D reviewers receive the complete model capture recipe in their own game context", async () => {
  for (const extension of ["glb", "png"]) {
    const f = await setup();
    const path = `canvas/staging/review.${extension}`;
    await writeFile(join(f.game.rootPath, path), "review output");
    const job = generationJob.parse({
      ...f.job,
      request: { ...f.job.request, reviewOf: ["output"], files: [path] },
    });
    await new CanvasText(f.bb).start(f.game, job);
    const text = (f.starts[0] as { input: { text?: string }[] }).input[0]!.text!;
    expect(text).not.toContain("{{modelReview}}");
    if (extension === "glb") {
      expect(text).toContain("window.gameStudioModelReview.capture");
      expect(text).toContain("/studio/game/viewer/");
      expect(text).toContain(f.game.rootPath);
    } else expect(text).not.toContain("window.gameStudioModelReview.capture");
  }
});

test("checking a BB run that is still going writes nothing, so it never wakes a watching studio", async () => {
  const f = await setup(),
    text = new CanvasText(f.bb);
  await text.start(f.game, f.job);
  const path = join(f.game.rootPath, "canvas/jobs/request.json");
  const before = await readFile(path, "utf8");
  const writes = () => f.harness.inspection.sdk.callsTo("files.write").length;
  const written = writes();
  expect((await text.status(f.game, "request")).status).toBe("running");
  expect((await text.status(f.game, "request")).status).toBe("running");
  expect(writes()).toBe(written);
  expect(await readFile(path, "utf8")).toBe(before);
  f.setState("idle");
  expect((await text.status(f.game, "request")).status).toBe("succeeded");
  expect(writes()).toBeGreaterThan(written);
});
