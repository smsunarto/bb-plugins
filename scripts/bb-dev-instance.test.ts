import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  EnvironmentResult,
  InstanceResult,
} from "../packages/bb-kit-core/src/bin/dev/model.ts";
import { DevManager } from "../packages/bb-kit-core/src/bin/dev/manager.ts";
import { runPreparedDevInstance } from "./bb-dev-instance.ts";

test("the repository command starts and prepares one named instance", async () => {
  let startOptions: unknown;
  let setupCalls = 0;
  const environment: EnvironmentResult = {
    name: "prepared",
    BB_CLI: "/tmp/prepared-bb",
    BB_SERVER_URL: "http://localhost:11001",
    BB_HOST_DAEMON_PORT: "27001",
    BB_KIT_DEV_NAME: "prepared",
  };
  const manager = {
    cwd: "/workspace",
    resolveName: (name?: string) => name ?? "implicit",
    start: async (options: unknown) => {
      startOptions = options;
      return runningResult("prepared");
    },
    environmentFor: () => environment,
  } as unknown as DevManager;

  const result = await runPreparedDevInstance(["--name", "prepared"], {
    manager,
    commandRunner: (received) => {
      assert.deepEqual(received, environment);
      return async (args) => {
        assert.deepEqual(args, ["settings", "show", "--json"]);
        return '{"dataDir":"/tmp/.bb-dev/prepared"}\n';
      };
    },
    setup: async (runCommand, log) => {
      setupCalls += 1;
      assert.equal(
        await runCommand?.(["settings", "show", "--json"]),
        '{"dataDir":"/tmp/.bb-dev/prepared"}\n',
      );
      log?.("prepared fixture");
    },
  });

  assert.deepEqual(startOptions, { name: "prepared", json: true });
  assert.equal(setupCalls, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "http://localhost:11001\n");

  const jsonResult = await runPreparedDevInstance(["--name", "help", "--json"], {
    manager,
    commandRunner: () => async () => "",
    setup: async () => {},
  });
  const jsonEnvelope = JSON.parse(jsonResult.stdout) as {
    ok: boolean;
    result: { prepared: boolean };
  };
  assert.equal(jsonEnvelope.ok, true);
  assert.equal(jsonEnvelope.result.prepared, true);
});

test("the repository command keeps JSON parseable and reports setup failures", async () => {
  const manager = {
    cwd: "/workspace",
    resolveName: (name?: string) => name ?? "implicit",
    start: async () => runningResult("broken"),
    environmentFor: () => ({
      name: "broken",
      BB_CLI: "/tmp/broken-bb",
      BB_SERVER_URL: "http://localhost:11001",
      BB_HOST_DAEMON_PORT: "27001",
      BB_KIT_DEV_NAME: "broken",
    }),
  } as unknown as DevManager;
  const result = await runPreparedDevInstance(["--name", "broken", "--json"], {
    manager,
    commandRunner: () => async () => "",
    setup: async () => {
      throw new Error("baseline did not converge");
    },
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
  assert.equal(envelope.error.message, "baseline did not converge");
});

function runningResult(name: string): InstanceResult {
  return {
    name,
    phase: "running",
    revision: "tag:desktop-v1.2.3",
    commit: "a".repeat(40),
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
