import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface CommandRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface CommandResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: { readonly code?: string; readonly message: string };
}

export type CommandRunner = (request: CommandRequest) => CommandResult;

export class ProcessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProcessError";
    this.code = code;
  }
}

export const defaultCommandRunner: CommandRunner = (request) => {
  const result = spawnSync(request.file, [...request.args], {
    cwd: request.cwd,
    env: { ...request.env },
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 1024 * 1024,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(error
      ? { error: { ...(error.code ? { code: error.code } : {}), message: error.message } }
      : {}),
  };
};

function executable(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    accessSync(path, constants.X_OK);
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function resolvePathExecutable(
  name: string,
  env: Readonly<NodeJS.ProcessEnv>,
): string | null {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const found = executable(join(directory, name));
    if (found) return found;
  }
  return null;
}

export function resolveProjectExecutable(root: string, name: string): string {
  let directory = resolve(root);
  while (true) {
    const found = executable(join(directory, "node_modules", ".bin", name));
    if (found) return found;
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  throw new ProcessError(
    "project_tool_not_found",
    `project-local ${name} was not found from ${root}; install the declared development dependencies`,
  );
}

export interface SelectedBbCli {
  readonly path: string;
  readonly source: "BB_CLI" | "PATH";
  readonly version: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export function inspectBbCli(
  cwd: string,
  env: Readonly<NodeJS.ProcessEnv>,
  run: CommandRunner = defaultCommandRunner,
): SelectedBbCli {
  let path: string | null;
  let source: SelectedBbCli["source"];
  if (env.BB_CLI !== undefined) {
    if (!isAbsolute(env.BB_CLI)) {
      throw new ProcessError(
        "bb_cli_invalid",
        `BB_CLI must be an absolute executable path, received ${JSON.stringify(env.BB_CLI)}`,
      );
    }
    path = executable(env.BB_CLI);
    source = "BB_CLI";
    if (!path) {
      throw new ProcessError("bb_cli_invalid", `BB_CLI is not an executable file: ${env.BB_CLI}`);
    }
  } else {
    path = resolvePathExecutable("bb", env);
    source = "PATH";
    if (!path) {
      throw new ProcessError(
        "bb_cli_not_found",
        "bb was not found on PATH; set BB_CLI=/absolute/path/to/bb",
      );
    }
  }

  // Strip bb's CLI-redirection protocol rather than pinning it. `path` is
  // spawned directly, so `BB_CLI` buys no extra pinning — and when it names the
  // npm launcher it is fatal. `bb` on PATH from the `bb-app` package resolves to
  // `bb-app/dist/bb.js`, a launcher that runs `env.BB_CLI` when set and its own
  // bundled CLI otherwise, with no depth guard: pointing it at itself made it
  // spawn itself without end. CI reached 289 nested processes and 26 GB before
  // the OOM killer ended `dotfiles:build` with SIGKILL. Locally `BB_CLI` names
  // the desktop app's real CLI, which does guard re-exec, so this only ever
  // failed in CI. With the variable removed the launcher resolves the bundle
  // beside the very binary we selected, and any inherited value is neutralised.
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.BB_CLI;
  delete childEnv.BB_CLI_REEXEC;
  const result = run({ file: path, args: ["--version"], cwd, env: childEnv });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ||
      result.stderr.trim() ||
      result.stdout.trim() ||
      "version check failed";
    throw new ProcessError("bb_cli_invalid", `could not execute ${path} --version: ${detail}`);
  }
  const version = result.stdout.trim().split(/\s+/).at(-1) ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new ProcessError(
      "bb_cli_invalid",
      `${path} (${source}) reported unsupported version ${JSON.stringify(version)}; expected a stable x.y.z release`,
    );
  }
  return { path, source, version, env: childEnv };
}

export function selectBbCli(
  cwd: string,
  env: Readonly<NodeJS.ProcessEnv>,
  expectedVersion: string,
  run: CommandRunner = defaultCommandRunner,
): SelectedBbCli {
  const selected = inspectBbCli(cwd, env, run);
  const { path, source, version } = selected;
  if (version !== expectedVersion) {
    throw new ProcessError(
      "bb_cli_version_mismatch",
      `bb-kit requires bb ${expectedVersion}, but ${path} (${source}) reported ${JSON.stringify(version)}`,
    );
  }
  return selected;
}

export function processFailure(result: CommandResult): string {
  const raw =
    (result.error?.message ?? result.stderr.trim()) ||
    result.stdout.trim() ||
    (result.signal ? `terminated by ${result.signal}` : "command failed");
  const value = redact(raw).split("\n").slice(-20).join("\n");
  return value.length > 4_000 ? value.slice(-4_000) : value;
}

function redact(value: string): string {
  return value
    .replace(/(\b(?:api[-_]?key|password|secret|token)\s*[=:]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]");
}
