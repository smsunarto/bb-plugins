import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Supervisor, type SupervisorSnapshot } from "../lib/core-process.ts";

// Children are real `node -e` processes; probes are stubbed via fetchImpl.
// Timings are compressed so the whole suite runs in well under a second per
// case.

function makeSupervisor(options: {
  script: string;
  installed?: () => boolean;
  probeOk?: boolean;
  backoffInitialMs?: number;
}) {
  const transitions: string[] = [];
  const supervisor = new Supervisor({
    binPath: process.execPath,
    configPath: "unused",
    isInstalled: options.installed ?? (() => true),
    probeUrl: () => "http://127.0.0.1:1/",
    spawnImpl: ((_bin: string, _args: string[], spawnOptions: object) =>
      spawn(process.execPath, ["-e", options.script], spawnOptions)) as never,
    fetchImpl: (() =>
      options.probeOk === false
        ? Promise.reject(new Error("nope"))
        : Promise.resolve(new Response("ok"))) as typeof fetch,
    probeTimeoutMs: 300,
    probeIntervalMs: 20,
    backoffInitialMs: options.backoffInitialMs ?? 30,
    backoffMaxMs: 200,
    healthyResetMs: 10_000,
    killGraceMs: 200,
    onChange: (snapshot: SupervisorSnapshot) => transitions.push(snapshot.state),
  });
  return { supervisor, transitions };
}

const SLEEP_FOREVER = "setInterval(() => {}, 1000)";
const EXIT_NOW = "process.exit(1)";

function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("condition not reached"));
      }
    }, 10);
  });
}

test("parks when not installed, starts when installed and desired", async () => {
  let installed = false;
  const { supervisor } = makeSupervisor({ script: SLEEP_FOREVER, installed: () => installed });
  const controller = new AbortController();
  const done = supervisor.run(controller.signal);

  supervisor.start();
  await until(() => supervisor.state === "not-installed");

  installed = true;
  supervisor.poke();
  supervisor.start();
  await until(() => supervisor.state === "running");
  assert.ok(supervisor.snapshot().pid !== null);

  controller.abort();
  await done;
  assert.equal(supervisor.state, "stopped");
});

test("manual stop stays stopped; restart works", async () => {
  const { supervisor } = makeSupervisor({ script: SLEEP_FOREVER });
  const controller = new AbortController();
  const done = supervisor.run(controller.signal);

  supervisor.start();
  await until(() => supervisor.state === "running");
  await supervisor.stop();
  await until(() => supervisor.state === "stopped");
  assert.equal(supervisor.snapshot().crashCount, 0);

  // Stays stopped (no respawn) for a while.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(supervisor.state, "stopped");

  supervisor.start();
  await until(() => supervisor.state === "running");

  controller.abort();
  await done;
});

test("crash restarts with backoff and records exits", async () => {
  const { supervisor, transitions } = makeSupervisor({
    script: EXIT_NOW,
    probeOk: false,
    backoffInitialMs: 20,
  });
  const controller = new AbortController();
  const done = supervisor.run(controller.signal);

  supervisor.start();
  await until(() => supervisor.snapshot().crashCount >= 3);
  assert.ok(transitions.includes("crashed"));
  const exit = supervisor.snapshot().lastExit;
  assert.ok(exit);
  assert.equal(exit.code, 1);

  await supervisor.stop();
  await until(() => supervisor.state === "stopped");
  controller.abort();
  await done;
});

test("spawn errors become crashes instead of parking in starting", async () => {
  const transitions: string[] = [];
  const supervisor = new Supervisor({
    binPath: "/definitely/not/a/real/agent-proxy-binary",
    configPath: "unused",
    isInstalled: () => true,
    probeUrl: () => "http://127.0.0.1:1/",
    fetchImpl: (() => Promise.reject(new Error("nope"))) as typeof fetch,
    probeTimeoutMs: 100,
    probeIntervalMs: 10,
    backoffInitialMs: 20,
    backoffMaxMs: 40,
    privateUmask: false,
    onChange: (snapshot) => transitions.push(snapshot.state),
  });
  const controller = new AbortController();
  const done = supervisor.run(controller.signal);
  supervisor.start();
  await until(() => supervisor.snapshot().crashCount >= 2);
  assert.ok(transitions.includes("crashed"));
  assert.match(supervisor.logs().join("\n"), /spawn failed/);
  await supervisor.stop();
  controller.abort();
  await done;
});

test("readiness timeout terminates and retries without reporting running", async () => {
  const { supervisor, transitions } = makeSupervisor({
    script: SLEEP_FOREVER,
    probeOk: false,
    backoffInitialMs: 20,
  });
  const controller = new AbortController();
  const done = supervisor.run(controller.signal);
  supervisor.start();
  await until(() => supervisor.snapshot().crashCount >= 1);
  assert.equal(transitions.includes("running"), false);
  assert.match(supervisor.logs().join("\n"), /readiness probe timed out/);
  await supervisor.stop();
  controller.abort();
  await done;
});

test("core child creates files under a private umask", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-umask-"));
  const createdPath = join(dir, "credential.json");
  const scriptPath = join(dir, "fake-core.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh\ntouch ${JSON.stringify(createdPath)}\nwhile true; do sleep 1; done\n`,
  );
  chmodSync(scriptPath, 0o755);
  const supervisor = new Supervisor({
    binPath: scriptPath,
    configPath: "unused",
    isInstalled: () => true,
    probeUrl: () => "http://127.0.0.1:1/",
    fetchImpl: (() => Promise.resolve(new Response("ok"))) as typeof fetch,
    killGraceMs: 200,
  });
  const controller = new AbortController();
  const done = supervisor.run(controller.signal);
  supervisor.start();
  await until(() => supervisor.state === "running" && existsSync(createdPath));
  assert.equal(statSync(createdPath).mode & 0o777, 0o600);
  controller.abort();
  await done;
});

test("abort during run kills the child and resolves", async () => {
  const { supervisor } = makeSupervisor({ script: SLEEP_FOREVER });
  const controller = new AbortController();
  const done = supervisor.run(controller.signal);
  supervisor.start();
  await until(() => supervisor.state === "running");
  const pid = supervisor.snapshot().pid;
  assert.ok(pid);
  controller.abort();
  await done;
  assert.equal(supervisor.state, "stopped");
  // The child must actually be gone.
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test("captures child output in the log ring", async () => {
  const { supervisor } = makeSupervisor({
    script: 'console.log("hello from core"); setInterval(() => {}, 1000)',
  });
  const controller = new AbortController();
  const done = supervisor.run(controller.signal);
  supervisor.start();
  await until(() => supervisor.logs().some((line) => line.includes("hello from core")));
  controller.abort();
  await done;
});
