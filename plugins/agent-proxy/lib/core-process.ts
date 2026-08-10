import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname } from "node:path";
import { ensureDir, readTextOr, writeAtomic } from "./fsx.ts";

export type CoreState =
  | "not-installed"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed";

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  at: number;
}
export interface SupervisorSnapshot {
  state: CoreState;
  pid: number | null;
  loaded: boolean;
  crashCount: number;
  lastExit: ExitInfo | null;
}

export type ServiceManager = "launchd" | "systemd";

export interface CoreSupervisor {
  readonly manager: ServiceManager;
  readonly label: string;
  readonly definitionPath: string;
  logs(): string[];
  snapshot(): Promise<SupervisorSnapshot>;
  start(): Promise<SupervisorSnapshot>;
  stop(): Promise<SupervisorSnapshot>;
  restart(): Promise<SupervisorSnapshot>;
  monitor(signal: AbortSignal): Promise<void>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export interface LaunchdSupervisorOptions {
  label: string;
  uid: number;
  plistPath: string;
  binPath: string;
  configPath: string;
  logPath: string;
  isInstalled: () => boolean;
  /** Base URL to probe for readiness; any HTTP response counts as listening. */
  probeUrl: () => string;
  onChange?: (snapshot: SupervisorSnapshot) => void;
  onError?: (error: unknown) => void;
  runCommand?: CommandRunner;
  fetchImpl?: typeof fetch;
  monitorIntervalMs?: number;
  probeTimeoutMs?: number;
  logLimit?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
}

interface LaunchdJobInfo {
  loaded: boolean;
  state: string | null;
  pid: number | null;
  runs: number;
  lastExitCode: number | null;
  lastSignal: string | null;
}

const LAUNCHCTL = "/bin/launchctl";
const MAX_LOG_BYTES = 256 * 1024;

function defaultCommandRunner(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      const rawCode = (error as NodeJS.ErrnoException | null)?.code;
      resolve({
        code: typeof rawCode === "number" ? rawCode : error ? 1 : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? error?.message ?? ""),
      });
    });
  });
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgentPlist(options: {
  label: string;
  binPath: string;
  configPath: string;
  logPath: string;
}): string {
  const label = xmlEscape(options.label);
  const binPath = xmlEscape(options.binPath);
  const configPath = xmlEscape(options.configPath);
  const logPath = xmlEscape(options.logPath);
  const workingDirectory = xmlEscape(dirname(options.configPath));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binPath}</string>
    <string>--config</string>
    <string>${configPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workingDirectory}</string>
  <key>KeepAlive</key>
  <true/>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

export function parseLaunchctlPrint(output: string): Omit<LaunchdJobInfo, "loaded"> {
  const value = (name: string) =>
    output.match(new RegExp(`^\\s*${name} = (.+)$`, "m"))?.[1]?.trim() ?? null;
  const integer = (name: string) => {
    const raw = value(name);
    if (raw === null || !/^-?\d+$/.test(raw)) return null;
    return Number.parseInt(raw, 10);
  };
  return {
    state: value("state"),
    pid: integer("pid"),
    runs: integer("runs") ?? 0,
    lastExitCode: integer("last exit code"),
    lastSignal: value("last terminating signal"),
  };
}

function isMissingService(result: CommandResult): boolean {
  return (
    result.code !== 0 &&
    /could not find service|service cannot be found|no such process|bad request/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  );
}

function sameSnapshot(a: SupervisorSnapshot, b: SupervisorSnapshot): boolean {
  return (
    a.state === b.state &&
    a.pid === b.pid &&
    a.loaded === b.loaded &&
    a.crashCount === b.crashCount &&
    a.lastExit?.code === b.lastExit?.code &&
    a.lastExit?.signal === b.lastExit?.signal &&
    a.lastExit?.at === b.lastExit?.at
  );
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(finish, ms);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      // oxlint-disable-next-line promise/no-multiple-resolved
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function tailLines(path: string, limit: number): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    return lines.slice(-limit);
  } finally {
    closeSync(fd);
  }
}
/**
 * Manages the CLIProxyAPI core as a persistent per-user launchd job. The bb
 * plugin owns the definition and controls it, but does not own the process.
 * Aborting the monitor therefore never stops the core.
 */
export class LaunchdSupervisor implements CoreSupervisor {
  readonly manager = "launchd" as const;
  private readonly options: Required<
    Pick<
      LaunchdSupervisorOptions,
      "monitorIntervalMs" | "probeTimeoutMs" | "logLimit" | "platform" | "now"
    >
  > &
    LaunchdSupervisorOptions;

