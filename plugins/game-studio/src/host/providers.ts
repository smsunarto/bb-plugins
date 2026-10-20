import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import {
  editViewPaths,
  modelViewPaths,
  modelViews,
  type MediaRequest,
} from "../shared/generation.ts";
import { generationPrompt } from "../shared/generation-prompt.ts";

type ModelEditRequest = Extract<MediaRequest, { kind: "model-edit" }>;
export type Command = { executable: string; args: string[]; cwd: string; signal: AbortSignal };
export type CommandResult = { code: number; stdout: string; stderr: string };
export type RunCommand = (command: Command) => Promise<CommandResult>;
export const runCommand: RunCommand = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      signal: command.signal,
      env: experimental_sanitizeInheritedChildProcessEnv({ env: process.env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      bytes = 0;
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        child.kill();
        reject(new Error("Provider output exceeded the local limit."));
        return;
      }
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export class ProviderFailure extends Error {
  readonly status: "failed" | "uncertain" | "auth-required";
  readonly taskId: string | undefined;
  constructor(message: string, status: "failed" | "uncertain" | "auth-required", taskId?: string) {
    super(message);
    this.status = status;
    this.taskId = taskId;
  }
}
export type ProviderContext = {
  request: MediaRequest;
  rootPath: string;
  outputPath: string;
  imagePaths: string[];
  signal: AbortSignal;
  run: RunCommand;
  providerData?: Record<string, string>;
  recordTask: (id: string, data?: Record<string, string>) => Promise<void>;
};
export type MediaProvider = {
  submit(context: ProviderContext): Promise<string>;
  collect(context: ProviderContext, taskId: string): Promise<void>;
};
const midjourneySubmission = z.object({
  success: z.array(z.object({ job_id: z.uuid() })).length(1),
  failure: z.array(z.unknown()).length(0),
});
const tripoSubmission = z.object({ task_id: z.uuid() });
function payload(result: CommandResult): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}
const tripoError = z.object({ error: z.string().min(1) });
/**
 * Why Tripo refused a request before submitting it. The Tripo Studio CLI exits 2 only for requests
 * it validates and rejects locally, so nothing reached Tripo and running the node again is safe.
 */
function tripoRejection(result: CommandResult) {
  if (result.code !== 2) return undefined;
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    try {
      const parsed = tripoError.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data.error;
    } catch {
      // Progress and billing notes share the streams with the JSON error.
    }
  }
  return "Tripo rejected the request. Nothing was submitted.";
}
const executable = (name: string) =>
  join(homedir(), ".local", "share", "cli-overrides", "bin", name);

async function command(context: ProviderContext, provider: "midjourney" | "tripo", args: string[]) {
  return context.run({
    executable: executable(provider),
    args: [...args, "--json"],
    cwd: context.rootPath,
    signal: context.signal,
  });
}
async function authenticated(context: ProviderContext, provider: "midjourney" | "tripo") {
  let result: CommandResult;
  try {
    result = await command(context, provider, ["doctor"]);
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    throw new ProviderFailure(`${provider} is unavailable on this project's machine.`, "failed");
  }
  if (result.code !== 0)
    throw new ProviderFailure(
      `Sign in to ${provider === "tripo" ? "Tripo Studio" : "Midjourney"} on this project's machine, then import the browser session. No generation was submitted.`,
      "auth-required",
    );
}

const midjourney: MediaProvider = {
  async submit(context) {
    await authenticated(context, "midjourney");
    const request = context.request;
    let args: string[];
    if (request.kind === "image") {
      args = [
        "imagine",
        generationPrompt(request),
        "--model",
        "midjourney",
        "--speed",
        "fast",
        // A standard 8.2 job already yields four images; an explicit --bs 4 is rejected.
        "--ar",
        request.aspectRatio,
      ];
      for (const image of context.imagePaths) args.push("--image", image);
    } else if (request.kind === "video") {
      args = [
        "video",
        "create",
        "--start",
        context.imagePaths[0]!,
        "--prompt",
        request.prompt,
        "--motion",
        request.motion,
        "--resolution",
        (request.resolution ?? "720p").replace("p", ""),
        "--speed",
        "fast",
        "--batch-size",
        String(request.outputCount),
      ];
      if (request.endImagePath) args.push("--end", context.imagePaths[1]!);
      if (request.loop) args.push("--loop");
    } else throw new ProviderFailure("Midjourney cannot generate this media type.", "failed");
    const result = await command(context, "midjourney", [...args, "--no-wait"]);
    const parsed = midjourneySubmission.safeParse(payload(result));
    if (result.code !== 0 || !parsed.success)
      throw new ProviderFailure(
        "Midjourney submission is uncertain. Inspect its saved submission receipts before trying a new request. This request will not be submitted again.",
        "uncertain",
      );
    return parsed.data.success[0]!.job_id;
  },
  async collect(context, taskId) {
    const result = await command(context, "midjourney", [
      "job",
      "watch",
      taskId,
      "--download",
      "--timeout",
      "600",
      "--output",
      context.outputPath,
    ]);
    if (result.code !== 0)
      throw new ProviderFailure(
        "Midjourney has a submitted job. Resume this job to continue waiting or downloading; do not submit it again.",
        "uncertain",
        taskId,
      );
  },
};
/** The Tripo task to process. Tripo works on its own tasks, so a model made elsewhere is imported. */
async function sourceTask(context: ProviderContext, request: ModelEditRequest) {
  if (request.sourceTaskId) return request.sourceTaskId;
  const result = await command(context, "tripo", [
    "model",
    "import",
    join(context.rootPath, request.sourcePath),
    "--no-download",
    "--timeout",
    "600",
    "--no-open",
  ]);
  const parsed = tripoSubmission.safeParse(payload(result));
  if (result.code !== 0 || !parsed.success)
    throw new ProviderFailure(
      `Tripo could not import the source model. ${tripoRejection(result) ?? "Nothing was processed."}`,
      "failed",
    );
  return parsed.data.task_id;
}
/** The CLI arguments for one processing step, after its input task. */
function editArgs(context: ProviderContext, request: ModelEditRequest): string[] {
  if (request.operation === "pbr") return ["model", "pbr"];
  // Tripo Studio returns GLB and rejects output-format and in-place options on these steps.
  if (request.operation === "rig") return ["anim", "rig", "--rig-type", request.rigType!];
  if (request.operation === "animate")
    return ["anim", "retarget", "--animation", request.animation!];
  // Snapshotted reference views arrive in the order editViewPaths lists them.
  const views = editViewPaths(request).map(([view], index) => [view, context.imagePaths[index]!]);
  const byView = Object.fromEntries(views);
  const reference = views.length
    ? views.length === 1 && views[0]![0] === "front"
      ? [`image=${views[0]![1]}`]
      : [`images=${JSON.stringify(modelViews.map((view) => byView[view] ?? null))}`]
    : [`prompt=${request.prompt}`];
  return [
    "model",
    "texture",
    ...reference.flatMap((param) => ["--param", param]),
    ...(request.textureQuality ? ["--texture-quality", request.textureQuality] : []),
  ];
}

