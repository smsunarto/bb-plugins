import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
