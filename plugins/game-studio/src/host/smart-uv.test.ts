import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationRunner } from "./generation.ts";
import { cliProviders, type RunCommand } from "./providers.ts";
import { mediaRequest } from "../shared/generation.ts";

const imported = "11111111-1111-4111-8111-111111111111";
const candidate = "22222222-2222-4222-8222-222222222222";
const applied = "33333333-3333-4333-8333-333333333333";
const candidateReceipt = {
  task_id: candidate,
  type: "studio_uv_candidate",
  status: "success",
  studio: { project_id: "project", operator_id: "candidate-operator" },
};
const ok = (value: unknown = {}) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const roots: string[] = [];
const runners: GenerationRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(run: RunCommand) {
  const rootPath = await mkdtemp(join(tmpdir(), "studio-smart-uv-"));
  roots.push(rootPath);
  const runner = new GenerationRunner(run);
  runners.push(runner);
  await writeFile(join(rootPath, "cleaned.glb"), "corrected geometry");
  return { runner, rootPath };
}
async function settled(runner: GenerationRunner, rootPath: string, jobId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await runner.status({ rootPath, jobId });
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Job did not settle");
}

test("Smart UV imports corrected geometry, resumes its candidate after restart, then applies the selected operator once", async () => {
  const commands: string[][] = [];
  let failedDownload = false;
  const run: RunCommand = async ({ args }) => {
    commands.push(args);
    if (args[0] === "doctor") return ok();
    if (args[1] === "import") return ok({ task_id: imported });
    if (args[0] === "uv" && args[1] === "generate") return ok({ task_id: candidate });
    if (args[0] === "uv" && args[1] === "context")
      return ok({ project_id: "project", candidates: [{ operator_id: "candidate-operator" }] });
    if (args[0] === "uv" && args[1] === "apply") return ok({ task_id: applied });
    if (args[1] === "get") return ok(candidateReceipt);
    if (args[1] === "watch") {
      if (!failedDownload) {
        failedDownload = true;
        return { code: 1, stdout: "", stderr: "network interrupted" };
      }
      const output = args[args.indexOf("--out") + 1]!;
      await writeFile(join(output, "model.glb"), "corrected geometry with Smart UV");
      // Provider layout previews must not become a second model take.
      await writeFile(join(output, "uv_layout.png"), "layout");
      return ok();
    }
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  const { runner, rootPath } = await setup(run);
  const input = {
    rootPath,
    jobId: "uv",
    threadId: "thread",
    request: mediaRequest.parse({
      kind: "model-edit",
      operation: "smart-uv",
      sourcePath: "cleaned.glb",
    }),
  };
  await runner.start(input);
  expect(await settled(runner, rootPath, "uv")).toMatchObject({
    status: "uncertain",
    taskId: candidate,
    providerData: { uvSourceTask: imported },
  });
  await runner.dispose();
  const restarted = new GenerationRunner(run);
  runners.push(restarted);
  await restarted.resume({ rootPath, jobId: "uv" });
  const uv = await settled(restarted, rootPath, "uv");
  expect(uv.status).toBe("succeeded");
  expect(uv.providerData).toEqual({
    uvSourceTask: imported,
    uvProject: "project",
    uvCandidateOperator: "candidate-operator",
  });
  expect(uv.outputs).toHaveLength(1);
  expect(uv.outputs[0]).toMatchObject({ type: "model", path: "canvas/staging/uv/model.glb" });
  expect(await readFile(join(rootPath, "cleaned.glb"), "utf8")).toBe("corrected geometry");
  expect((await restarted.start(input)).created).toBe(false);
  const apply = {
    rootPath,
    jobId: "apply",
    threadId: "thread",
    request: mediaRequest.parse({
      kind: "model-edit",
      operation: "apply-uv",
      sourcePath: uv.outputs[0]!.path,
      sourceTaskId: uv.providerData!.uvSourceTask,
      uvCandidateTaskId: candidate,
    }),
  };
  await restarted.start(apply);
  const result = await settled(restarted, rootPath, "apply");
  expect(result).toMatchObject({ status: "succeeded", taskId: applied });
  expect(result.outputs).toHaveLength(1);
  expect((await restarted.start(apply)).created).toBe(false);
  expect(commands.filter((args) => args[0] === "uv" && args[1] === "generate")).toEqual([
    ["uv", "generate", imported, "--no-wait", "--no-open", "--json"],
  ]);
  expect(commands.filter((args) => args[0] === "uv" && args[1] === "apply")).toEqual([
    ["uv", "apply", imported, "candidate-operator", "--no-wait", "--no-open", "--json"],
  ]);
  expect(commands.filter((args) => args[1] === "import")).toHaveLength(1);
});

for (const operation of ["smart-uv", "apply-uv"] as const) {
  test(`${operation} keeps an uncertain dispatch fenced across retries and restart`, async () => {
    let submissions = 0;
    const run: RunCommand = async ({ args }) => {
      if (args[0] === "doctor") return ok();
      if (args[1] === "get") return ok(candidateReceipt);
      if (args[1] === "context")
        return ok({ project_id: "project", candidates: [{ operator_id: "candidate-operator" }] });
      submissions++;
      return { code: 1, stdout: "", stderr: "receipt lost" };
    };
    const { runner, rootPath } = await setup(run);
    const input = {
      rootPath,
      jobId: "uncertain",
      threadId: "thread",
      request: mediaRequest.parse({
        kind: "model-edit",
        operation,
        sourcePath: "cleaned.glb",
        sourceTaskId: imported,
        ...(operation === "apply-uv" ? { uvCandidateTaskId: candidate } : {}),
      }),
    };
    await runner.start(input);
    expect((await settled(runner, rootPath, input.jobId)).status).toBe("uncertain");
    await runner.dispose();
    const restarted = new GenerationRunner(run);
    runners.push(restarted);
    expect((await restarted.start(input)).created).toBe(false);
    await expect(restarted.resume({ rootPath, jobId: input.jobId })).rejects.toThrow(
      "no confirmed provider task",
    );
    expect(submissions).toBe(1);
  });
}

for (const context of [
  { project_id: "different-project", candidates: [{ operator_id: "candidate-operator" }] },
  { project_id: "project", candidates: [{ operator_id: "another-candidate" }] },
]) {
  test("Apply UV rejects a candidate outside the current source context before mutation", async () => {
    const commands: string[][] = [];
    await expect(
      cliProviders.tripo!.submit({
        request: mediaRequest.parse({
          kind: "model-edit",
          operation: "apply-uv",
          sourcePath: "model.glb",
          sourceTaskId: imported,
          uvCandidateTaskId: candidate,
        }),
        rootPath: "/game",
        locate: (path: string) => `/game/${path}`,
        outputPath: "/game/out",
        imagePaths: [],
        signal: new AbortController().signal,
        recordTask: async () => {},
        run: async ({ args }) => {
          commands.push(args);
          return ok(args[1] === "get" ? candidateReceipt : args[1] === "context" ? context : {});
        },
      }),
    ).rejects.toMatchObject({ status: "failed" });
    expect(commands.some((args) => args[1] === "apply")).toBe(false);
  });
}
