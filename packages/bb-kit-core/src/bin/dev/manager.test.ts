import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runDev } from "./command.ts";
import { DevError } from "./error.ts";
import { DevManager, type ManagerOptions } from "./manager.ts";
import {
  instancePaths,
  STATE_SCHEMA_VERSION,
  type InstanceState,
  type ProcessIdentity,
} from "./model.ts";
import { processIdentity, processMatches, runCommand, spawnAndWait } from "./process.ts";
import { assertRuntimeEnvContract, RUNTIME_ENV_KEYS } from "./runtime.ts";
import {
  claimDirectoryAtomically,
  ensureOwnedDirectory,
  InstanceStore,
  parseState,
} from "./store.ts";

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

test("attached start converges in place, leases its ports, and destroy preserves external paths", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  const dirtyPath = join(fixture.repository, "dirty.txt");
  writeFileSync(dirtyPath, "keep this edit\n");

  const first = await manager.start({ name: "attached", attach: fixture.repository });
  assert.equal(first.source, "attached");
  assert.equal(first.revision, null);
  assert.equal(first.checkoutPath, realpathSync(fixture.repository));
  assert.equal(readFileSync(dirtyPath, "utf8"), "keep this edit\n");
  assert.equal(readFileSync(`${fixture.repository}.fake-launcher-name`, "utf8").trim(), "<unset>");
  assert.equal(existsSync(join(fixture.home, "leases", "11001-19001-27001", "owner.json")), true);
  assert.equal(existsSync(join(fixture.repository, ".bb-kit-owner.json")), false);
  assert.equal(existsSync(join(`${fixture.repository}.data`, ".bb-kit-owner.json")), false);
  assert.equal(existsSync(join(`${fixture.repository}.logs`, ".bb-kit-owner.json")), false);

  const second = await manager.start({ name: "attached" });
  assert.equal(second.source, "attached");
  assert.equal(readFileSync(`${fixture.repository}.fake-starts`, "utf8").trim(), "1");

  mkdirSync(`${fixture.repository}.data`, { recursive: true });
  writeFileSync(join(`${fixture.repository}.data`, "preserved"), "data\n");
  writeFileSync(join(`${fixture.repository}.logs`, "preserved"), "logs\n");
  await manager.destroy("attached");
  assert.equal(existsSync(fixture.repository), true);
  assert.equal(readFileSync(dirtyPath, "utf8"), "keep this edit\n");
  assert.equal(readFileSync(join(`${fixture.repository}.data`, "preserved"), "utf8"), "data\n");
  assert.equal(readFileSync(join(`${fixture.repository}.logs`, "preserved"), "utf8"), "logs\n");
  assert.equal(existsSync(join(fixture.home, "instances", "attached")), false);
  assert.equal(existsSync(join(fixture.home, "leases", "11001-19001-27001")), false);
});

test("attached and owned source requests refuse mismatches", async () => {
  const fixture = createFixture();
  const other = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "attached-source", attach: fixture.repository });
  await assert.rejects(
    manager.start({ name: "attached-source", attach: other.repository }),
    (error) => error instanceof DevError && error.code === "source_mismatch",
  );
  await assert.rejects(
    manager.start({
      name: "attached-source",
      revision: "local:main",
      repository: fixture.repository,
    }),
    (error) => error instanceof DevError && error.code === "source_mismatch",
  );
  await manager.destroy("attached-source");

  await manager.start({
    name: "owned-source",
    revision: "local:main",
    repository: fixture.repository,
  });
  await assert.rejects(
    manager.start({ name: "owned-source", attach: fixture.repository }),
    (error) => error instanceof DevError && error.code === "source_mismatch",
  );
});

test("one port lease prevents two records from controlling an attached runtime", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "first-attachment", attach: fixture.repository });
  await assert.rejects(
    manager.start({ name: "second-attachment", attach: fixture.repository }),
    (error) => error instanceof DevError && error.code === "lease_mismatch",
  );
  const removed = await manager.destroy("second-attachment");
  assert.equal(removed.phase, "absent");
  assert.equal((await manager.status("first-attachment")).running, true);
  assert.equal(existsSync(fixture.repository), true);
});