  private snapshotValue: SupervisorSnapshot = {
    state: "stopped",
    pid: null,
    loaded: false,
    crashCount: 0,
    lastExit: null,
  };
  private lastExitSignature: string | null = null;

  constructor(options: LaunchdSupervisorOptions) {
    this.options = {
      monitorIntervalMs: 2_000,
      probeTimeoutMs: 500,
      logLimit: 200,
      platform: process.platform,
      now: Date.now,
      ...options,
    };
  }

  get label(): string {
    return this.options.label;
  }

  get definitionPath(): string {
    return this.options.plistPath;
  }

  get serviceTarget(): string {
    return `gui/${this.options.uid}/${this.options.label}`;
  }

  get domainTarget(): string {
    return `gui/${this.options.uid}`;
  }

  definition(): string {
    return renderLaunchAgentPlist(this.options);
  }

  logs(): string[] {
    return tailLines(this.options.logPath, this.options.logLimit);
  }

  async snapshot(): Promise<SupervisorSnapshot> {
    this.assertSupported();
    if (!this.options.isInstalled()) {
      return this.setSnapshot({
        state: "not-installed",
        pid: null,
        loaded: false,
        crashCount: 0,
        lastExit: null,
      });
    }
    const job = await this.inspectJob();
    return this.setSnapshot(await this.snapshotFromJob(job));
  }

  async start(): Promise<SupervisorSnapshot> {
    this.assertSupported();
    if (!this.options.isInstalled()) return this.snapshot();

    const definitionChanged = this.ensureDefinition();
    await this.runChecked(["enable", this.serviceTarget]);
    let job = await this.inspectJob();
    if (job.loaded && definitionChanged) {
      await this.bootout();
      job = { loaded: false, state: null, pid: null, runs: 0, lastExitCode: null, lastSignal: null };
    }
    if (!job.loaded) {
      await this.runChecked(["bootstrap", this.domainTarget, this.options.plistPath]);
    } else if (job.pid === null || job.state !== "running") {
      await this.runChecked(["kickstart", this.serviceTarget]);
    }
    return this.snapshot();
  }

  async stop(): Promise<SupervisorSnapshot> {
    this.assertSupported();
    this.setSnapshot({ ...this.snapshotValue, state: "stopping" });
    await this.bootout();
    await this.runChecked(["disable", this.serviceTarget]);
    return this.setSnapshot({
      ...this.snapshotValue,
      state: this.options.isInstalled() ? "stopped" : "not-installed",
      pid: null,
      loaded: false,
    });
  }

  async restart(): Promise<SupervisorSnapshot> {
    this.assertSupported();
    if (!this.options.isInstalled()) return this.snapshot();

    const definitionChanged = this.ensureDefinition();
    await this.runChecked(["enable", this.serviceTarget]);
    const job = await this.inspectJob();
    if (!job.loaded) {
      await this.runChecked(["bootstrap", this.domainTarget, this.options.plistPath]);
    } else if (definitionChanged) {
      await this.bootout();
      await this.runChecked(["bootstrap", this.domainTarget, this.options.plistPath]);
    } else {
      await this.runChecked(["kickstart", "-k", this.serviceTarget]);
    }
    return this.snapshot();
  }

