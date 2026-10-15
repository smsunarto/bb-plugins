import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationRunner } from "./generation.ts";
import { mediaRequest } from "../shared/generation.ts";
import type { Command } from "./providers.ts";
const roots: string[] = [];
const runners: GenerationRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "studio-generation-test-"));
  roots.push(path);
  return path;
}
async function settled(runner: GenerationRunner, target: { rootPath: string; jobId: string }) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await runner.status(target);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Job did not finish");
}

test("one request identity submits once, stages all candidates, and survives a runner restart", async () => {
  const rootPath = await root(),
    commands: Command[] = [];
  const runner = new GenerationRunner(async (command) => {
    commands.push(command);
    if (command.args[0] === "doctor") return { code: 0, stdout: "{}", stderr: "" };
    if (command.args[0] === "imagine")
      return {
        code: 0,
        stdout: JSON.stringify({
          success: [{ job_id: "c184f39e-e9ed-4135-8ac3-2eedf3e1cfb8" }],
          failure: [],
        }),
        stderr: "",
      };
    const out = command.args[command.args.indexOf("--output") + 1]!;
    for (let index = 0; index < 4; index++)
      await writeFile(join(out, `${index}.png`), `candidate-${index}`);
    return { code: 0, stdout: "{}", stderr: "" };
  });
  runners.push(runner);
  const target = { rootPath, jobId: "stable-request" },
    input = {
      ...target,
      threadId: "thread",
      request: mediaRequest.parse({
        kind: "image",
        prompt: "A brass key",
        model: { provider: "midjourney" },
      }),
    };
  const starts = await Promise.all([runner.start(input), runner.start(input)]);
  expect(starts.map((result) => result.created).sort()).toEqual([false, true]);
  const result = await settled(runner, target);
  expect(result.status).toBe("succeeded");
  expect(result.outputs.map((file) => file.path)).toEqual(
    [0, 1, 2, 3].map((index) => `canvas/staging/stable-request/${index}.png`),
  );
  expect(commands.filter((command) => command.args[0] === "imagine")).toHaveLength(1);
  expect(commands[1]!.args).toEqual([
    "imagine",
    "A brass key",
    "--model",
    "midjourney",
    "--speed",
    "fast",
    "--batch-size",
    "4",
    "--ar",
    "1:1",
    "--no-wait",
    "--json",
  ]);
  const restarted = new GenerationRunner(async () => {
    throw new Error("Must not submit again");
  });
  runners.push(restarted);
  expect((await restarted.start(input)).created).toBe(false);
  expect((await restarted.status(target)).outputs).toEqual(result.outputs);
  await expect(
    runner.start({
      ...input,
      request: { ...input.request, prompt: "Another key" } as typeof input.request,
    }),
  ).rejects.toThrow("different generation");
});

test("an uncertain submission is never automatically resubmitted", async () => {
  const rootPath = await root();
  let submissions = 0;
  const runner = new GenerationRunner(async (command) => {
    if (command.args[0] === "doctor") return { code: 0, stdout: "{}", stderr: "" };
    submissions++;
    return { code: 1, stdout: "", stderr: "connection lost" };
  });
  runners.push(runner);
  const target = { rootPath, jobId: "uncertain" },
    input = {
      ...target,
      threadId: "thread",
      request: mediaRequest.parse({
        kind: "image",
        prompt: "A key",
        model: { provider: "midjourney" },
      }),
    };
  await runner.start(input);
  expect((await settled(runner, target)).status).toBe("uncertain");
  await runner.start(input);
  await expect(runner.resume(target)).rejects.toThrow("no confirmed provider task");
  expect(submissions).toBe(1);
});

test("failed downloads resume the known task without creating a second paid job", async () => {
  const rootPath = await root();
  await writeFile(join(rootPath, "approved.png"), "reference");
  let submissions = 0,
    downloads = 0;
  const runner = new GenerationRunner(async (command) => {
    if (command.args[0] === "doctor") return { code: 0, stdout: "{}", stderr: "" };
    if (command.args[0] === "generate") {
      submissions++;
      return {
        code: 0,
        stdout: JSON.stringify({ task_id: "c184f39e-e9ed-4135-8ac3-2eedf3e1cfb8" }),
        stderr: "",
      };
    }
    if (++downloads === 1) return { code: 1, stdout: "", stderr: "timeout" };
    await writeFile(join(command.args[command.args.indexOf("--out") + 1]!, "model.glb"), "mesh");
    return { code: 0, stdout: "{}", stderr: "" };
  });
  runners.push(runner);
  const target = { rootPath, jobId: "geometry" };
  await runner.start({
    ...target,
    threadId: "thread",
    request: mediaRequest.parse({ kind: "model-3d", approvedImagePath: "approved.png" }),
  });
  expect((await settled(runner, target)).status).toBe("uncertain");
  await runner.resume(target);
  expect((await settled(runner, target)).status).toBe("succeeded");
  expect(submissions).toBe(1);
  expect(downloads).toBe(2);
});