/**
 * The export that bakes a retarget's clip onto its rigged, textured model. Tripo's retarget
 * yields only the clip, so an Animate step waits for it, then exports the model with it.
 * The export is recorded before and after submission so a resumed job never submits it twice.
 */
async function animatedExport(context: ProviderContext, retargetTask: string) {
  if (context.providerData?.exportTask) return context.providerData.exportTask;
  if (context.providerData?.exportState === "submitting")
    throw new ProviderFailure(
      "Tripo export submission is uncertain. Inspect tripo task unresolved before running the node again. It will not be submitted again.",
      "uncertain",
      retargetTask,
    );
  const watched = await command(context, "tripo", [
    "task",
    "watch",
    retargetTask,
    "--timeout",
    "600",
    "--no-open",
  ]);
  if (watched.code !== 0)
    throw new ProviderFailure(
      "Tripo has a submitted task. Resume this job to continue waiting or downloading; do not submit it again.",
      "uncertain",
      retargetTask,
    );
  await context.recordTask(retargetTask, { exportState: "submitting" });
  const result = await command(context, "tripo", [
    "model",
    "convert",
    retargetTask,
    "--format",
    "GLTF",
    "--no-wait",
    "--no-open",
  ]);
  const rejected = tripoRejection(result);
  if (rejected)
    throw new ProviderFailure(`${rejected} Run the node again.`, "failed", retargetTask);
  const parsed = tripoSubmission.safeParse(payload(result));
  if (result.code !== 0 || !parsed.success)
    throw new ProviderFailure(
      "Tripo export submission is uncertain. Inspect tripo task unresolved before running the node again. It will not be submitted again.",
      "uncertain",
      retargetTask,
    );
  await context.recordTask(retargetTask, { exportTask: parsed.data.task_id });
  return parsed.data.task_id;
}

const tripo: MediaProvider = {
  async submit(context) {
    await authenticated(context, "tripo");
    const request = context.request;
    if (request.kind === "model-edit") {
      const input = await sourceTask(context, request);
      const [group, action, ...options] = editArgs(context, request);
      const result = await command(context, "tripo", [
        group!,
        action!,
        input,
        ...options,
        "--no-wait",
        "--no-open",
      ]);
      const rejected = tripoRejection(result);
      if (rejected)
        throw new ProviderFailure(`${rejected} Change the node and run it again.`, "failed");
      const parsed = tripoSubmission.safeParse(payload(result));
      if (result.code !== 0 || !parsed.success)
        throw new ProviderFailure(
          "Tripo submission is uncertain. Inspect its unresolved tasks before trying a new request. This request will not be submitted again.",
          "uncertain",
        );
      return parsed.data.task_id;
    }
    if (request.kind !== "model-3d")
      throw new ProviderFailure("Tripo requires an approved image-to-model request.", "failed");
    const views = modelViewPaths(request);
    const result = await command(context, "tripo", [
      "generate",
      ...(views.length > 1
        ? [
            "multiview-to-model",
            ...views.flatMap(([view], index) => [`--${view}`, context.imagePaths[index]!]),
          ]
        : ["image-to-model", context.imagePaths[0]!]),
      "--model",
      "tripo-p2",
      "--param",
      `face_limit=${request.targetPolycount}`,
      "--no-wait",
      "--no-open",
    ]);
    const parsed = tripoSubmission.safeParse(payload(result));
    if (result.code !== 0 || !parsed.success)
      throw new ProviderFailure(
        "Tripo submission is uncertain. Inspect its unresolved tasks before trying a new request. This request will not be submitted again.",
        "uncertain",
      );
    return parsed.data.task_id;
  },
  async collect(context, taskId) {
    const request = context.request;
    const download =
      request.kind === "model-edit" && request.operation === "animate"
        ? await animatedExport(context, taskId)
        : taskId;
    const result = await command(context, "tripo", [
      "task",
      "watch",
      download,
      "--download",
      "--out",
      context.outputPath,
      "--timeout",
      "600",
      "--no-open",
    ]);
    if (result.code !== 0)
      throw new ProviderFailure(
        "Tripo has a submitted task. Resume this job to continue waiting or downloading; do not submit it again.",
        "uncertain",
        taskId,
      );
  },
};

/** Add a provider here without changing the model-facing tools or job lifecycle. */
export const cliProviders: Readonly<Record<string, MediaProvider>> = { midjourney, tripo };