test("run routes one running instance and blocks lifecycle changes while the child lives", async () => {
  const fixture = createFixture();
  const manager = fixture.manager({
    BB_THREAD_ID: "ambient-thread",
    BB_SERVER_URL: "http://localhost:9999",
  });
  await manager.start({ name: "routed", attach: fixture.repository });
  const environmentPath = join(fixture.root, "routed-environment.json");
  const readyPath = join(fixture.root, "routed-ready");
  const running = manager.run("routed", [
    process.execPath,
    "-e",
    `const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify(process.env)); fs.writeFileSync(process.argv[2], "ready"); setTimeout(() => {}, 300);`,
    environmentPath,
    readyPath,
  ]);
  await waitForFile(readyPath);
  await assert.rejects(
    manager.stop("routed", 50),
    (error) => error instanceof DevError && error.code === "instance_busy",
  );
  assert.equal(await running, 0);
  const environment = JSON.parse(readFileSync(environmentPath, "utf8")) as NodeJS.ProcessEnv;
  const routed = manager.environmentFor("routed");
  assert.equal(environment["BB_CLI"], routed.BB_CLI);
  assert.equal(environment["BB_SERVER_URL"], "http://localhost:11001");
  assert.equal(environment["BB_HOST_DAEMON_PORT"], "27001");
  assert.equal(environment["BB_KIT_DEV_NAME"], "routed");
  assert.equal(environment["BB_KIT_DEV_SOURCE"], "attached");
  assert.equal(environment["BB_THREAD_ID"], undefined);
  assert.equal(
    environment["PATH"]?.split(":")[0],
    join(fixture.home, "instances", "routed", "bin"),
  );

  await manager.stop("routed");
  await assert.rejects(
    manager.run("routed", [process.execPath, "-e", "process.exit(0)"]),
    (error) => error instanceof DevError && error.code === "instance_not_running",
  );
});

test("runSingleton reuses one live command and starts again after it exits", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "singleton", attach: fixture.repository });
  const startsPath = join(fixture.root, "singleton-starts");
  const readyPath = join(fixture.root, "singleton-ready");
  const cwdAlias = join(fixture.root, "singleton-cwd");
  symlinkSync(fixture.repository, cwdAlias);
  const command = [
    process.execPath,
    "-e",
    `const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "start\\n"); fs.writeFileSync(process.argv[2], "ready"); setTimeout(() => {}, 300);`,
    startsPath,
    readyPath,
  ] as const;

  const first = manager.runSingleton("singleton", command, {
    key: "plugin-watchers",
    cwd: fixture.repository,
  });
  await waitForFile(readyPath);
  const execs = join(fixture.home, "instances", "singleton", "execs");
  const recordName = readdirSync(execs).find((file) => file.startsWith("singleton-"));
  if (recordName === undefined) assert.fail("singleton record was not created");
  assert.match(recordName, /^singleton-[a-f0-9]{64}\.json$/);
  const record = JSON.parse(readFileSync(join(execs, recordName), "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(record["kind"], "singleton");
  assert.equal(record["schemaVersion"], 1);
  assert.equal(record["cwd"], realpathSync(fixture.repository));
  assert.equal(record["key"], "plugin-watchers");
  assert.match(String(record["commandDigest"]), /^[a-f0-9]{64}$/);
  assert.equal(typeof record["recordToken"], "string");
  assert.equal(typeof record["createdAt"], "string");
  assert.equal(typeof (record["identity"] as { pid?: unknown }).pid, "number");
  const reused = await manager.runSingleton("singleton", command, {
    key: "plugin-watchers",
    cwd: cwdAlias,
  });

  assert.equal(reused.kind, "reused");
  assert.equal(readFileSync(startsPath, "utf8"), "start\n");
  await assert.rejects(
    manager.runSingleton("singleton", [process.execPath, "-e", "setTimeout(() => {}, 50)"], {
      key: "plugin-watchers",
      cwd: fixture.repository,
    }),
    (error) => error instanceof DevError && error.code === "singleton_command_mismatch",
  );
  assert.deepEqual(await first, { kind: "exited", exitCode: 0 });
  assert.deepEqual(readdirSync(execs), []);

  assert.deepEqual(
    await manager.runSingleton(
      "singleton",
      [
        process.execPath,
        "-e",
        `require("node:fs").appendFileSync(process.argv[1], "start\\n")`,
        startsPath,
      ],
      { key: "plugin-watchers", cwd: fixture.repository },
    ),
    { kind: "exited", exitCode: 0 },
  );
  assert.equal(readFileSync(startsPath, "utf8"), "start\nstart\n");
});