test("host filesystem boundaries reject symlink outputs and references outside the game", async () => {
  const rootPath = await root(),
    outside = await root();
  await writeFile(join(outside, "ref.png"), "external");
  await symlink(join(outside, "ref.png"), join(rootPath, "ref.png"));
  let invoked = false;
  const runner = new GenerationRunner(async () => {
    invoked = true;
    throw new Error("Must not run");
  });
  runners.push(runner);
  const target = { rootPath, jobId: "escaped-reference" };
  await runner.start({
    ...target,
    threadId: "thread",
    request: mediaRequest.parse({ kind: "model-3d", approvedImagePath: "ref.png" }),
  });
  expect((await settled(runner, target)).status).toBe("failed");
  expect(invoked).toBe(false);
  await rm(join(rootPath, "canvas", "staging"), { recursive: true });
  await symlink(outside, join(rootPath, "canvas", "staging"));
  const next = { rootPath, jobId: "escaped-output" };
  await runner.start({
    ...next,
    threadId: "thread",
    request: mediaRequest.parse({ kind: "image", prompt: "A key" }),
  });
  expect((await settled(runner, next)).detail).toContain("symbolic links");
});

test("missing Google credentials fail before network submission and are not saved in the job", async () => {
  const rootPath = await root(),
    runner = new GenerationRunner();
  runners.push(runner);
  const target = { rootPath, jobId: "authentication" };
  await runner.start({
    ...target,
    threadId: "thread",
    request: mediaRequest.parse({ kind: "image", prompt: "A key" }),
    credentials: { falAccessToken: "test-private-fal" },
  });
  const result = await settled(runner, target);
  expect(result.status).toBe("auth-required");
  expect(await readFile(join(rootPath, "canvas/jobs/authentication.json"), "utf8")).not.toContain(
    "test-private-fal",
  );
});

test("reconciling a missing dispatch retires its ID before a delayed start can submit", async () => {
  const rootPath = await root();
  let invoked = false;
  const runner = new GenerationRunner(async () => {
    invoked = true;
    throw new Error("No late submission allowed");
  });
  runners.push(runner);
  const target = { rootPath, jobId: "missing-dispatch" };
  expect(await runner.reconcileMissing(target)).toEqual({ missing: true });
  await expect(
    runner.start({
      ...target,
      threadId: "thread",
      request: mediaRequest.parse({ kind: "image", prompt: "A key" }),
    }),
  ).rejects.toThrow("retired");
  expect(invoked).toBe(false);
});

test("a fresh worker reconciles interrupted running jobs to uncertain when listing", async () => {
  const rootPath = await root(),
    runner = new GenerationRunner();
  runners.push(runner);
  await mkdir(join(rootPath, "canvas/jobs"), { recursive: true });
  await writeFile(
    join(rootPath, "canvas/jobs/interrupted.json"),
    JSON.stringify({
      version: 1,
      id: "interrupted",
      threadId: "thread",
      createdAt: 1,
      updatedAt: 1,
      status: "running",
      request: mediaRequest.parse({ kind: "image", prompt: "A key" }),
      outputs: [],
    }),
  );
  const jobs = await runner.list(rootPath);
  expect(jobs[0]!.status).toBe("uncertain");
  expect(jobs[0]!.detail).toContain("interrupted");
});

test("a corrupt job and an interrupted temporary write do not hide healthy jobs", async () => {
  const rootPath = await root(),
    runner = new GenerationRunner();
  runners.push(runner);
  await mkdir(join(rootPath, "canvas/jobs"), { recursive: true });
  await writeFile(join(rootPath, "canvas/jobs/broken.json"), "{");
  await writeFile(join(rootPath, "canvas/jobs/unfinished.json.crash.tmp"), "{");
  const target = { rootPath, jobId: "healthy" };
  await runner.start({
    ...target,
    threadId: "thread",
    request: mediaRequest.parse({ kind: "image", prompt: "A key" }),
  });
  await settled(runner, target);
  expect((await runner.list(rootPath)).map((job) => job.id)).toEqual(["healthy"]);
  expect(await runner.reconcileMissing({ rootPath, jobId: "unfinished" })).toEqual({
    missing: true,
  });
});

test("independent workers publish one complete initial record before submitting", async () => {
  const rootPath = await root();
  let submissions = 0;
  const command = async (command: Command) => {
    if (command.args[0] === "doctor") return { code: 0, stdout: "{}", stderr: "" };
    submissions++;
    return { code: 1, stdout: "", stderr: "connection lost" };
  };
  const first = new GenerationRunner(command),
    second = new GenerationRunner(command);
  runners.push(first, second);
  const target = { rootPath, jobId: "exclusive" };
  const input = {
    ...target,
    threadId: "thread",
    request: mediaRequest.parse({
      kind: "image",
      prompt: "A key",
      model: { provider: "midjourney" },
    }),
  };
  const results = await Promise.all([first.start(input), second.start(input)]);
  expect(results.map((result) => result.created).sort()).toEqual([false, true]);
  await settled(results[0]!.created ? first : second, target);
  await Promise.all([first.dispose(), second.dispose()]);
  expect(JSON.parse(await readFile(join(rootPath, "canvas/jobs/exclusive.json"), "utf8")).id).toBe(
    "exclusive",
  );
  expect(submissions).toBe(1);
});