  async monitor(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.snapshot();
      } catch (error) {
        this.options.onError?.(error);
      }
      await wait(this.options.monitorIntervalMs, signal);
    }
  }

  private assertSupported(): void {
    if (this.options.platform !== "darwin") {
      throw new Error("agent-proxy persistent service requires macOS launchd");
    }
  }

  private ensureDefinition(): boolean {
    const content = this.definition();
    if (readTextOr(this.options.plistPath) === content) return false;
    ensureDir(dirname(this.options.plistPath));
    ensureDir(dirname(this.options.logPath));
    writeAtomic(this.options.plistPath, content, 0o644);
    return true;
  }

  private async inspectJob(): Promise<LaunchdJobInfo> {
    const result = await this.run(["print", this.serviceTarget]);
    if (isMissingService(result)) {
      return {
        loaded: false,
        state: null,
        pid: null,
        runs: 0,
        lastExitCode: null,
        lastSignal: null,
      };
    }
    if (result.code !== 0) {
      throw new Error(this.commandError(["print", this.serviceTarget], result));
    }
    return { loaded: true, ...parseLaunchctlPrint(result.stdout) };
  }

  private async snapshotFromJob(job: LaunchdJobInfo): Promise<SupervisorSnapshot> {
    if (!job.loaded) {
      return {
        state: "stopped",
        pid: null,
        loaded: false,
        crashCount: this.snapshotValue.crashCount,
        lastExit: this.snapshotValue.lastExit,
      };
    }

    const lastExit = this.exitInfo(job);
    let state: CoreState;
    if (job.state === "running" && job.pid !== null) {
      state = (await this.probe()) ? "running" : "starting";
    } else if (job.lastExitCode !== null && job.lastExitCode !== 0) {
      state = "crashed";
    } else {
      state = "starting";
    }
    return {
      state,
      pid: job.pid,
      loaded: true,
      crashCount: Math.max(0, job.runs - 1),
      lastExit,
    };
  }

  private exitInfo(job: LaunchdJobInfo): ExitInfo | null {
    if (job.lastExitCode === null && job.lastSignal === null) return null;
    const signature = `${job.runs}:${job.lastExitCode ?? "null"}:${job.lastSignal ?? "null"}`;
    if (signature !== this.lastExitSignature) {
      this.lastExitSignature = signature;
      return {
        code: job.lastExitCode,
        signal: job.lastSignal,
        at: this.options.now(),
      };
    }
    return this.snapshotValue.lastExit;
  }

  private async probe(): Promise<boolean> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      await fetchImpl(this.options.probeUrl(), {
        signal: AbortSignal.timeout(this.options.probeTimeoutMs),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async bootout(): Promise<void> {
    const result = await this.run(["bootout", this.serviceTarget]);
    if (result.code !== 0 && !isMissingService(result)) {
      throw new Error(this.commandError(["bootout", this.serviceTarget], result));
    }
  }

  private async runChecked(args: string[]): Promise<CommandResult> {
    const result = await this.run(args);
    if (result.code !== 0) throw new Error(this.commandError(args, result));
    return result;
  }

  private run(args: string[]): Promise<CommandResult> {
    return (this.options.runCommand ?? defaultCommandRunner)(LAUNCHCTL, args);
  }

  private commandError(args: string[], result: CommandResult): string {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    return `launchctl ${args.join(" ")} failed: ${detail}`;
  }

  private setSnapshot(snapshot: SupervisorSnapshot): SupervisorSnapshot {
    if (!sameSnapshot(snapshot, this.snapshotValue)) {
      this.snapshotValue = snapshot;
      this.options.onChange?.(snapshot);
    }
    return this.snapshotValue;
  }
}

export interface SystemdSupervisorOptions {
  label: string;
  unitPath: string;
  binPath: string;
  configPath: string;
  logPath: string;
  isInstalled: () => boolean;
  probeUrl: () => string;
  onChange?: (snapshot: SupervisorSnapshot) => void;
  onError?: (error: unknown) => void;
  runCommand?: CommandRunner;
  fetchImpl?: typeof fetch;
  monitorIntervalMs?: number;
  probeTimeoutMs?: number;
  logLimit?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
  systemctlPath?: string;
}

interface SystemdJobInfo {
  enabled: boolean;
  activeState: string | null;
  subState: string | null;
  pid: number | null;
  restarts: number;
  exitStatus: number | null;
  exitCode: number | null;
}

function systemdQuote(value: string): string {
  if (/\r|\n|\0/.test(value)) throw new Error("systemd service values cannot contain control characters");
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")}"`;
}

export function renderSystemdUserUnit(options: {
  label: string;
  binPath: string;
  configPath: string;
  logPath: string;
}): string {
  const command = [options.binPath, "--config", options.configPath].map(systemdQuote).join(" ");
  const logTarget = systemdQuote(`append:${options.logPath}`);
  return `[Unit]
Description=Agent Proxy (${options.label})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command}
WorkingDirectory=${systemdQuote(dirname(options.configPath))}
UMask=0077
Restart=always
RestartSec=2
TimeoutStopSec=15
StandardOutput=${logTarget}
StandardError=${logTarget}

[Install]
WantedBy=default.target
`;
}

export function parseSystemctlShow(output: string): {
  loadState: string | null;
  activeState: string | null;
  subState: string | null;
  pid: number | null;
  restarts: number;
  exitStatus: number | null;
  exitCode: number | null;
} {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const integer = (name: string, zeroIsNull = false): number | null => {
    const raw = values.get(name);
    if (raw === undefined || !/^-?\d+$/.test(raw)) return null;
    const parsed = Number.parseInt(raw, 10);
    return zeroIsNull && parsed === 0 ? null : parsed;
  };
  return {
    loadState: values.get("LoadState") ?? null,
    activeState: values.get("ActiveState") ?? null,
    subState: values.get("SubState") ?? null,
    pid: integer("MainPID", true),
    restarts: integer("NRestarts") ?? 0,
    exitStatus: integer("ExecMainStatus"),
    exitCode: integer("ExecMainCode"),
  };
}

function isMissingSystemdUnit(result: CommandResult): boolean {
  return (
    result.code !== 0 &&
    /unit .* (?:could not be found|not found|does not exist|not loaded)/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  );
}

/** Manages a persistent per-user systemd service. Aborting the monitor leaves
    the operating-system service running. */
export class SystemdSupervisor implements CoreSupervisor {
  readonly manager = "systemd" as const;
  private readonly options: Required<
    Pick<
      SystemdSupervisorOptions,
      | "monitorIntervalMs"
      | "probeTimeoutMs"
      | "logLimit"
      | "platform"
      | "now"
      | "systemctlPath"
    >
  > &
    SystemdSupervisorOptions;

  private snapshotValue: SupervisorSnapshot = {
    state: "stopped",
    pid: null,
    loaded: false,
    crashCount: 0,
    lastExit: null,
  };
  private lastExitSignature: string | null = null;

  constructor(options: SystemdSupervisorOptions) {
    this.options = {
      monitorIntervalMs: 2_000,
      probeTimeoutMs: 500,
      logLimit: 200,
      platform: process.platform,
      now: Date.now,
      systemctlPath: "systemctl",
      ...options,
    };
  }

  get label(): string {
    return this.options.label;
  }

  get definitionPath(): string {
    return this.options.unitPath;
  }

  get unitTarget(): string {
    return `${this.options.label}.service`;
  }

  definition(): string {
    return renderSystemdUserUnit(this.options);
  }

  logs(): string[] {
    return tailLines(this.options.logPath, this.options.logLimit);
  }

  async snapshot(): Promise<SupervisorSnapshot> {
    this.assertSupported();
    if (!this.options.isInstalled()) {
      return this.setSnapshot({
        state: "not-installed",
        pid: null,
        loaded: false,
        crashCount: 0,
        lastExit: null,
      });
    }
    const job = await this.inspectJob();
    return this.setSnapshot(await this.snapshotFromJob(job));
  }

  async start(): Promise<SupervisorSnapshot> {
    this.assertSupported();
    if (!this.options.isInstalled()) return this.snapshot();

    const definitionChanged = this.ensureDefinition();
    await this.runChecked(["--user", "daemon-reload"]);
    const job = await this.inspectJob();
    await this.runChecked(["--user", "enable", this.unitTarget]);
    if (job.activeState === "active") {
      if (definitionChanged) {
        await this.runChecked(["--user", "restart", this.unitTarget]);
      }
    } else {
      await this.runChecked(["--user", "start", this.unitTarget]);
    }
    return this.snapshot();
  }

  async stop(): Promise<SupervisorSnapshot> {
    this.assertSupported();
    this.setSnapshot({ ...this.snapshotValue, state: "stopping" });
    const result = await this.run(["--user", "disable", "--now", this.unitTarget]);
    if (result.code !== 0 && !isMissingSystemdUnit(result)) {
      throw new Error(this.commandError(["--user", "disable", "--now", this.unitTarget], result));
    }
    return this.setSnapshot({
      ...this.snapshotValue,
      state: this.options.isInstalled() ? "stopped" : "not-installed",
      pid: null,
      loaded: false,
    });
  }

  async restart(): Promise<SupervisorSnapshot> {
    this.assertSupported();
    if (!this.options.isInstalled()) return this.snapshot();

    this.ensureDefinition();
    await this.runChecked(["--user", "daemon-reload"]);
    const job = await this.inspectJob();
    await this.runChecked(["--user", "enable", this.unitTarget]);
    await this.runChecked([
      "--user",
      job.activeState === "active" ? "restart" : "start",
      this.unitTarget,
    ]);
    return this.snapshot();
  }

  async monitor(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.snapshot();
      } catch (error) {
        this.options.onError?.(error);
      }
      await wait(this.options.monitorIntervalMs, signal);
    }
  }

  private assertSupported(): void {
    if (this.options.platform !== "linux") {
      throw new Error("agent-proxy systemd service requires Linux");
    }
  }

  private ensureDefinition(): boolean {
    const content = this.definition();
    if (readTextOr(this.options.unitPath) === content) return false;
    ensureDir(dirname(this.options.unitPath));
    ensureDir(dirname(this.options.logPath));
    writeAtomic(this.options.unitPath, content, 0o644);
    return true;
  }

  private async inspectJob(): Promise<SystemdJobInfo> {
    const properties = [
      "LoadState",
      "ActiveState",
      "SubState",
      "MainPID",
      "NRestarts",
      "ExecMainStatus",
      "ExecMainCode",
    ].join(",");
    const result = await this.run([
      "--user",
      "show",
      this.unitTarget,
      `--property=${properties}`,
      "--no-pager",
    ]);
    if (isMissingSystemdUnit(result)) return this.emptyJob();
    if (result.code !== 0) {
      throw new Error(
        this.commandError(
          ["--user", "show", this.unitTarget, `--property=${properties}`, "--no-pager"],
          result,
        ),
      );
    }
    const parsed = parseSystemctlShow(result.stdout);
    if (parsed.loadState === "not-found") return this.emptyJob();
    const enabledResult = await this.run(["--user", "is-enabled", this.unitTarget]);
    const enabled = enabledResult.code === 0 && /^(?:enabled|enabled-runtime|linked)/i.test(enabledResult.stdout.trim());
    return {
      enabled,
      activeState: parsed.activeState,
      subState: parsed.subState,
      pid: parsed.pid,
      restarts: parsed.restarts,
      exitStatus: parsed.exitStatus,
      exitCode: parsed.exitCode,
    };
  }

  private emptyJob(): SystemdJobInfo {
    return {
      enabled: false,
      activeState: null,
      subState: null,
      pid: null,
      restarts: 0,
      exitStatus: null,
      exitCode: null,
    };
  }

  private async snapshotFromJob(job: SystemdJobInfo): Promise<SupervisorSnapshot> {
    const loaded =
      job.enabled ||
      job.activeState === "active" ||
      job.activeState === "activating" ||
      job.activeState === "deactivating";
    let state: CoreState;
    if (job.activeState === "active") {
      state = (await this.probe()) ? "running" : "starting";
    } else if (job.activeState === "activating") {
      state = "starting";
    } else if (job.activeState === "deactivating") {
      state = "stopping";
    } else if (job.activeState === "failed") {
      state = "crashed";
    } else {
      state = "stopped";
    }
    return {
      state,
      pid: job.pid,
      loaded,
      crashCount: Math.max(0, job.restarts),
      lastExit: this.exitInfo(job),
    };
  }

  private exitInfo(job: SystemdJobInfo): ExitInfo | null {
    const exited = job.exitCode === 1;
    const killed = job.exitCode === 2 || job.exitCode === 3;
    if ((job.exitStatus === null || job.exitStatus === 0) && !killed) {
      return null;
    }
    const signature = `${job.restarts}:${job.exitCode ?? "null"}:${job.exitStatus ?? "null"}`;
    if (signature !== this.lastExitSignature) {
      this.lastExitSignature = signature;
      return {
        code: exited ? job.exitStatus : null,
        signal: killed ? String(job.exitStatus ?? "unknown") : null,
        at: this.options.now(),
      };
    }
    return this.snapshotValue.lastExit;
  }

  private async probe(): Promise<boolean> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      await fetchImpl(this.options.probeUrl(), {
        signal: AbortSignal.timeout(this.options.probeTimeoutMs),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async runChecked(args: string[]): Promise<CommandResult> {
    const result = await this.run(args);
    if (result.code !== 0) throw new Error(this.commandError(args, result));
    return result;
  }

  private run(args: string[]): Promise<CommandResult> {
    return (this.options.runCommand ?? defaultCommandRunner)(this.options.systemctlPath, args);
  }

  private commandError(args: string[], result: CommandResult): string {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    return `systemctl ${args.join(" ")} failed: ${detail}`;
  }

  private setSnapshot(snapshot: SupervisorSnapshot): SupervisorSnapshot {
    if (!sameSnapshot(snapshot, this.snapshotValue)) {
      this.snapshotValue = snapshot;
      this.options.onChange?.(snapshot);
    }
    return this.snapshotValue;
  }
}
