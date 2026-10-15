import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { uncertainJob, pipelineJobSchema } from "../shared/unity-editor-contract.ts";
import type {
  CommandParameters,
  CommandSubmission,
  EditorInstance,
} from "../shared/unity-editor-contract.ts";

const exec = promisify(execFile);
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function processStartedAt(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const [stat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    return linuxProcessIdentity(stat, bootId);
  }
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
        ]
      : ["-p", String(pid), "-o", "lstart="];
  const { stdout } = await exec(process.platform === "win32" ? "powershell.exe" : "ps", args, {
    timeout: 5000,
    maxBuffer: 4096,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const stamp = stdout.trim();
  if (!stamp) throw new Error("Could not verify Editor process start time");
  return stamp;
}
export function linuxProcessIdentity(stat: string, bootId: string): string {
  // comm (field 2) may contain spaces or parentheses. Fields after its final ')' begin with field 3.
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  if (!/^\d+$/.test(startTicks ?? "") || !bootId.trim())
    throw new Error("Could not verify Linux process identity");
  return `${bootId.trim()}:${startTicks}`;
}
export async function alive(pid: number, startedAt: string): Promise<boolean> {
  if (!processAlive(pid)) return false;
  return (await processStartedAt(pid)) === startedAt;
}
const descriptorSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  projectPath: z.string(),
  unityVersion: z.string(),
  startedAt: z.string(),
  evalToken: z.string().min(1),
});
const discoverySchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      instances: z.array(z.object({ project: z.string(), pid: z.number().int().positive() })),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ code: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
});
const envelopeSchema = z.object({
  success: z.boolean().optional(),
  result: z.unknown().optional(),
  status: z.string().optional(),
  errorCode: z.string().optional(),
  error: z.string().optional(),
});
export function decode(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
async function descriptor(projectPath: string) {
  return descriptorSchema.parse(
    JSON.parse(await readFile(join(projectPath, "Library/Pipeline/.unity-pipeline-port"), "utf8")),
  );
}
class RejectedCommand extends Error {}
class MissingJob extends Error {}
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Unity returned an empty response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 8 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Unity response exceeded 8 MiB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function discoveryResponse(signal?: AbortSignal) {
  let stdout: string;
  try {
    ({ stdout } = await exec("unity", ["--format", "json", "status"], {
      signal,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (!output)
      throw new Error("Unity discovery failed. Check unity is installed on this host.", {
        cause: error,
      });
    const response = discoverySchema.parse(JSON.parse(output));
    if (
      response.warnings?.length ||
      !Array.isArray(response.errors) ||
      !response.errors.length ||
      !response.errors.every((e) => e.code === "STATUS_NO_INSTANCES")
    )
      throw new Error("Unity discovery is unavailable; do not assume an Editor is absent.", {
        cause: error,
      });
    return { success: true, data: { instances: [] }, errors: [], warnings: [] };
  }
  return discoverySchema.parse(JSON.parse(stdout));
}
export async function instanceWorkspace(projectPath: string, pid: number) {
  const workspacePath = dirname(await realpath(join(projectPath, "Assets")));
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
        ]
      : ["-p", String(pid), "-o", "args="];
  const { stdout } = await exec(process.platform === "win32" ? "powershell.exe" : "ps", args, {
    timeout: 5000,
    maxBuffer: 65536,
  });
  if (!stdout.trim()) throw new Error("Could not inspect Editor process flags");
  const clone = /(?:^|\s)(?:-readonly|--virtual-project-clone)(?:=|\s|$)/.test(stdout);
  return { workspacePath, clone };
}
export async function discover(signal?: AbortSignal) {
  const response = await discoveryResponse(signal);
  if (response.success !== true || !response.data)
    throw new Error("Unity discovery did not succeed");
  let instances: EditorInstance[] = [];
  const warnings: string[] = response.warnings ?? [];
  const directories = new Map<string, string[]>();
  for (const entry of response.data.instances.slice(0, 64)) {
    try {
      const projectPath = await realpath(entry.project);
      const d = await descriptor(projectPath);
      const pipelineDir = await realpath(join(projectPath, "Library/Pipeline"));
      const paths = directories.get(pipelineDir);
      if (paths) {
        paths.push(projectPath);
        instances = instances.filter((instance) => !paths.includes(instance.projectPath));
        throw new Error(
          "Two instances share a physical Pipeline directory; both targets are excluded",
        );
      }
      directories.set(pipelineDir, [projectPath]);
      if (
        d.pid !== entry.pid ||
        !processAlive(d.pid) ||
        (await realpath(d.projectPath)) !== projectPath
      )
        throw new Error("Descriptor does not match the discovered process");
      const { workspacePath, clone } = await instanceWorkspace(projectPath, d.pid);
      const startedAt = await processStartedAt(d.pid);
      instances.push({
        id: createHash("sha256")
          .update(`${projectPath}\0${d.pid}\0${startedAt}`)
          .digest("hex")
          .slice(0, 24),
        projectPath,
        workspacePath,
        pid: d.pid,
        port: d.port,
        version: d.unityVersion,
        startedAt,
        clone,
      });
    } catch (error) {
      warnings.push(
        `${entry.project}: ${error instanceof Error ? error.message : "Discovery failed"}`,
      );
    }
  }
  return { instances, warnings };
}
async function verifiedDescriptor(instance: EditorInstance) {
  const d = await descriptor(instance.projectPath);
  if (
    d.pid !== instance.pid ||
    (await realpath(d.projectPath)) !== instance.projectPath ||
    !(await alive(instance.pid, instance.startedAt))
  )
    throw new Error("Editor identity changed. Rediscover and claim the current instance.");
  if (typeof d.evalToken !== "string" || !d.evalToken)
    throw new Error("Pipeline authentication is unavailable");
  return d;
}
async function request(
  instance: EditorInstance,
  path: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  let d;
  try {
    d = await verifiedDescriptor(instance);
  } catch {
    throw new RejectedCommand(
      "Editor identity/descriptor is unavailable; no command was submitted. Rediscover after reload.",
    );
  }
  const response = await fetch(`http://127.0.0.1:${d.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${d.evalToken}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
  });
  const text = await boundedText(response);
  if (text.length > 8 * 1024 * 1024) throw new Error("Unity response exceeded 8 MiB");
  const value = decode(JSON.parse(text.replaceAll(d.evalToken, "[redacted]")));
  const envelope = envelopeSchema.safeParse(value);
  if (response.status === 404 && path.startsWith("/api/job?")) throw new MissingJob();
  if (!response.ok || (envelope.success && envelope.data.success === false)) {
    if (
      ([400, 401, 413, 429].includes(response.status) &&
        envelope.data?.error !== "Internal Server Error") ||
      (envelope.success &&
        (envelope.data.status === "busy" || envelope.data.errorCode === "INVALID_COMMAND_ARGS"))
    )
      throw new RejectedCommand(
        `Unity rejected the command (${response.status}). Check its registered schema.`,
      );
    throw new Error(`Unity request failed (${response.status})`);
  }
  return value;
}
export async function probe(instance: EditorInstance, signal?: AbortSignal) {
  const dir = join(instance.workspacePath, "Logs/agent-scripts", `bb-editor-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "Identity.cs");
  try {
    await writeFile(
      file,
      "public static class EditorIdentity { public static int Run() => System.Diagnostics.Process.GetCurrentProcess().Id; }",
      { mode: 0o600 },
    );
    const response = await request(instance, "/api/exec", signal, {
      command: "run_script",
      parameters: { file, entry: "EditorIdentity.Run", mode: "ephemeral" },
      timeout: 10000,
    });
    const result = decode(envelopeSchema.parse(response).result);
    if (
      !z.object({ success: z.literal(true), result: z.literal(instance.pid) }).safeParse(result)
        .success
    )
      throw new Error("Pipeline selected a different process");
    return { pid: instance.pid };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function execute(
  instance: EditorInstance,
  command: string,
  parameters: CommandParameters,
  signal?: AbortSignal,
): Promise<CommandSubmission> {
  const params: CommandParameters = { ...parameters };
  // Package requests stay tracked; tests preserve async mode and are monitored by test_status.
  if (command === "package_add" || command === "package_remove") params.wait = true;
  try {
    const response = await request(instance, "/api/exec", signal, {
      command,
      parameters: params,
      job: true,
      timeout: 600000,
    });
    const result = z
      .object({ jobId: z.string() })
      .parse(decode(envelopeSchema.parse(response).result));
    return result;
  } catch (error) {
    if (error instanceof RejectedCommand) return { rejected: true as const, error: error.message };
    throw error;
  }
}
export async function job(
  instance: EditorInstance,
  jobId: string,
  signal: AbortSignal | undefined,
  dataDir: string,
) {
  let response;
  try {
    response = pipelineJobSchema.parse(
      await request(instance, `/api/job?id=${encodeURIComponent(jobId)}`, signal),
    );
  } catch (error) {
    if (error instanceof MissingJob)
      return {
        jobId,
        state: "failed" as const,
        uncertain: true,
        error: "Pipeline no longer retains this job; inspect owned work before reconciliation.",
      };
    throw error;
  }
  if (response.jobId !== jobId) throw new Error("Unity returned a different job");
  const text = JSON.stringify(response);
  if (text.length <= 60000) return response;
  const dir = join(dataDir, "unity-job-results");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  await writeFile(path, text, { mode: 0o600 });
  return {
    jobId: response.jobId,
    state: response.state,
    result: {
      artifactPath: path,
      bytes: Buffer.byteLength(text),
      message: "Full result retained on the Editor host.",
    },
    error: response.error?.slice(0, 2000) ?? null,
    errorDetails: response.errorDetails?.slice(0, 2000) ?? null,
    uncertain: uncertainJob(response),
  };
}

async function inspectStatus(instance: EditorInstance, command: string, signal?: AbortSignal) {
  const response = envelopeSchema.parse(
    await request(instance, "/api/exec", signal, { command, parameters: {}, timeout: 10000 }),
  );
  return decode(response.result);
}
const backgroundStatuses = [
  "recompile_status",
  "build_status",
  "switch_build_target_status",
  "lighting_bake_status",
  "navmesh_bake_status",
  "occlusion_bake_status",
  "audit_status",
  "package_status",
  "test_status",
];
const settledStates = new Set([
  "idle",
  "completed",
  "up_to_date",
  "failed",
  "interrupted",
  "unavailable",
  "canceled",
  "cancelled",
  "no_tests",
  "error",
]);
export async function quiet(instance: EditorInstance, signal?: AbortSignal) {
  const progress = z
    .object({ active: z.boolean() })
    .parse(await request(instance, "/api/progress", signal));
  const dialog = z
    .object({ active: z.boolean() })
    .parse(await request(instance, "/api/dialog", signal));
  if (progress.active) return { quiet: false, blocking: { source: "progress", status: "active" } };
  if (dialog.active) return { quiet: false, blocking: { source: "dialog", status: "active" } };
  for (const command of backgroundStatuses) {
    const result = await inspectStatus(instance, command, signal);
    if (command === "test_status" && result == null) continue;
    const status = z.object({ status: z.string() }).parse(result);
    if (!settledStates.has(status.status))
      return { quiet: false, blocking: { source: command, status: status.status.slice(0, 128) } };
  }
  const editor = z
    .object({ status: z.string(), compiling: z.boolean(), domainReloadInProgress: z.boolean() })
    .parse(await inspectStatus(instance, "editor_status", signal));
  const idle =
    ["ready", "playing"].includes(editor.status) &&
    !editor.compiling &&
    !editor.domainReloadInProgress;
  return idle
    ? { quiet: true }
    : {
        quiet: false,
        blocking: {
          source: "editor_status",
          status: editor.compiling
            ? "compiling"
            : editor.domainReloadInProgress
              ? "reloading"
              : editor.status.slice(0, 128),
        },
      };
}
