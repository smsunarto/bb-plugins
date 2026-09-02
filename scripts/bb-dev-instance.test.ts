import { test } from "node:test";
import assert from "node:assert/strict";
import type { InstanceResult } from "../packages/bb-kit-core/src/bin/dev/model.ts";
import { DevManager } from "../packages/bb-kit-core/src/bin/dev/manager.ts";
import { runPreparedDevInstance, WATCH_COMMAND } from "./bb-dev-instance.ts";

test("the repository command builds before it applies the owned baseline", async () => {
  let startOptions: unknown;
  const calls: Array<{ argv: readonly string[]; stdout: string }> = [];
  const manager = recordingManager((options) => {
    startOptions = options;
    return runningResult("prepared", "owned");
  });

  const result = await runPreparedDevInstance(["--name", "prepared"], {
    manager,
    runProgram: async (_name, argv, options) => {
      calls.push({ argv, stdout: options.stdout });
      return 0;
    },
  });

  assert.deepEqual(startOptions, { name: "prepared", json: true });
  assert.deepEqual(calls, [
    { argv: ["bun", "run", "build:managed"], stdout: "stderr" },
    {
      argv: [
        "bun",
        "scripts/bb-dev-instance-setup.ts",
        "--expected-data-dir",
        "/tmp/.bb-dev/prepared",
      ],
      stdout: "stderr",
    },
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "http://localhost:11001\n");

  const jsonResult = await runPreparedDevInstance(["--name", "prepared", "--json"], {
    manager,
    runProgram: async () => 0,
  });
  const jsonEnvelope = JSON.parse(jsonResult.stdout) as {
    ok: boolean;
    result: { built: boolean; prepared: boolean };
  };
  assert.equal(jsonEnvelope.ok, true);
  assert.equal(jsonEnvelope.result.built, true);
  assert.equal(jsonEnvelope.result.prepared, true);
});

test("the repository command forwards owned revision selectors", async () => {
  let startOptions: unknown;
  await runPreparedDevInstance(["--revision", "local:feature", "--repo", "/tmp/bb", "--desktop"], {
    manager: recordingManager((options) => {
      startOptions = options;
      return runningResult("selected", "owned");
    }),
    runProgram: async () => 0,
  });
  assert.deepEqual(startOptions, {
    revision: "local:feature",
    repository: "/tmp/bb",
    desktop: true,
    json: true,
  });
});

test("the root dev loop starts, builds, baselines, then routes every watcher", async () => {
  const calls: string[][] = [];
  const result = await runPreparedDevInstance(["--watch"], {
    manager: recordingManager(() => runningResult("watch", "owned")),
    runProgram: async (_name, argv) => {
      calls.push([...argv]);
      return 0;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    ["bun", "run", "build:managed"],
    ["bun", "scripts/bb-dev-instance-setup.ts", "--expected-data-dir", "/tmp/.bb-dev/prepared"],
    [...WATCH_COMMAND],
  ]);
  assert.equal(WATCH_COMMAND.includes("!@smsunarto/bb-plugin-agent-proxy"), true);
});

test("attached preparation is refused before it starts or builds", async () => {
  let startOptions: unknown;
  const calls: string[][] = [];
  const manager = recordingManager((options) => {
    startOptions = options;
    return runningResult("attached", "attached");
  });
  const result = await runPreparedDevInstance(["--attach", "/tmp/bb", "--json"], {
    manager,
    runProgram: async (_name, argv) => {
      calls.push([...argv]);
      return 0;
    },
  });

  assert.equal(startOptions, undefined);
  assert.deepEqual(calls, []);
  assert.equal(result.exitCode, 1);
  const envelope = JSON.parse(result.stdout) as { error: { code: string } };
  assert.equal(envelope.error.code, "attached_source_unsupported");
});

test("the repository command keeps JSON parseable and reports baseline failures", async () => {
  const result = await runPreparedDevInstance(["--name", "broken", "--json"], {
    manager: recordingManager(() => runningResult("broken", "owned")),
    runProgram: async (_name, argv) =>
      argv.some((argument) => argument.endsWith("bb-dev-instance-setup.ts")) ? 7 : 0,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout) as {
    ok: boolean;
    name: string;
    error: { code: string; message: string };
  };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.name, "broken");
  assert.equal(envelope.error.code, "setup_failed");
  assert.match(envelope.error.message, /status 7/);
});

function recordingManager(start: (options: unknown) => InstanceResult): DevManager {
  return {
    resolveName: (name?: string) => name ?? "implicit",
    start: async (options: unknown) => start(options),
  } as unknown as DevManager;
}

function runningResult(name: string, source: "owned" | "attached"): InstanceResult {
  return {
    name,
    phase: "running",
    source,
    revision: source === "owned" ? "tag:desktop-v1.2.3" : null,
    commit: source === "owned" ? "a".repeat(40) : null,
    desiredRuntime: "web",
    checkoutPath: "/tmp/checkout",
    branch: "detached (fixture)",
    node: "fixture node",
    codex: "fixture codex",
    dataDir: "/tmp/.bb-dev/prepared",
    appUrl: "http://localhost:11001",
    serverUrl: "http://localhost:19001",
    hostDaemonUrl: "http://127.0.0.1:27001",
    desktopUserDataDir: "/tmp/.bb-dev/prepared/desktop",
    devSession: "running",
    desktopSession: "stopped",
    devLog: "/tmp/dev.log",
    desktopLog: "/tmp/desktop.log",
    launcherLog: "/tmp/launcher.log",
    running: true,
  };
}
