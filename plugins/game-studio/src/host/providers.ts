import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import type { MediaRequest } from "../shared/generation.ts";

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
        request.prompt,
        "--model",
        "midjourney",
        "--speed",
        "fast",
        "--batch-size",
        "4",
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
const tripo: MediaProvider = {
  async submit(context) {
    await authenticated(context, "tripo");
    if (context.request.kind !== "model-3d")
      throw new ProviderFailure("Tripo requires an approved image-to-model request.", "failed");
    const result = await command(context, "tripo", [
      "generate",
      "image-to-model",
      context.imagePaths[0]!,
      "--model",
      "tripo-p2",
      "--param",
      `face_limit=${context.request.targetPolycount}`,
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
    const result = await command(context, "tripo", [
      "task",
      "watch",
      taskId,
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
