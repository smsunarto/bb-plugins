import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDev } from "./command.ts";
import { DevError } from "./error.ts";
import { DevManager } from "./manager.ts";
import { instancePaths, STATE_SCHEMA_VERSION, type InstanceState } from "./model.ts";
import { processIdentity, processMatches, runCommand, spawnAndWait } from "./process.ts";
import { claimDirectoryAtomically, ensureOwnedDirectory, InstanceStore } from "./store.ts";

test("start is retry-safe, explicit revision mismatch fails, and destroy is idempotent", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  const first = await manager.start({
    name: "repeat",
    revision: "local:main",
    repository: fixture.repository,
  });
  assert.equal(first.running, true);
  assert.equal(first.desiredRuntime, "web");
  assert.equal(first.branch, "detached (fixture)");
  assert.equal(first.node, "fixture");
  assert.equal(first.codex, "fixture");
  assert.equal(first.dataDir?.endsWith("checkout.data"), true);
  assert.equal(first.serverUrl, "http://localhost:19001");
  assert.equal(first.hostDaemonUrl, "http://127.0.0.1:27001");
  assert.equal(first.devSession, "running");
  assert.equal(first.desktopSession, "stopped");
  assert.equal(first.devLog?.endsWith("checkout.logs/dev.log"), true);
  const state = JSON.parse(
    readFileSync(join(fixture.home, "instances", "repeat", "state.json"), "utf8"),
  ) as { plan: { checkoutPath: string } };
  assert.equal(
    state.plan.checkoutPath,
    join(realpathSync(join(fixture.home, "instances", "repeat")), "checkout"),
  );
  const starts = join(fixture.home, "instances", "repeat", "checkout.fake-starts");
  assert.equal(readFileSync(starts, "utf8").trim(), "1");

  const second = await manager.start({ name: "repeat" });
  assert.equal(second.commit, first.commit);
  assert.equal(readFileSync(starts, "utf8").trim(), "1");

  commitFile(fixture.repository, "moved.txt", "moved", "move main");
  await assert.rejects(
    manager.start({ name: "repeat", revision: "local:main", repository: fixture.repository }),
    (error) => error instanceof DevError && error.code === "revision_mismatch",
  );

  const stopped = await manager.stop("repeat");
  assert.equal(stopped.running, false);
  const destroyed = await manager.destroy("repeat");
  assert.equal(destroyed.phase, "absent");
  assert.equal(existsSync(join(fixture.home, "instances", "repeat")), false);
  const repeated = await manager.destroy("repeat");
  assert.equal(repeated.phase, "absent");
});

test("a live lock returns the stable busy error after the bounded wait", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "locked", revision: "local:main", repository: fixture.repository });
  const root = join(fixture.home, "instances", "locked");
  const owner = JSON.parse(readFileSync(join(root, "owner.json"), "utf8")) as {
    ownerToken: string;
  };
  const identity = processIdentity(process.pid);
  assert.notEqual(identity, null);
  mkdirSync(join(root, "lock"));
  writeFileSync(
    join(root, "lock", "owner.json"),
    `${JSON.stringify({ ownerToken: owner.ownerToken, manager: identity, createdAt: new Date().toISOString() })}\n`,
  );
  await assert.rejects(
    manager.stop("locked", 30),
    (error) => error instanceof DevError && error.code === "instance_busy",
  );
});

test("competing starts serialize and perform the launcher mutation once", async () => {
  const fixture = createFixture();
  const first = fixture.manager({ FAKE_START_DELAY: "0.2" });
  const second = fixture.manager({ FAKE_START_DELAY: "0.2" });
  const options = {
    name: "competing",
    revision: "local:main",
    repository: fixture.repository,
    timeoutMs: 5_000,
  } as const;
  const results = await Promise.all([first.start(options), second.start(options)]);
  assert.equal(
    results.every((result) => result.running),
    true,
  );
  const starts = join(fixture.home, "instances", "competing", "checkout.fake-starts");
  assert.equal(readFileSync(starts, "utf8").trim(), "1");
});