test("concurrent singleton claims start one child", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "singleton-race", attach: fixture.repository });
  const startsPath = join(fixture.root, "singleton-race-starts");
  const command = [
    process.execPath,
    "-e",
    `require("node:fs").appendFileSync(process.argv[1], "start\\n"); setTimeout(() => {}, 150);`,
    startsPath,
  ] as const;
  const results = await Promise.all([
    manager.runSingleton("singleton-race", command, {
      key: "plugin-watchers",
      cwd: fixture.repository,
    }),
    manager.runSingleton("singleton-race", command, {
      key: "plugin-watchers",
      cwd: fixture.repository,
    }),
  ]);
  assert.deepEqual(results.map((result) => result.kind).toSorted(), ["exited", "reused"]);
  assert.equal(readFileSync(startsPath, "utf8"), "start\n");
});

test("ordinary runs stay concurrent", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "concurrent-runs", attach: fixture.repository });
  const startsPath = join(fixture.root, "ordinary-starts");
  const ordinaryCommand = [
    process.execPath,
    "-e",
    `const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "start\\n"); const deadline = Date.now() + 1000; const lines = () => fs.readFileSync(process.argv[1], "utf8").trim().split("\\n").length; while (lines() < 2 && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); process.exit(lines() >= 2 ? 0 : 9);`,
    startsPath,
  ] as const;
  const first = manager.run("concurrent-runs", ordinaryCommand);
  const second = manager.run("concurrent-runs", ordinaryCommand);
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  assert.equal(readFileSync(startsPath, "utf8"), "start\nstart\n");
});

