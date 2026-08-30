import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  LaunchdSupervisor,
  SystemdSupervisor,
  parseLaunchctlPrint,
  parseSystemctlShow,
  renderLaunchAgentPlist,
  renderSystemdUserUnit,
  type CommandRunner,
  type CommandResult,
} from "../lib/core-process.ts";

/** Neutral fixture label. The supervisors treat the label as opaque, so the
    tests derive every expected path and service target from this one value. */
const TEST_LABEL = "com.example.bb.agent-proxy";

interface FakeJob {
  loaded: boolean;
  state: string;
  pid: number | null;
  runs: number;
  lastExitCode: number | null;
  lastSignal: string | null;
}

function successful(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function launchctlOutput(job: FakeJob): string {
  return `gui/501/${TEST_LABEL} = {
\tstate = ${job.state}
\truns = ${job.runs}
${job.pid === null ? "" : `\tpid = ${job.pid}\n`}${
    job.lastExitCode === null ? "" : `\tlast exit code = ${job.lastExitCode}\n`
  }${job.lastSignal === null ? "" : `\tlast terminating signal = ${job.lastSignal}\n`}}
`;
}

function makeFakeLaunchctl(initial: Partial<FakeJob> = {}) {
  const calls: string[][] = [];
  const job: FakeJob = {
    loaded: false,
    state: "waiting",
    pid: null,
    runs: 0,
    lastExitCode: null,
    lastSignal: null,
    ...initial,
  };
  let nextPid = 9000;
  const runner: CommandRunner = async (file, args) => {
    assert.equal(file, "/bin/launchctl");
    calls.push(args);
    switch (args[0]) {
      case "print":
        return job.loaded
          ? successful(launchctlOutput(job))
          : { code: 113, stdout: "", stderr: "Could not find service in domain for user gui: 501" };
      case "enable":
      case "disable":
        return successful();
      case "bootstrap":
        job.loaded = true;
        job.state = "running";
        job.pid = ++nextPid;
        job.runs += 1;
        return successful();
      case "bootout":
        if (!job.loaded) {
          return { code: 113, stdout: "", stderr: "Could not find service" };
        }
        job.loaded = false;
        job.state = "waiting";
        job.pid = null;
        return successful();
      case "kickstart":
        job.loaded = true;
        job.state = "running";
        job.pid = ++nextPid;
        job.runs += 1;
        return successful();
      default:
        throw new Error(`unexpected launchctl command: ${args.join(" ")}`);
    }
  };
  return { calls, job, runner };
}

function makeSupervisor(options: {
  installed?: () => boolean;
  launchctl?: ReturnType<typeof makeFakeLaunchctl>;
  fetchImpl?: typeof fetch;
  logLimit?: number;
  now?: () => number;
}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-launchd-"));
  const launchctl = options.launchctl ?? makeFakeLaunchctl();
  const plistPath = join(dir, "Library", "LaunchAgents", `${TEST_LABEL}.plist`);
  const logPath = join(dir, "core", "launchd.log");
  const transitions: string[] = [];
  const supervisor = new LaunchdSupervisor({
    label: TEST_LABEL,
    uid: 501,
    plistPath,
    binPath: join(dir, "core", "bin", "current", "cli-proxy-api"),
    configPath: join(dir, "core", "config.yaml"),
    logPath,
    isInstalled: options.installed ?? (() => true),
    probeUrl: () => "http://127.0.0.1:8317/",
    runCommand: launchctl.runner,
    fetchImpl: options.fetchImpl ?? ((() => Promise.resolve(new Response("ok"))) as typeof fetch),
    monitorIntervalMs: 10,
    ...(options.logLimit === undefined ? {} : { logLimit: options.logLimit }),
    platform: "darwin",
    now: options.now ?? (() => 1_700_000_000_000),
    onChange: (snapshot) => transitions.push(snapshot.state),
  });
  return { supervisor, transitions, launchctl, plistPath, logPath };
}

test("renders a private, persistent launch agent definition", () => {
  const plist = renderLaunchAgentPlist({
    label: "com.example.proxy",
    binPath: "/Users/a&b/core/proxy",
    configPath: "/Users/a&b/core/config.yaml",
    logPath: "/Users/a&b/core/core.log",
  });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.match(plist, /\/Users\/a&amp;b\/core\/proxy/);
  assert.match(plist, /<key>StandardOutPath<\/key>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>/);
});

test("parses launchctl service state", () => {
  assert.deepEqual(
    parseLaunchctlPrint(`state = running
runs = 4
pid = 8123
last exit code = 2
last terminating signal = Terminated: 15
`),
    {
      state: "running",
      pid: 8123,
      runs: 4,
      lastExitCode: 2,
      lastSignal: "Terminated: 15",
    },
  );
});

test("does not install a launch agent before the core exists", async () => {
  const { supervisor, launchctl, plistPath } = makeSupervisor({ installed: () => false });
  const snapshot = await supervisor.start();
  assert.equal(snapshot.state, "not-installed");
  assert.deepEqual(launchctl.calls, []);
  assert.equal(existsSync(plistPath), false);
});

test("start writes, enables, bootstraps, and then leaves a running job alone", async () => {
  const { supervisor, launchctl, plistPath } = makeSupervisor({});
  const first = await supervisor.start();
  assert.equal(first.state, "running");
  assert.equal(first.loaded, true);
  assert.ok(first.pid);
  assert.ok(readFileSync(plistPath, "utf8").includes(`<string>${TEST_LABEL}</string>`));
  assert.deepEqual(
    launchctl.calls.map((args) => args[0]),
    ["enable", "print", "bootstrap", "print"],
  );

  launchctl.calls.length = 0;
  const second = await supervisor.start();
  assert.equal(second.pid, first.pid);
  assert.deepEqual(
    launchctl.calls.map((args) => args[0]),
    ["enable", "print", "print"],
  );
});

test("stop removes and disables the job but preserves its plist", async () => {
  const { supervisor, launchctl, plistPath } = makeSupervisor({});
  await supervisor.start();
  launchctl.calls.length = 0;
  const snapshot = await supervisor.stop();
  assert.equal(snapshot.state, "stopped");
  assert.equal(snapshot.loaded, false);
  assert.equal(existsSync(plistPath), true);
  assert.deepEqual(
    launchctl.calls.map((args) => args[0]),
    ["bootout", "disable"],
  );
});

test("restart kickstarts a loaded job", async () => {
  const { supervisor, launchctl } = makeSupervisor({});
  const first = await supervisor.start();
  launchctl.calls.length = 0;
  const second = await supervisor.restart();
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(launchctl.calls.at(2), ["kickstart", "-k", `gui/501/${TEST_LABEL}`]);
});

test("a changed plist is re-bootstrapped before start", async () => {
  const { supervisor, launchctl, plistPath } = makeSupervisor({});
  await supervisor.start();
  writeFileSync(plistPath, "stale definition");
  launchctl.calls.length = 0;
  await supervisor.start();
  assert.deepEqual(
    launchctl.calls.map((args) => args[0]),
    ["enable", "print", "bootout", "bootstrap", "print"],
  );
});

test("reports a launchd crash and its last exit", async () => {
  const launchctl = makeFakeLaunchctl({
    loaded: true,
    state: "waiting",
    runs: 4,
    lastExitCode: 2,
  });
  const { supervisor } = makeSupervisor({ launchctl });
  const snapshot = await supervisor.snapshot();
  assert.equal(snapshot.state, "crashed");
  assert.equal(snapshot.crashCount, 3);
  assert.deepEqual(snapshot.lastExit, {
    code: 2,
    signal: null,
    at: 1_700_000_000_000,
  });
});

test("reports a signal-only launchd exit as crashed", async () => {
  const launchctl = makeFakeLaunchctl({
    loaded: true,
    state: "waiting",
    runs: 2,
    lastExitCode: 0,
    lastSignal: "Terminated: 15",
  });
  const { supervisor } = makeSupervisor({ launchctl });
  const snapshot = await supervisor.snapshot();
  assert.equal(snapshot.state, "crashed");
  assert.deepEqual(snapshot.lastExit, {
    code: 0,
    signal: "Terminated: 15",
    at: 1_700_000_000_000,
  });
});

test("launchd stop tolerates only missing-service disable errors", async () => {
  const missingLaunchctl = makeFakeLaunchctl();
  const missingRunner = missingLaunchctl.runner;
  missingLaunchctl.runner = async (file, args) =>
    args[0] === "disable"
      ? { code: 113, stdout: "", stderr: "Could not find service" }
      : missingRunner(file, args);
  const missing = makeSupervisor({ launchctl: missingLaunchctl });
  assert.equal((await missing.supervisor.stop()).state, "stopped");

  const rejectedLaunchctl = makeFakeLaunchctl();
  const rejectedRunner = rejectedLaunchctl.runner;
  rejectedLaunchctl.runner = async (file, args) =>
    args[0] === "disable"
      ? { code: 77, stdout: "", stderr: "permission denied" }
      : rejectedRunner(file, args);
  const rejected = makeSupervisor({ launchctl: rejectedLaunchctl });
  await assert.rejects(rejected.supervisor.stop(), /permission denied/);
});

test("launchd stop overtakes and discards a stale observation", { timeout: 2_000 }, async () => {
  const probeStarted = deferred<void>();
  const probeResponse = deferred<Response>();
  let nowCalls = 0;
  const launchctl = makeFakeLaunchctl({
    loaded: true,
    state: "running",
    pid: 9_001,
    runs: 2,
    lastExitCode: 7,
  });
  const { supervisor, transitions } = makeSupervisor({
    launchctl,
    fetchImpl: (() => {
      probeStarted.resolve();
      return probeResponse.promise;
    }) as typeof fetch,
    now: () => 1_700_000_000_000 + ++nowCalls,
  });

  const staleObservation = supervisor.snapshot();
  await probeStarted.promise;
  const stopped = await supervisor.stop();
  assert.equal(stopped.state, "stopped");
  probeResponse.resolve(new Response("ok"));

  assert.deepEqual(await staleObservation, stopped);
  assert.deepEqual(transitions, ["stopping", "stopped"]);
  assert.equal(nowCalls, 0);
});

test("launchd lifecycle operations are serialized", { timeout: 2_000 }, async () => {
  const enableStarted = deferred<void>();
  const releaseEnable = deferred<void>();
  const launchctl = makeFakeLaunchctl();
  const baseRunner = launchctl.runner;
  launchctl.runner = async (file, args) => {
    if (args[0] === "enable") {
      enableStarted.resolve();
      await releaseEnable.promise;
    }
    return baseRunner(file, args);
  };
  const { supervisor } = makeSupervisor({ launchctl });

  const starting = supervisor.start();
  await enableStarted.promise;
  const stopping = supervisor.stop();
  assert.equal(
    launchctl.calls.some((args) => args[0] === "bootout" || args[0] === "disable"),
    false,
  );

  releaseEnable.resolve();
  const [started, stopped] = await Promise.all([starting, stopping]);
  assert.equal(started.state, "running");
  assert.equal(stopped.state, "stopped");
});

test("a rejected launchd lifecycle operation does not poison later work", async () => {
  const launchctl = makeFakeLaunchctl({ loaded: true, state: "running", pid: 9_001 });
  const baseRunner = launchctl.runner;
  let rejectDisable = true;
  launchctl.runner = async (file, args) => {
    if (args[0] === "disable" && rejectDisable) {
      rejectDisable = false;
      return { code: 77, stdout: "", stderr: "permission denied" };
    }
    return baseRunner(file, args);
  };
  const { supervisor } = makeSupervisor({ launchctl });

  await assert.rejects(supervisor.stop(), /permission denied/);
  assert.equal((await supervisor.stop()).state, "stopped");
});

test("aborting the monitor does not stop the external service", async () => {
  const { supervisor, launchctl } = makeSupervisor({});
  await supervisor.start();
  launchctl.calls.length = 0;
  const controller = new AbortController();
  const done = supervisor.monitor(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort();
  await done;
  assert.equal(launchctl.job.loaded, true);
  assert.equal(
    launchctl.calls.some((args) => args[0] === "bootout"),
    false,
  );
  assert.equal(
    launchctl.calls.some((args) => args[0] === "disable"),
    false,
  );
});

test("reads the bounded launchd log tail", () => {
  const { supervisor, logPath } = makeSupervisor({ logLimit: 3 });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, "one\ntwo\nthree\nfour\n");
  assert.deepEqual(supervisor.logs(), ["two", "three", "four"]);
});

interface FakeSystemdJob {
  enabled: boolean;
  activeState: "inactive" | "active" | "failed";
  pid: number | null;
  restarts: number;
  exitStatus: number;
  exitCode: 1 | 2 | 3;
}

function systemctlOutput(job: FakeSystemdJob): string {
  return `LoadState=loaded
ActiveState=${job.activeState}
SubState=${job.activeState === "active" ? "running" : "dead"}
MainPID=${job.pid ?? 0}
NRestarts=${job.restarts}
ExecMainStatus=${job.exitStatus}
ExecMainCode=${job.exitCode}
`;
}

function makeFakeSystemctl(initial: Partial<FakeSystemdJob> = {}) {
  const calls: string[][] = [];
  const job: FakeSystemdJob = {
    enabled: false,
    activeState: "inactive",
    pid: null,
    restarts: 0,
    exitStatus: 0,
    exitCode: 1,
    ...initial,
  };
  let nextPid = 10_000;
  const runner: CommandRunner = async (file, args) => {
    assert.equal(file, "systemctl");
    calls.push(args);
    const command = args.find((arg) => !arg.startsWith("--"));
    switch (command) {
      case "daemon-reload":
        return successful();
      case "show":
        return successful(systemctlOutput(job));
      case "is-enabled":
        return job.enabled
          ? successful("enabled\n")
          : { code: 1, stdout: "disabled\n", stderr: "" };
      case "enable":
        job.enabled = true;
        return successful();
      case "start":
      case "restart":
        job.activeState = "active";
        job.pid = ++nextPid;
        return successful();
      case "disable":
        job.enabled = false;
        job.activeState = "inactive";
        job.pid = null;
        return successful();
      default:
        throw new Error(`unexpected systemctl command: ${args.join(" ")}`);
    }
  };
  return { calls, job, runner };
}

function makeSystemdSupervisor(
  initial: Partial<FakeSystemdJob> = {},
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-systemd-"));
  const systemctl = makeFakeSystemctl(initial);
  const unitPath = join(dir, ".config", "systemd", "user", "agent-proxy.service");
  const logPath = join(dir, "core", "service", "core.log");
  const transitions: string[] = [];
  const supervisor = new SystemdSupervisor({
    label: TEST_LABEL,
    unitPath,
    binPath: join(dir, "core", "bin", "current", "cli-proxy-api"),
    configPath: join(dir, "core", "config.yaml"),
    logPath,
    isInstalled: () => true,
    probeUrl: () => "http://127.0.0.1:8317/",
    runCommand: systemctl.runner,
    fetchImpl: options.fetchImpl ?? ((() => Promise.resolve(new Response("ok"))) as typeof fetch),
    monitorIntervalMs: 10,
    platform: "linux",
    now: options.now ?? (() => 1_700_000_000_000),
    onChange: (snapshot) => transitions.push(snapshot.state),
  });
  return { supervisor, transitions, systemctl, unitPath, logPath };
}

test("renders and parses a persistent user systemd service", () => {
  const unit = renderSystemdUserUnit({
    label: "com.example.proxy",
    binPath: "/home/test/Agent Proxy/proxy",
    configPath: "/home/test/Agent Proxy/config.yaml",
    logPath: "/home/test/Agent Proxy/core.log",
  });
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /ExecStart="\/home\/test\/Agent Proxy\/proxy" "--config"/);
  assert.match(unit, /^WorkingDirectory=\/home\/test\/Agent Proxy$/m);
  assert.match(unit, /^StandardOutput=append:\/home\/test\/Agent Proxy\/core\.log$/m);
  assert.match(unit, /^StandardError=append:\/home\/test\/Agent Proxy\/core\.log$/m);
  const percentUnit = renderSystemdUserUnit({
    label: "com.example.proxy",
    binPath: "/home/test/100% sure/proxy",
    configPath: "/home/test/100% sure/config.yaml",
    logPath: "/home/test/100% sure/core.log",
  });
  assert.match(percentUnit, /^WorkingDirectory=\/home\/test\/100%% sure$/m);
  assert.match(percentUnit, /^StandardOutput=append:\/home\/test\/100%% sure\/core\.log$/m);
  assert.deepEqual(
    parseSystemctlShow(
      systemctlOutput({
        enabled: true,
        activeState: "active",
        pid: 8123,
        restarts: 3,
        exitStatus: 2,
        exitCode: 1,
      }),
    ),
    {
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      pid: 8123,
      restarts: 3,
      exitStatus: 2,
      exitCode: 1,
    },
  );
});