test("a dead manager lock stays busy while its recorded child identity survives", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "child", revision: "local:main", repository: fixture.repository });
  const root = join(fixture.home, "instances", "child");
  const owner = JSON.parse(readFileSync(join(root, "owner.json"), "utf8")) as {
    ownerToken: string;
  };
  const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const identity = processIdentity(process.pid);
  assert.notEqual(identity, null);
  writeFileSync(
    join(root, "state.json"),
    `${JSON.stringify({ ...state, phase: "starting", child: identity, updatedAt: new Date().toISOString() })}\n`,
  );
  mkdirSync(join(root, "lock"));
  writeFileSync(
    join(root, "lock", "owner.json"),
    `${JSON.stringify({
      ownerToken: owner.ownerToken,
      manager: { pid: 999_999, started: "dead" },
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  await assert.rejects(
    manager.stop("child", 30),
    (error) => error instanceof DevError && error.code === "instance_busy",
  );
});

test("destroy resumes after the checkout removal checkpoint", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({
    name: "resume-destroy",
    revision: "local:main",
    repository: fixture.repository,
  });
  await manager.stop("resume-destroy");
  const root = join(fixture.home, "instances", "resume-destroy");
  const statePath = join(root, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    plan: { checkoutPath: string };
  } & Record<string, unknown>;
  writeFileSync(
    statePath,
    `${JSON.stringify({ ...state, phase: "destroying", step: "checkout", updatedAt: new Date().toISOString() })}\n`,
  );
  rmSync(state.plan.checkoutPath, { recursive: true });
  const result = await manager.destroy("resume-destroy");
  assert.equal(result.phase, "absent");
  assert.equal(existsSync(root), false);
});

test("an active exec record blocks destroy", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({
    name: "active-exec",
    revision: "local:main",
    repository: fixture.repository,
  });
  const root = join(fixture.home, "instances", "active-exec");
  const owner = JSON.parse(readFileSync(join(root, "owner.json"), "utf8")) as {
    ownerToken: string;
  };
  const identity = processIdentity(process.pid);
  assert.notEqual(identity, null);
  mkdirSync(join(root, "execs"));
  writeFileSync(
    join(root, "execs", "active.json"),
    `${JSON.stringify({ ownerToken: owner.ownerToken, identity, createdAt: new Date().toISOString() })}\n`,
  );
  await assert.rejects(
    manager.destroy("active-exec", 30),
    (error) => error instanceof DevError && error.code === "instance_busy",
  );
});

test("JSON output uses one versioned envelope", async () => {
  const home = mkdtempSync(join(tmpdir(), "bb-kit-json-"));
  const result = await runDev(["status", "missing", "--json"], {
    cwd: home,
    environment: { ...process.env, BB_KIT_DEV_HOME: home },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const envelope = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assert.equal(envelope["schemaVersion"], 1);
  assert.equal(envelope["ok"], true);
  assert.equal(envelope["command"], "status");
});

test("atomic directory claims recover an empty interruption without replacing owned data", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-atomic-"));
  const target = join(root, "claim");
  assert.equal(claimDirectoryAtomically(target, "owner.json", { ownerToken: "first" }), true);
  assert.equal(claimDirectoryAtomically(target, "owner.json", { ownerToken: "second" }), false);
  assert.deepEqual(JSON.parse(readFileSync(join(target, "owner.json"), "utf8")), {
    ownerToken: "first",
  });

  const ownerless = join(root, "ownerless");
  mkdirSync(ownerless);
  assert.equal(claimDirectoryAtomically(ownerless, "owner.json", { ownerToken: "third" }), true);
  assert.deepEqual(JSON.parse(readFileSync(join(ownerless, "owner.json"), "utf8")), {
    ownerToken: "third",
  });

  const occupied = join(root, "occupied");
  mkdirSync(occupied);
  writeFileSync(join(occupied, "unknown"), "keep\n");
  assert.equal(claimDirectoryAtomically(occupied, "owner.json", { ownerToken: "fourth" }), false);
  assert.equal(readFileSync(join(occupied, "unknown"), "utf8"), "keep\n");
  assert.equal(existsSync(join(occupied, "owner.json")), false);
});

test("destroy removes an owned instance after revision resolution fails", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await assert.rejects(
    manager.start({
      name: "failed-resolution",
      revision: "local:missing",
      repository: fixture.repository,
    }),
    (error) => error instanceof DevError && error.code === "revision_not_found",
  );
  const destroyed = await manager.destroy("failed-resolution");
  assert.equal(destroyed.phase, "absent");
  assert.equal(existsSync(join(fixture.home, "instances", "failed-resolution")), false);
});

test("destroy removes an owned partial checkout plan without a launcher target", async () => {
  const fixture = createFixture();
  const name = "partial-checkout";
  const store = new InstanceStore(instancePaths(fixture.home, name));
  const owner = store.claim(name);
  const checkoutPath = join(realpathSync(store.paths.root), "checkout");
  ensureOwnedDirectory(checkoutPath, owner.ownerToken, "checkout");
  const now = new Date().toISOString();
  const commit = git(fixture.repository, ["rev-parse", "HEAD"]);
  const state: InstanceState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    name,
    ownerToken: owner.ownerToken,
    createdAt: now,
    updatedAt: now,
    phase: "preparing",
    step: "checkout",
    plan: {
      revision: {
        selector: "local:main",
        canonical: "local:main",
        source: "selected-repository",
        repository: realpathSync(fixture.repository),
        label: "main",
        commit,
      },
      checkoutPath,
      launcherPath: join(checkoutPath, "scripts", "bb-dev-app"),
      launcherName: "bb-kit-partial-checkout",
      desiredRuntime: "web",
      shimPath: join(store.paths.bin, "bb"),
      leaseKey: null,
      target: null,
    },
  };
  store.write(state);
  const destroyed = await fixture.manager().destroy(name);
  assert.equal(destroyed.phase, "absent");
  assert.equal(existsSync(store.paths.root), false);
});

test("dev help, start options, env keys, and invalid arguments have stable parsing", async () => {
  const help = await runDev(["--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /bb-kit dev-instance start/);

  let received: unknown;
  const recordingManager = {
    resolveName: (name?: string) => name ?? "implicit",
    start: async (options: unknown) => {
      received = options;
      return {
        name: "options",
        phase: "running",
        revision: "tag:desktop-v1.2.3",
        commit: "a".repeat(40),
        desiredRuntime: "desktop",
        appUrl: "http://localhost:11001",
        running: true,
      };
    },
  } as unknown as DevManager;
  const started = await runDev(
    [
      "start",
      "--name",
      "options",
      "--revision",
      "tag:desktop-v1.2.3",
      "--repo",
      "/selected/bb",
      "--desktop",
      "--open",
      "--timeout",
      "2.5",
      "--json",
    ],
    { manager: recordingManager },
  );
  assert.equal(started.exitCode, 0);
  assert.deepEqual(received, {
    name: "options",
    revision: "tag:desktop-v1.2.3",
    repository: "/selected/bb",
    desktop: true,
    open: true,
    timeoutMs: 2_500,
    json: true,
  });
  await runDev(["start", "--name", "default-timeout", "--json"], {
    manager: recordingManager,
  });
  assert.deepEqual(received, {
    name: "default-timeout",
    json: true,
  });

  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({
    name: "environment",
    revision: "local:main",
    repository: fixture.repository,
  });
  const environment = manager.environmentFor("environment");
  assert.deepEqual(Object.keys(environment).toSorted(), [
    "BB_CLI",
    "BB_HOST_DAEMON_PORT",
    "BB_KIT_DEV_NAME",
    "BB_SERVER_URL",
    "name",
  ]);
  assert.equal(environment.BB_SERVER_URL, "http://localhost:11001");
  assert.equal(environment.BB_HOST_DAEMON_PORT, "27001");
  const envResult = await runDev(["env", "environment"], { manager });
  assert.equal(
    envResult.stdout,
    [
      `export BB_CLI='${environment.BB_CLI}'`,
      "export BB_SERVER_URL='http://localhost:11001'",
      "export BB_HOST_DAEMON_PORT='27001'",
      "export BB_KIT_DEV_NAME='environment'",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(envResult.stdout, /BB_HOST_DAEMON_URL/);
  const statusResult = await runDev(["status", "environment"], { manager });
  assert.match(statusResult.stdout, /Checkout: .*checkout/);
  assert.match(statusResult.stdout, /Branch: detached \(fixture\)/);
  assert.match(statusResult.stdout, /Node: fixture/);
  assert.match(statusResult.stdout, /Codex: fixture/);
  assert.match(statusResult.stdout, /Server: http:\/\/localhost:19001/);
  assert.match(statusResult.stdout, /Host daemon: http:\/\/127\.0\.0\.1:27001/);
  assert.match(statusResult.stdout, /Dev session: running/);
  assert.match(statusResult.stdout, /Launcher log: .*launcher\.log/);

  const invalid = await runDev(["start", "--unknown"], { manager });
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /invalid_arguments/);
  const missingSeparator = await runDev(["exec", "environment", "status"], { manager });
  assert.equal(missingSeparator.exitCode, 2);
  assert.match(missingSeparator.stderr, /requires --/);
});

test("launcher start and stop timeouts terminate their checkpointed process groups", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "timeout", revision: "local:main", repository: fixture.repository });
  await manager.stop("timeout");

  const startPids = join(fixture.home, "start-pids");
  const slowStart = fixture.manager({ FAKE_START_DELAY: "10", FAKE_PID_FILE: startPids });
  const startRejection = assert.rejects(
    slowStart.start({ name: "timeout", timeoutMs: 400 }),
    (error) => error instanceof DevError && error.code === "launcher_timeout",
  );
  await waitForFile(startPids);
  const [startShell] = readPids(startPids);
  const starting = JSON.parse(
    readFileSync(join(fixture.home, "instances", "timeout", "state.json"), "utf8"),
  ) as { phase: string; child: { pid: number } };
  assert.equal(starting.phase, "starting");
  assert.equal(starting.child.pid, startShell);
  await startRejection;
  await assertPidsExit(readPids(startPids));

  await manager.start({ name: "timeout", timeoutMs: 5_000 });
  const stopPids = join(fixture.home, "stop-pids");
  const slowStop = fixture.manager({ FAKE_STOP_DELAY: "10", FAKE_PID_FILE: stopPids });
  const stopRejection = assert.rejects(
    slowStop.stop("timeout", 400),
    (error) => error instanceof DevError && error.code === "launcher_timeout",
  );
  await waitForFile(stopPids);
  const [stopShell] = readPids(stopPids);
  const stopping = JSON.parse(
    readFileSync(join(fixture.home, "instances", "timeout", "state.json"), "utf8"),
  ) as { phase: string; child: { pid: number } };
  assert.equal(stopping.phase, "stopping");
  assert.equal(stopping.child.pid, stopShell);
  await stopRejection;
  await assertPidsExit(readPids(stopPids));

  await manager.stop("timeout", 5_000);
  await manager.destroy("timeout", 5_000);
});

test("spawnAndWait terminates the owned group when its checkpoint callback throws", async () => {
  const checkpointFailure = new Error("checkpoint failed");
  let childIdentity: ReturnType<typeof processIdentity> = null;
  await assert.rejects(
    spawnAndWait(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
      (identity) => {
        childIdentity = identity;
        throw checkpointFailure;
      },
      { timeoutMs: 5_000 },
    ),
    (error) => error === checkpointFailure,
  );
  if (childIdentity === null) {
    assert.fail("spawn callback did not receive a process identity");
  }
  assert.equal(processMatches(childIdentity), false);
});

function createFixture(): {
  home: string;
  repository: string;
  manager: (environment?: NodeJS.ProcessEnv) => DevManager;
} {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-manager-"));
  const home = join(root, "state");
  const repository = join(root, "bb");
  mkdirSync(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  mkdirSync(join(repository, "scripts"));
  const launcher = join(repository, "scripts", "bb-dev-app");
  writeFileSync(launcher, fakeLauncher());
  chmodSync(launcher, 0o755);
  git(repository, ["add", "scripts/bb-dev-app"]);
  git(repository, ["commit", "-m", "add fake launcher"]);
  return {
    home,
    repository,
    manager: (environment = {}) =>
      new DevManager({
        cwd: root,
        environment: { ...process.env, ...environment, BB_KIT_DEV_HOME: home },
        healthProbe: async () => true,
        portProbe: async () => false,
      }),
  };
}

function fakeLauncher(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
checkout="\${BB_DEV_REPO_ROOT:-$PWD}"
running="\${checkout}.fake-running"
desktop="\${checkout}.fake-desktop"
starts="\${checkout}.fake-starts"
data="\${checkout}.data"
logs="\${checkout}.logs"
case "\${1:-}" in
  --help|help|-h)
    echo "current stop status env"
    ;;
  status)
    mkdir -p "\${logs}"
    echo "Repo: \${checkout}"
    echo "Branch: detached (fixture)"
    echo "Node: fixture"
    echo "Codex: fixture"
    echo "Instance: fixture"
    echo "Data dir: \${data}"
    echo "App: http://localhost:11001"
    echo "Server: http://localhost:19001"
    echo "Host daemon: http://127.0.0.1:27001"
    echo "Desktop user data: \${data}/desktop"
    [[ -f "\${running}" ]] && echo "Dev session: running" || echo "Dev session: stopped"
    [[ -f "\${desktop}" ]] && echo "Desktop session: running" || echo "Desktop session: stopped"
    echo "Logs: \${logs}/dev.log, \${logs}/desktop.log"
    ;;
  current)
    delay="\${FAKE_START_DELAY:-0}"
    if [[ "\${delay}" != "0" ]]; then
      sleep "\${delay}" &
      worker_pid=$!
      [[ -n "\${FAKE_PID_FILE:-}" ]] && echo "$$ \${worker_pid}" > "\${FAKE_PID_FILE}"
      wait "\${worker_pid}"
    fi
    count=0
    [[ -f "\${starts}" ]] && count="$(cat "\${starts}")"
    echo "$((count + 1))" > "\${starts}"
    touch "\${running}"
    [[ " $* " == *" --desktop "* ]] && touch "\${desktop}"
    mkdir -p "\${logs}"
    echo started >> "\${logs}/dev.log"
    ;;
  stop)
    delay="\${FAKE_STOP_DELAY:-0}"
    if [[ "\${delay}" != "0" ]]; then
      sleep "\${delay}" &
      worker_pid=$!
      [[ -n "\${FAKE_PID_FILE:-}" ]] && echo "$$ \${worker_pid}" > "\${FAKE_PID_FILE}"
      wait "\${worker_pid}"
    fi
    rm -f "\${running}" "\${desktop}"
    ;;
  env)
    echo "export BB_SERVER_URL=http://localhost:19001"
    ;;
  *)
    exit 2
    ;;
esac
`;
}

function commitFile(repository: string, file: string, contents: string, message: string): string {
  writeFileSync(join(repository, file), `${contents}\n`);
  git(repository, ["add", file]);
  git(repository, ["commit", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

function git(cwd: string, args: readonly string[]): string {
  const result = runCommand("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readPids(path: string): number[] {
  return readFileSync(path, "utf8").trim().split(/\s+/).map(Number);
}

async function assertPidsExit(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (pids.some(isPidAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(pids.filter(isPidAlive), []);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