test("live legacy execs block the first singleton claim and dead legacy execs are removed", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "legacy-singleton", attach: fixture.repository });
  const root = join(fixture.home, "instances", "legacy-singleton");
  const owner = JSON.parse(readFileSync(join(root, "owner.json"), "utf8")) as {
    ownerToken: string;
  };
  const identity = processIdentity(process.pid);
  assert.notEqual(identity, null);
  const execs = join(root, "execs");
  const legacyPath = join(execs, "legacy.json");
  const startedPath = join(fixture.root, "legacy-singleton-started");
  mkdirSync(execs);
  writeFileSync(
    legacyPath,
    `${JSON.stringify({ ownerToken: owner.ownerToken, identity, createdAt: new Date().toISOString() })}\n`,
  );

  await assert.rejects(
    manager.runSingleton(
      "legacy-singleton",
      [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(process.argv[1], "yes")`,
        startedPath,
      ],
      { key: "plugin-watchers", cwd: fixture.repository },
    ),
    (error) =>
      error instanceof DevError &&
      error.code === "legacy_exec_ambiguous" &&
      Array.isArray(error.details?.["pids"]) &&
      error.details["pids"].includes(process.pid),
  );
  assert.equal(existsSync(startedPath), false);

  writeFileSync(
    legacyPath,
    `${JSON.stringify({
      ownerToken: owner.ownerToken,
      identity: { pid: 999_999, started: "dead" },
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  assert.deepEqual(
    await manager.runSingleton(
      "legacy-singleton",
      [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(process.argv[1], "yes"); setTimeout(() => {}, 25)`,
        startedPath,
      ],
      { key: "plugin-watchers", cwd: fixture.repository },
    ),
    { kind: "exited", exitCode: 0 },
  );
  assert.equal(readFileSync(startedPath, "utf8"), "yes");
  assert.equal(existsSync(legacyPath), false);
});

test("singleton records fail closed and cleanup cannot remove a replacement", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "singleton-records", attach: fixture.repository });
  const store = new InstanceStore(instancePaths(fixture.home, "singleton-records"));
  const owner = store.readOwner();
  const identity = processIdentity(process.pid);
  if (identity === null) assert.fail("manager process identity is unavailable");
  const spec = {
    cwd: realpathSync(fixture.repository),
    key: "plugin-watchers",
    commandDigest: "a".repeat(64),
  };

  const first = store.addSingleton(owner.ownerToken, spec, identity);
  assert.throws(
    () => store.addSingleton(owner.ownerToken, spec, identity),
    (error) => error instanceof DevError && error.code === "singleton_slot_busy",
  );
  store.removeSingleton(first);
  const replacement = store.addSingleton(owner.ownerToken, spec, identity);
  store.removeSingleton(first);
  assert.equal(existsSync(replacement.path), true);
  const validRecord = JSON.parse(readFileSync(replacement.path, "utf8")) as Record<string, unknown>;

  writeFileSync(
    replacement.path,
    `${JSON.stringify({ ...validRecord, commandDigest: "b".repeat(64) })}\n`,
  );
  assert.throws(
    () => store.reconcileSingleton(owner.ownerToken, spec),
    (error) => error instanceof DevError && error.code === "singleton_command_mismatch",
  );
  assert.equal(existsSync(replacement.path), true);

  writeFileSync(
    replacement.path,
    `${JSON.stringify({ ...validRecord, cwd: join(fixture.root, "other") })}\n`,
  );
  assert.throws(
    () => store.reconcileSingleton(owner.ownerToken, spec),
    (error) => error instanceof DevError && error.code === "singleton_key_mismatch",
  );
  assert.equal(existsSync(replacement.path), true);

  writeFileSync(
    replacement.path,
    `${JSON.stringify({ ...validRecord, ownerToken: "another-owner" })}\n`,
  );
  assert.throws(
    () => store.reconcileSingleton(owner.ownerToken, spec),
    (error) => error instanceof DevError && error.code === "owner_mismatch",
  );
  assert.equal(existsSync(replacement.path), true);

  writeFileSync(replacement.path, "not json\n");
  assert.throws(
    () => store.reconcileSingleton(owner.ownerToken, spec),
    (error) => error instanceof DevError && error.code === "ambiguous_exec",
  );
  assert.equal(existsSync(replacement.path), true);

  writeFileSync(replacement.path, `${JSON.stringify(validRecord)}\n`);
  store.removeSingleton(replacement);
  const stale = store.addSingleton(owner.ownerToken, spec, {
    pid: 999_999,
    started: "dead",
  });
  assert.deepEqual(store.reconcileSingleton(owner.ownerToken, spec), { kind: "vacant" });
  assert.equal(existsSync(stale.path), false);

  const otherCwd = join(fixture.root, "other-cwd");
  mkdirSync(otherCwd);
  const otherWorkspace = store.addSingleton(
    owner.ownerToken,
    { ...spec, cwd: realpathSync(otherCwd) },
    identity,
  );
  const otherKey = store.addSingleton(owner.ownerToken, { ...spec, key: "other-job" }, identity);
  assert.notEqual(otherWorkspace.path, otherKey.path);
  assert.notEqual(otherWorkspace.path, stale.path);
  assert.notEqual(otherKey.path, stale.path);
  store.removeSingleton(otherWorkspace);
  store.removeSingleton(otherKey);
});

test("a dead manager lock is reclaimable while a tracked exec remains live", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "exec-lock", attach: fixture.repository });
  const readyPath = join(fixture.root, "exec-lock-ready");
  const command = [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(process.argv[1], "ready"); setTimeout(() => {}, 250)`,
    readyPath,
  ] as const;
  const running = manager.runSingleton("exec-lock", command, {
    key: "plugin-watchers",
    cwd: fixture.repository,
  });
  await waitForFile(readyPath);
  const store = new InstanceStore(instancePaths(fixture.home, "exec-lock"));
  const owner = store.readOwner();
  mkdirSync(store.paths.lock);
  writeFileSync(
    join(store.paths.lock, "owner.json"),
    `${JSON.stringify({
      ownerToken: owner.ownerToken,
      manager: { pid: 999_999, started: "dead" },
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  assert.deepEqual(
    await manager.runSingleton("exec-lock", command, {
      key: "plugin-watchers",
      cwd: fixture.repository,
    }),
    { kind: "reused" },
  );
  assert.deepEqual(await running, { kind: "exited", exitCode: 0 });
});

test("a singleton child exits when its record cannot be created", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  await manager.start({ name: "singleton-record-failure", attach: fixture.repository });
  const failure = new Error("record failed");
  const addSingleton = InstanceStore.prototype.addSingleton;
  let childIdentity: ProcessIdentity | null = null;
  InstanceStore.prototype.addSingleton = function (ownerToken, spec, identity) {
    childIdentity = identity;
    throw failure;
  };
  try {
    await assert.rejects(
      manager.runSingleton(
        "singleton-record-failure",
        [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        { key: "plugin-watchers", cwd: fixture.repository },
      ),
      (error) => error === failure,
    );
  } finally {
    InstanceStore.prototype.addSingleton = addSingleton;
  }
  if (childIdentity === null) assert.fail("singleton spawn did not produce an identity");
  assert.equal(processMatches(childIdentity), false);
});

test("resolveName prefers routed name, then Git workspace, then environment id", () => {
  const fixture = createFixture();
  assert.equal(fixture.manager({ BB_KIT_DEV_NAME: "routed-name" }).resolveName(), "routed-name");
  const workspaceManager = new DevManager({
    cwd: fixture.repository,
    environment: {
      ...process.env,
      BB_KIT_DEV_HOME: fixture.home,
      BB_ENVIRONMENT_ID: "ambient-environment",
    },
  });
  assert.match(workspaceManager.resolveName(), /^workspace-/);
  assert.match(
    fixture.manager({ BB_ENVIRONMENT_ID: "ambient-environment" }).resolveName(),
    /^environment-/,
  );
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

test("stored schema 1 plans upgrade to an owned source union", () => {
  const parsed = parseState({
    schemaVersion: 1,
    name: "legacy",
    ownerToken: "owner",
    createdAt: "created",
    updatedAt: "updated",
    phase: "preparing",
    step: "checkout",
    plan: {
      revision: {
        selector: "commit:abc",
        canonical: `commit:${"a".repeat(40)}`,
        source: "official",
        repository: "https://example.com/bb.git",
        label: "legacy",
        commit: "a".repeat(40),
      },
      checkoutPath: "/tmp/legacy",
      launcherPath: "/tmp/legacy/scripts/bb-dev-app",
      launcherName: "legacy-launcher",
      desiredRuntime: "web",
      shimPath: "/tmp/legacy-bin/bb",
      leaseKey: null,
      target: null,
    },
  });
  assert.equal(parsed.schemaVersion, STATE_SCHEMA_VERSION);
  if (parsed.phase !== "preparing") assert.fail("legacy state did not stay in preparation");
  assert.equal(parsed.plan.source, "owned");
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
      source: "owned",
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
  assert.match(help.stdout, /--attach PATH/);
  assert.match(help.stdout, /dev-instance run \[NAME\]/);

  let received: unknown;
  const recordingManager = {
    resolveName: (name?: string) => name ?? "implicit",
    start: async (options: unknown) => {
      received = options;
      return {
        name: "options",
        phase: "running",
        source: "owned",
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
    "BB_KIT_DEV_SOURCE",
    "BB_SERVER_URL",
    "name",
  ]);
  assert.equal(environment.BB_SERVER_URL, "http://localhost:11001");
  assert.equal(environment.BB_HOST_DAEMON_PORT, "27001");
  assert.equal(environment.BB_KIT_DEV_SOURCE, "owned");
  const envResult = await runDev(["env", "environment"], { manager });
  assert.equal(
    envResult.stdout,
    [
      `export BB_CLI='${environment.BB_CLI}'`,
      "export BB_SERVER_URL='http://localhost:11001'",
      "export BB_HOST_DAEMON_PORT='27001'",
      "export BB_KIT_DEV_NAME='environment'",
      "export BB_KIT_DEV_SOURCE='owned'",
      `export PATH='${join(fixture.home, "instances", "environment", "bin")}':"$PATH"`,
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(envResult.stdout, /BB_HOST_DAEMON_URL/);
  const statusResult = await runDev(["status", "environment"], { manager });
  assert.match(statusResult.stdout, /Checkout: .*checkout/);
  assert.match(statusResult.stdout, /Source: owned/);
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

  const invalidAttachRevision = await runDev([
    "start",
    "--attach",
    fixture.repository,
    "--revision",
    "latest",
  ]);
  assert.equal(invalidAttachRevision.exitCode, 2);
  assert.match(invalidAttachRevision.stderr, /cannot be combined/);
  const invalidAttachRepo = await runDev([
    "start",
    "--attach",
    fixture.repository,
    "--repo",
    fixture.repository,
  ]);
  assert.equal(invalidAttachRepo.exitCode, 2);
  const missingAttach = await runDev(["start", "--attach", join(fixture.root, "missing-bb")], {
    cwd: fixture.root,
    environment: { ...process.env, BB_KIT_DEV_HOME: fixture.home },
  });
  assert.equal(missingAttach.exitCode, 2);
  assert.match(missingAttach.stderr, /invalid_attach/);
  const missingRunSeparator = await runDev(["run", "environment", process.execPath], { manager });
  assert.equal(missingRunSeparator.exitCode, 2);
  assert.match(missingRunSeparator.stderr, /requires --/);

  let runArguments: unknown;
  const runManager = {
    resolveName: (name?: string) => name ?? "implicit",
    run: async (name: string | undefined, argv: readonly string[]) => {
      runArguments = { name, argv };
      return 0;
    },
  } as unknown as DevManager;
  const runResult = await runDev(["run", "environment", "--", "node", "script.js"], {
    manager: runManager,
  });
  assert.equal(runResult.exitCode, 0);
  assert.deepEqual(runArguments, {
    name: "environment",
    argv: ["node", "script.js"],
  });
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

test("a runtime shares the source checkout but owns its ports, data dir, and shim", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  const host = await manager.start({
    name: "host",
    revision: "local:main",
    repository: fixture.repository,
  });
  // A source checkout only qualifies once its dependencies are installed.
  mkdirSync(join(host.checkoutPath ?? "", "node_modules"), { recursive: true });

  const guest = await manager.start({
    name: "guest",
    revision: "local:main",
    repository: fixture.repository,
    from: "host",
    timeoutMs: 10_000,
  });

  assert.equal(guest.running, true);
  assert.equal(guest.checkoutPath, host.checkoutPath);
  assert.notEqual(guest.dataDir, host.dataDir);
  assert.notEqual(guest.appUrl, host.appUrl);
  // Directly under ~/.bb-dev and ending in 12 hex characters: the shape bb's own
  // dev data directories have, and the one agent-proxy refuses to load without.
  assert.equal(dirname(guest.dataDir ?? ""), join(fixture.userHome, ".bb-dev"));
  assert.match(basename(guest.dataDir ?? ""), /^bb-kit-runtime-guest-[0-9a-f]{12}$/u);

  // The runtime's own checkout directory is never created.
  assert.equal(existsSync(join(fixture.home, "instances", "guest", "checkout")), false);

  // Its shim points the bb CLI at this runtime rather than clearing the routing.
  const shim = readFileSync(join(fixture.home, "instances", "guest", "bin", "bb"), "utf8");
  assert.match(shim, /environment\.BB_SERVER_URL = /);
  assert.match(shim, /environment\.BB_HOST_DAEMON_PORT = /);
  assert.doesNotMatch(
    readFileSync(join(fixture.home, "instances", "host", "bin", "bb"), "utf8"),
    /environment\.BB_SERVER_URL = /,
  );

  // Destroying the runtime leaves the checkout it borrowed alone.
  await manager.stop("guest");
  await manager.destroy("guest");
  assert.equal(existsSync(host.checkoutPath ?? ""), true);
  assert.equal((await manager.status("host")).running, true);
  assert.equal(existsSync(guest.dataDir ?? ""), false);
});

test("two runtimes on one checkout lease distinct port triples", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  const host = await manager.start({
    name: "shared",
    revision: "local:main",
    repository: fixture.repository,
  });
  mkdirSync(join(host.checkoutPath ?? "", "node_modules"), { recursive: true });

  const options = {
    revision: "local:main",
    repository: fixture.repository,
    timeoutMs: 10_000,
  } as const;
  const first = await manager.start({ ...options, name: "runtime-one" });
  const second = await manager.start({ ...options, name: "runtime-two" });

  assert.equal(first.checkoutPath, host.checkoutPath);
  assert.equal(second.checkoutPath, host.checkoutPath);
  assert.notEqual(first.appUrl, second.appUrl);
  assert.notEqual(first.dataDir, second.dataDir);
  assert.equal(
    new Set([host.appUrl, first.appUrl, second.appUrl]).size,
    3,
    "each runtime holds its own app port",
  );
});

test("a runtime keeps its ports across a restart and refuses to borrow from itself", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  const host = await manager.start({
    name: "steady-host",
    revision: "local:main",
    repository: fixture.repository,
  });
  mkdirSync(join(host.checkoutPath ?? "", "node_modules"), { recursive: true });

  const options = {
    name: "steady",
    revision: "local:main",
    repository: fixture.repository,
    timeoutMs: 10_000,
  } as const;
  const first = await manager.start(options);
  await manager.stop("steady");
  const second = await manager.start(options);
  assert.equal(second.appUrl, first.appUrl, "a restarted runtime keeps its URL");
  assert.equal(second.dataDir, first.dataDir);

  // One lease, not one per restart.
  assert.deepEqual(readdirSync(join(fixture.home, "leases")).length, 2);

  await assert.rejects(
    manager.start({ ...options, name: "self", from: "self" }),
    (error) => error instanceof DevError && error.code === "runtime_source_unavailable",
  );
});

test("a runtime refuses a checkout whose dev environment contract has moved", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-contract-"));
  const configDir = join(root, "packages", "config", "src");
  mkdirSync(configDir, { recursive: true });
  const contract = join(configDir, "runtime.ts");

  writeFileSync(contract, devProcessEnvSource(RUNTIME_ENV_KEYS));
  assertRuntimeEnvContract(root);

  writeFileSync(contract, devProcessEnvSource([...RUNTIME_ENV_KEYS, "BB_SOMETHING_NEW"]));
  assert.throws(
    () => assertRuntimeEnvContract(root),
    (error) =>
      error instanceof DevError &&
      error.code === "runtime_env_drift" &&
      error.message.includes("BB_SOMETHING_NEW"),
  );

  writeFileSync(contract, "export function toDevProcessEnv() { return somethingElse; }\n");
  assert.throws(
    () => assertRuntimeEnvContract(root),
    (error) => error instanceof DevError && error.code === "unsupported_runtime_host",
  );
  assert.throws(
    () => assertRuntimeEnvContract(join(root, "absent")),
    (error) => error instanceof DevError && error.code === "unsupported_runtime_host",
  );
});

test("an opener spawn failure cannot crash a successful start", async () => {
  const fixture = createFixture();
  const opened: string[] = [];

  // A browser command that is missing, or rejects its arguments, throws right
  // out of spawn. The instance is already up by then, so start owes the caller
  // its result either way.
  const thrower = fixture.manager(
    {},
    {
      opener: (url) => {
        opened.push(url);
        throw new Error("spawn open ENOENT");
      },
    },
  );
  const thrown = await thrower.start({
    name: "throws",
    revision: "local:main",
    repository: fixture.repository,
    open: true,
  });
  assert.equal(thrown.running, true);
  assert.equal(thrown.phase, "running");
  assert.deepEqual(opened, [thrown.appUrl]);

  // A browser that fails after spawn reports it on the child, long after start
  // returned. The opener hands back void and is never awaited, so the failure
  // has nowhere to reach.
  const child = new EventEmitter();
  let asyncFailure: unknown = null;
  child.on("error", (error) => {
    asyncFailure = error;
  });
  // Its own fixture: the fake launcher reports one fixed port triple, so two
  // owned instances cannot share a workspace.
  const second = createFixture();
  const deferred = second.manager(
    {},
    {
      opener: () => {
        setTimeout(() => child.emit("error", new Error("browser exited")), 0);
      },
    },
  );
  const late = await deferred.start({
    name: "defers",
    revision: "local:main",
    repository: second.repository,
    open: true,
  });
  assert.equal(late.running, true);
  assert.equal(asyncFailure, null, "start returned before the opener failed");

  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  assert.match(String(asyncFailure), /browser exited/u);
  assert.equal((await deferred.status("defers")).running, true);
});

function createFixture(): {
  root: string;
  home: string;
  userHome: string;
  repository: string;
  manager: (environment?: NodeJS.ProcessEnv, overrides?: Partial<ManagerOptions>) => DevManager;
} {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-manager-"));
  const home = join(root, "state");
  const fakeHome = join(root, "home");
  const repository = join(root, "bb");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  mkdirSync(join(repository, "scripts"));
  const launcher = join(repository, "scripts", "bb-dev-app");
  writeFileSync(launcher, fakeLauncher());
  chmodSync(launcher, 0o755);
  // A runtime checks its source checkout for a package.json and reads the dev
  // environment contract out of it, so the fixture checkout carries both.
  writeFileSync(join(repository, "package.json"), '{ "name": "bb", "private": true }\n');
  mkdirSync(join(repository, "packages", "config", "src"), { recursive: true });
  writeFileSync(
    join(repository, "packages", "config", "src", "runtime.ts"),
    devProcessEnvSource(RUNTIME_ENV_KEYS),
  );
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "-m", "add fake launcher"]);

  // Ports a fake runtime is "serving" on, so the readiness probe can succeed
  // without a real dev stack. A port stops answering when the process holding
  // it exits, the way a real socket would.
  const listeners = new Map<number, ProcessIdentity>();
  return {
    root,
    home,
    userHome: fakeHome,
    repository,
    manager: (environment = {}, overrides = {}) =>
      new DevManager({
        cwd: root,
        environment: { ...process.env, ...environment, BB_KIT_DEV_HOME: home, HOME: fakeHome },
        healthProbe: async () => true,
        portProbe: async (port) => {
          const holder = listeners.get(port);
          return holder !== undefined && processMatches(holder);
        },
        runtimeSpawn: (args) => {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          const identity = child.pid === undefined ? null : processIdentity(child.pid);
          assert.notEqual(identity, null, "fake runtime did not start");
          for (const port of [
            args.ports.appPort,
            args.ports.serverPort,
            args.ports.hostDaemonPort,
          ]) {
            listeners.set(port, identity!);
          }
          return { identity: identity!, ports: args.ports };
        },
        // Never the real opener: a test must not open the user's browser.
        opener: () => {},
        ...overrides,
      }),
  };
}

/** A stand-in for bb's toDevProcessEnv, so the drift guard has a file to read. */
function devProcessEnvSource(keys: readonly string[]): string {
  const body = keys.map((key) => `    ${key}: "value",`).join("\n");
  return `export function toDevProcessEnv(args: DevProcessEnvArgs): NodeJS.ProcessEnv {
  const env = stripThreadContextEnv(args.baseEnv);
  return {
    ...env,
${body}
  };
}
`;
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
    printf '%s\n' "\${BB_DEV_LAUNCHER_NAME:-<unset>}" > "\${checkout}.fake-launcher-name"
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