test("systemd start is idempotent and stop disables the user service", async () => {
  const { supervisor, systemctl, unitPath } = makeSystemdSupervisor();
  const first = await supervisor.start();
  assert.equal(first.state, "running");
  assert.equal(first.loaded, true);
  assert.ok(first.pid);
  assert.match(readFileSync(unitPath, "utf8"), /Restart=always/);

  systemctl.calls.length = 0;
  const second = await supervisor.start();
  assert.equal(second.pid, first.pid);
  assert.equal(
    systemctl.calls.some((args) => args.includes("start")),
    false,
  );
  assert.equal(
    systemctl.calls.some((args) => args.includes("restart")),
    false,
  );

  const stopped = await supervisor.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.loaded, false);
  assert.equal(systemctl.job.enabled, false);
  assert.equal(systemctl.job.activeState, "inactive");
});

test("systemd reports failed jobs and does not stop one when monitoring ends", async () => {
  const failed = makeSystemdSupervisor({
    enabled: true,
    activeState: "failed",
    restarts: 4,
    exitStatus: 2,
  });
  const snapshot = await failed.supervisor.snapshot();
  assert.equal(snapshot.state, "crashed");
  assert.equal(snapshot.crashCount, 4);
  assert.equal(snapshot.lastExit?.code, 2);

  const running = makeSystemdSupervisor();
  await running.supervisor.start();
  running.systemctl.calls.length = 0;
  const controller = new AbortController();
  const done = running.supervisor.monitor(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort();
  await done;
  assert.equal(running.systemctl.job.activeState, "active");
  assert.equal(
    running.systemctl.calls.some((args) => args.includes("disable")),
    false,
  );
});

test("systemd maps numeric CLD_KILLED exit metadata to a signal", async () => {
  const killed = makeSystemdSupervisor({
    enabled: true,
    activeState: "failed",
    restarts: 1,
    exitStatus: 15,
    exitCode: 2,
  });
  const snapshot = await killed.supervisor.snapshot();
  assert.equal(snapshot.lastExit?.code, null);
  assert.equal(snapshot.lastExit?.signal, "15");
});

test("systemd stop overtakes and discards a stale observation", { timeout: 2_000 }, async () => {
  const probeStarted = deferred<void>();
  const probeResponse = deferred<Response>();
  let nowCalls = 0;
  const { supervisor, transitions } = makeSystemdSupervisor(
    {
      enabled: true,
      activeState: "active",
      pid: 10_001,
      restarts: 2,
      exitStatus: 7,
      exitCode: 1,
    },
    {
      fetchImpl: (() => {
        probeStarted.resolve();
        return probeResponse.promise;
      }) as typeof fetch,
      now: () => 1_700_000_000_000 + ++nowCalls,
    },
  );

  const staleObservation = supervisor.snapshot();
  await probeStarted.promise;
  const stopped = await supervisor.stop();
  assert.equal(stopped.state, "stopped");
  probeResponse.resolve(new Response("ok"));

  assert.deepEqual(await staleObservation, stopped);
  assert.deepEqual(transitions, ["stopping", "stopped"]);
  assert.equal(nowCalls, 0);
});
