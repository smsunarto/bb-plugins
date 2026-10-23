import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  probe,
  job,
  quiet,
  instanceWorkspace,
  linuxProcessIdentity,
  discoverStartupEditors,
  interactiveEditorArgs,
} from "./unity-editors.ts";
import type { EditorInstance } from "../shared/unity-editor-contract.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function fixture(reply?: (path: string, body: any) => Response) {
  const project = await realpath(await mkdtemp(join(tmpdir(), "bb-unity-test-")));
  await mkdir(join(project, "Library/Pipeline"), { recursive: true });
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://127.0.0.1").pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ path, body, authorization: req.headers.authorization });
    const response = reply
      ? reply(path, body)
      : Response.json({ success: true, result: { jobId: "job-1", state: "queued" } });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no port");
  const port = address.port;
  const startedAt =
    process.platform === "linux"
      ? linuxProcessIdentity(
          await readFile(`/proc/${process.pid}/stat`, "utf8"),
          await readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        )
      : process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`,
            ],
            { encoding: "utf8" },
          ).trim()
        : execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
            encoding: "utf8",
            env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          }).trim();
  const instance: EditorInstance = {
    id: "instance-1",
    projectPath: project,
    workspacePath: project,
    pid: process.pid,
    startedAt,
    port,
    version: "6000.3.10f1",
    clone: false,
  };
  const descriptor = {
    pid: process.pid,
    port,
    projectPath: project,
    startedAt: "pipeline-epoch-1",
    unityVersion: instance.version,
    evalToken: "test-only-secret",
  };
  const descriptorPath = join(project, "Library/Pipeline/.unity-pipeline-port");
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(project, { recursive: true, force: true });
  });
  return { project, requests, instance, descriptor, descriptorPath };
}
test("an Editor process start mismatch prevents legacy job inspection", async () => {
  const f = await fixture();
  await expect(
    job({ ...f.instance, startedAt: "different process" }, "job-1", undefined, f.project),
  ).rejects.toThrow("Editor identity/descriptor is unavailable");
  expect(f.requests).toEqual([]);
});

test("Pipeline restarts preserve the process identity and use the current descriptor", async () => {
  const f = await fixture(() =>
    Response.json({ success: true, result: { success: true, result: process.pid } }),
  );
  await writeFile(
    f.descriptorPath,
    JSON.stringify({ ...f.descriptor, startedAt: "pipeline-epoch-2" }),
  );
  expect(await probe(f.instance)).toEqual({ pid: process.pid });
  expect(f.requests.length).toBe(1);
});
test("a claim's read-only ephemeral probe validates the served PID and cleans its source", async () => {
  const f = await fixture(() =>
    Response.json({ success: true, result: { success: true, result: process.pid } }),
  );
  expect(await probe(f.instance)).toEqual({ pid: process.pid });
  const file = f.requests[0].body.parameters.file;
  expect(file.startsWith(join(f.project, "Logs/agent-scripts"))).toBe(true);
  await expect(readFile(file)).rejects.toThrow();
  expect(f.requests[0].body.parameters.mode).toBe("ephemeral");
});
test("a missing pre-upgrade job remains uncertain", async () => {
  const f = await fixture(() => Response.json({ error: "Job not found" }, { status: 404 }));
  expect(await job(f.instance, "lost", undefined, f.project)).toEqual({
    jobId: "lost",
    state: "failed",
    uncertain: true,
    error: "Pipeline no longer retains this job; inspect owned work before reconciliation.",
  });
});

test("large failed results retain an artifact and timeout uncertainty without leaking authentication", async () => {
  const f = await fixture(() =>
    Response.json({
      jobId: "job-1",
      state: "completed",
      result: {
        success: false,
        error: "script timed out test-only-secret",
        detail: "x".repeat(65000),
      },
    }),
  );
  const result = await job(f.instance, "job-1", undefined, f.project);
  expect(result.uncertain).toBe(true);
  const artifact = (result.result as { artifactPath: string }).artifactPath;
  const retained = JSON.parse(await readFile(artifact, "utf8"));
  expect(retained.result.error).toBe("script timed out [redacted]");
  expect(retained.result.detail.length).toBe(65000);
});
test("owner reconciliation checks both native readiness and covered progress", async () => {
  const f = await fixture((path) =>
    Response.json(path === "/api/status" ? { status: "ready" } : { active: true }),
  );
  expect(await quiet(f.instance)).toEqual({
    quiet: false,
    blocking: { source: "progress", status: "active" },
  });
});

test("host timezone changes cannot make a live Editor look orphaned", async () => {
  const f = await fixture(() =>
    Response.json({ success: true, result: { success: true, result: process.pid } }),
  );
  const previous = process.env.TZ;
  process.env.TZ = "Pacific/Honolulu";
  try {
    expect(await probe(f.instance)).toEqual({ pid: process.pid });
    expect(f.requests.length).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("compile, background builds and queued recompiles block handoff even when coarse status is ready", async () => {
  let compiling = true,
    background = "idle";
  const f = await fixture((path, body) => {
    if (path === "/api/progress" || path === "/api/dialog") return Response.json({ active: false });
    if (body.command === "editor_status")
      return Response.json({
        success: true,
        result: {
          status: compiling ? "compiling" : "ready",
          compiling,
          domainReloadInProgress: false,
        },
      });
    return Response.json({
      success: true,
      result: JSON.stringify({ status: body.command === "build_status" ? background : "idle" }),
    });
  });
  expect(await quiet(f.instance)).toEqual({
    quiet: false,
    blocking: { source: "editor_status", status: "compiling" },
  });
  compiling = false;
  background = "building";
  expect(await quiet(f.instance)).toEqual({
    quiet: false,
    blocking: { source: "build_status", status: "building" },
  });
  background = "completed";
  expect(await quiet(f.instance)).toEqual({ quiet: true });
});
test("a clone outside the Library pathname still shares the resolved Assets workspace", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bb-unity-clone-")));
  const main = join(root, "main"),
    clone = join(root, "external-library/VP/player");
  await mkdir(join(main, "Assets"), { recursive: true });
  await mkdir(clone, { recursive: true });
  await symlink(join(main, "Assets"), join(clone, "Assets"));
  const child = spawn("node", ["-e", "setInterval(() => {}, 1000)", "--", "-readonly"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    expect(await instanceWorkspace(clone, child.pid!)).toEqual({
      workspacePath: main,
      clone: true,
    });
    expect(await instanceWorkspace(main, process.pid)).toEqual({
      workspacePath: main,
      clone: false,
    });
  } finally {
    child.kill();
    await new Promise<void>((r) => child.once("exit", () => r()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Internal Server Error is uncertain even if Pipeline responds with HTTP400", async () => {
  const f = await fixture(() =>
    Response.json({ success: false, error: "Internal Server Error" }, { status: 400 }),
  );
  await expect(probe(f.instance)).rejects.toThrow("Unity request failed");
});

test("a failed async test is settled and cannot permanently lock an idle Editor", async () => {
  const f = await fixture((path, body) => {
    if (path === "/api/progress" || path === "/api/dialog") return Response.json({ active: false });
    if (body.command === "editor_status")
      return Response.json({
        success: true,
        result: { status: "ready", compiling: false, domainReloadInProgress: false },
      });
    return Response.json({
      success: true,
      result: JSON.stringify({ status: body.command === "test_status" ? "error" : "idle" }),
    });
  });
  expect(await quiet(f.instance)).toEqual({ quiet: true });
});
test("Linux process identity uses monotonic start ticks and boot identity", () => {
  const fields = ["S", ...Array(18).fill("0"), "654321", "99"];
  const stat = `123 (Unity Editor (client)) ${fields.join(" ")}`;
  expect(linuxProcessIdentity(stat, "boot-A\n")).toBe("boot-A:654321");
  expect(linuxProcessIdentity(stat, "boot-B")).toBe("boot-B:654321");
  expect(() => linuxProcessIdentity("malformed", "boot-A")).toThrow("Linux process identity");
});

test("queued recompiles identify the pending gate without treating the Editor as idle", async () => {
  const f = await fixture((path, body) => {
    if (path === "/api/progress" || path === "/api/dialog") return Response.json({ active: false });
    return Response.json({
      success: true,
      result: JSON.stringify({
        status: body.command === "recompile_status" ? "triggered" : "idle",
      }),
    });
  });
  expect(await quiet(f.instance)).toEqual({
    quiet: false,
    blocking: { source: "recompile_status", status: "triggered" },
  });
});

test("startup discovery rejects noninteractive worker command lines", () => {
  expect(interactiveEditorArgs(["Unity", "-projectPath", "/game"])).toBe(true);
  expect(interactiveEditorArgs(["Unity", "-batchMode", "-projectPath", "/game"])).toBe(false);
  expect(interactiveEditorArgs(["Unity", "-assetImportWorker"])).toBe(false);
  expect(interactiveEditorArgs(["Unity", "-name", "AssetImportWorker0"])).toBe(false);
});
test.skipIf(process.platform !== "linux")(
  "startup discovery and claim verify native process identity before Pipeline exists",
  async () => {
    const { copyFile, chmod } = await import("node:fs/promises");
    const project = await realpath(await mkdtemp(join(tmpdir(), "bb-startup-editor-")));
    await mkdir(join(project, "Assets"));
    await mkdir(join(project, "ProjectSettings"));
    await writeFile(
      join(project, "ProjectSettings/ProjectVersion.txt"),
      "m_EditorVersion: 6000.3.10f1\n",
    );
    const binary = join(project, "Unity"),
      script = join(project, "idle.js");
    await copyFile(process.execPath, binary);
    await chmod(binary, 0o700);
    await writeFile(script, "setInterval(() => {}, 1000);");
    const child = spawn(binary, [script, "-projectPath", project], { stdio: "ignore" });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      await rm(project, { recursive: true, force: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.exitCode).toBeNull();
    const inventory = async () => [{ pid: child.pid!, projectPath: project }];
    const found = await discoverStartupEditors(undefined, inventory);
    expect(found.warnings).toEqual([]);
    expect(found.instances).toHaveLength(1);
    const instance = found.instances[0]!;
    expect(instance.port).toBeNull();
    expect(instance.workspacePath).toBe(project);
    expect(await probe(instance)).toEqual({ pid: child.pid! });
    await expect(probe({ ...instance, startedAt: "different-process" })).rejects.toThrow(
      "identity",
    );
    await mkdir(join(project, "Library/Pipeline"), { recursive: true });
    await writeFile(
      join(project, "Library/Pipeline/.unity-pipeline-port"),
      JSON.stringify({
        pid: child.pid,
        port: 7800,
        projectPath: project,
        unityVersion: "6000.3.10f1",
        startedAt: "epoch",
        evalToken: "fixture-only",
      }),
    );
    expect((await discoverStartupEditors(undefined, inventory)).instances).toEqual([]);
    await expect(probe(instance)).rejects.toThrow("identity");
  },
);

test("startup instances cannot inspect Pipeline jobs even if a ready descriptor exists", async () => {
  const f = await fixture();
  await expect(job({ ...f.instance, port: null }, "job-1", undefined, f.project)).rejects.toThrow(
    "Startup ownership cannot submit Pipeline requests",
  );
  expect(f.requests).toEqual([]);
});
