import type { BinResult } from "../shared.ts";
import { asDevError, DevError } from "./error.ts";
import { DevManager, type InstanceResult, type ManagerOptions } from "./manager.ts";

export const DEV_USAGE = [
  "usage:",
  "  bb-kit dev-instance start [--name NAME] [--revision SELECTOR] [--repo PATH]",
  "                   [--desktop] [--open] [--timeout SECONDS] [--json]",
  "  bb-kit dev-instance list [--json]",
  "  bb-kit dev-instance status [NAME] [--json]",
  "  bb-kit dev-instance stop [NAME] [--timeout SECONDS] [--json]",
  "  bb-kit dev-instance destroy [NAME] [--timeout SECONDS] [--json]",
  "  bb-kit dev-instance logs [NAME] [dev|desktop|launcher] [--lines COUNT] [--follow]",
  "  bb-kit dev-instance env [NAME] [--json]",
  "  bb-kit dev-instance exec [NAME] -- <bb arguments...>",
  "",
].join("\n");

type CommandOptions = ManagerOptions & {
  manager?: DevManager;
};

export async function runDev(
  argv: readonly string[],
  options: CommandOptions = {},
): Promise<BinResult> {
  const [command, ...args] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    return {
      exitCode: command === undefined ? 2 : 0,
      stdout: command === undefined ? "" : DEV_USAGE,
      stderr: command === undefined ? DEV_USAGE : "",
    };
  }

  let json = false;
  let effectiveName: string | undefined;
  try {
    json = args.includes("--json");
    const manager =
      options.manager ??
      new DevManager({
        ...options,
        progress: options.progress,
      });
    if (command === "start") {
      const parsed = parseStart(args);
      effectiveName = manager.resolveName(parsed.name);
      const result = await manager.start(parsed);
      return success(command, result, parsed.json, `${result.appUrl ?? ""}\n`);
    }
    if (command === "list") {
      const parsed = parseNoPositionals(args, ["--json"]);
      const result = await manager.list();
      const human =
        result.length === 0
          ? "No bb-kit dev instances.\n"
          : `${result.map(formatListRow).join("\n")}\n`;
      return success(command, result, parsed.json, human);
    }
    if (command === "status") {
      const parsed = parseOptionalName(args, ["--json"]);
      effectiveName = manager.resolveName(parsed.name);
      const result = await manager.status(parsed.name);
      return success(command, result, parsed.json, formatStatus(result));
    }
    if (command === "stop" || command === "destroy") {
      const parsed = parseLifecycle(args);
      effectiveName = manager.resolveName(parsed.name);
      const result =
        command === "stop"
          ? await manager.stop(parsed.name, parsed.timeoutMs)
          : await manager.destroy(parsed.name, parsed.timeoutMs);
      const verb = command === "stop" ? "stopped" : "destroyed";
      return success(command, result, parsed.json, `${result.name} ${verb}\n`);
    }
    if (command === "env") {
      const parsed = parseOptionalName(args, ["--json"]);
      effectiveName = manager.resolveName(parsed.name);
      const result = manager.environmentFor(parsed.name);
      const human = [
        `export BB_CLI=${shellQuote(result.BB_CLI)}`,
        `export BB_SERVER_URL=${shellQuote(result.BB_SERVER_URL)}`,
        `export BB_HOST_DAEMON_PORT=${shellQuote(result.BB_HOST_DAEMON_PORT)}`,
        `export BB_KIT_DEV_NAME=${shellQuote(result.BB_KIT_DEV_NAME)}`,
        "",
      ].join("\n");
      return success(command, result, parsed.json, human);
    }
    if (command === "logs") {
      const parsed = parseLogs(args);
      effectiveName = manager.resolveName(parsed.name);
      if (parsed.follow) {
        const exitCode = await manager.followLogs(parsed.name, parsed.target, parsed.lines);
        return { exitCode, stdout: "", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: manager.finiteLogs(parsed.name, parsed.target, parsed.lines),
        stderr: "",
      };
    }
    if (command === "exec") {
      const parsed = parseExec(args);
      effectiveName = manager.resolveName(parsed.name);
      const exitCode = await manager.exec(parsed.name, parsed.args);
      return { exitCode, stdout: "", stderr: "" };
    }
    throw usageError(`Unknown dev command "${command}".`);
  } catch (error) {
    const failure = asDevError(error);
    const exitCode = isUsageCode(failure.code) ? 2 : 1;
    if (json) {
      return {
        exitCode,
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          ok: false,
          command,
          ...(effectiveName === undefined ? {} : { name: effectiveName }),
          error: {
            code: failure.code,
            message: failure.message,
            action: failure.action,
            ...(failure.details === undefined ? {} : { details: failure.details }),
          },
        })}\n`,
        stderr: "",
      };
    }
    return {
      exitCode,
      stdout: "",
      stderr: `${effectiveName === undefined ? "" : `Instance: ${effectiveName}\n`}[${failure.code}] ${failure.message}\nNext action: ${failure.action}\n`,
    };
  }
}

function parseStart(args: readonly string[]): {
  name?: string;
  revision?: string;
  repository?: string;
  desktop?: boolean;
  open?: boolean;
  timeoutMs?: number;
  json: boolean;
} {
  const parsed: {
    name?: string;
    revision?: string;
    repository?: string;
    desktop?: boolean;
    open?: boolean;
    timeoutMs?: number;
    json: boolean;
  } = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--desktop") {
      parsed.desktop = true;
    } else if (arg === "--open") {
      parsed.open = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--name") {
      parsed.name = requiredOption(args, ++index, arg);
    } else if (arg === "--revision") {
      parsed.revision = requiredOption(args, ++index, arg);
    } else if (arg === "--repo") {
      parsed.repository = requiredOption(args, ++index, arg);
    } else if (arg === "--timeout") {
      parsed.timeoutMs = secondsOption(requiredOption(args, ++index, arg), arg);
    } else {
      throw usageError(`Unknown start argument "${arg ?? ""}".`);
    }
  }
  return parsed;
}

function parseLifecycle(args: readonly string[]): {
  name?: string;
  timeoutMs: number;
  json: boolean;
} {
  let name: string | undefined;
  let timeoutMs = 30_000;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--timeout") {
      timeoutMs = secondsOption(requiredOption(args, ++index, arg), arg);
    } else if (arg?.startsWith("--")) {
      throw usageError(`Unknown lifecycle option "${arg}".`);
    } else if (name === undefined && arg !== undefined) {
      name = arg;
    } else {
      throw usageError("This command accepts at most one instance name.");
    }
  }
  return { name, timeoutMs, json };
}

function parseOptionalName(
  args: readonly string[],
  allowed: readonly string[],
): { name?: string; json: boolean } {
  let name: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === "--json" && allowed.includes(arg)) {
      json = true;
    } else if (arg.startsWith("--")) {
      throw usageError(`Unknown option "${arg}".`);
    } else if (name === undefined) {
      name = arg;
    } else {
      throw usageError("This command accepts at most one instance name.");
    }
  }
  return { name, json };
}

function parseNoPositionals(
  args: readonly string[],
  allowed: readonly string[],
): { json: boolean } {
  const parsed = parseOptionalName(args, allowed);
  if (parsed.name !== undefined) {
    throw usageError("This command accepts no instance name.");
  }
  return { json: parsed.json };
}

function parseLogs(args: readonly string[]): {
  name?: string;
  target: "dev" | "desktop" | "launcher";
  lines: number;
  follow: boolean;
} {
  let name: string | undefined;
  let target: "dev" | "desktop" | "launcher" = "dev";
  let targetSet = false;
  let lines = 100;
  let follow = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--follow") {
      follow = true;
    } else if (arg === "--lines") {
      lines = countOption(requiredOption(args, ++index, arg), arg);
    } else if (arg?.startsWith("--")) {
      throw usageError(`Unknown logs option "${arg}".`);
    } else if (isLogTarget(arg) && !targetSet) {
      target = arg;
      targetSet = true;
    } else if (name === undefined && arg !== undefined) {
      name = arg;
    } else {
      throw usageError(`Unexpected logs argument "${arg ?? ""}".`);
    }
  }
  return { name, target, lines, follow };
}

function parseExec(args: readonly string[]): { name?: string; args: readonly string[] } {
  const separator = args.indexOf("--");
  if (separator < 0) {
    throw usageError("dev exec requires -- before the bb arguments.");
  }
  const prefix = args.slice(0, separator);
  if (prefix.length > 1) {
    throw usageError("dev exec accepts at most one instance name before --.");
  }
  const commandArgs = args.slice(separator + 1);
  if (commandArgs.length === 0) {
    throw usageError("dev exec requires at least one bb argument after --.");
  }
  return { name: prefix[0], args: commandArgs };
}

function success(command: string, result: unknown, json: boolean, human: string): BinResult {
  return {
    exitCode: 0,
    stdout: json ? `${JSON.stringify({ schemaVersion: 1, ok: true, command, result })}\n` : human,
    stderr: "",
  };
}

function formatListRow(result: InstanceResult): string {
  return [result.name, result.phase, result.revision ?? "unresolved", result.appUrl ?? "-"].join(
    "\t",
  );
}

function formatStatus(result: InstanceResult): string {
  return [
    `Name: ${result.name}`,
    `Phase: ${result.phase}`,
    `Revision: ${result.revision ?? "unresolved"}`,
    `Commit: ${result.commit ?? "unresolved"}`,
    `Runtime: ${result.desiredRuntime ?? "none"}`,
    `Checkout: ${result.checkoutPath ?? "unavailable"}`,
    `Branch: ${result.branch ?? "unavailable"}`,
    `Node: ${result.node ?? "unavailable"}`,
    `Codex: ${result.codex ?? "unavailable"}`,
    `Data dir: ${result.dataDir ?? "unavailable"}`,
    `App: ${result.appUrl ?? "unavailable"}`,
    `Server: ${result.serverUrl ?? "unavailable"}`,
    `Host daemon: ${result.hostDaemonUrl ?? "unavailable"}`,
    `Desktop user data: ${result.desktopUserDataDir ?? "unavailable"}`,
    `Dev session: ${result.devSession ?? "unknown"}`,
    `Desktop session: ${result.desktopSession ?? "unknown"}`,
    `Dev log: ${result.devLog ?? "unavailable"}`,
    `Desktop log: ${result.desktopLog ?? "unavailable"}`,
    `Launcher log: ${result.launcherLog ?? "unavailable"}`,
    `Running: ${result.running ? "yes" : "no"}`,
    "",
  ].join("\n");
}

function requiredOption(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw usageError(`${option} requires a value.`);
  }
  return value;
}

function secondsOption(value: string, option: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw usageError(`${option} requires a positive number of seconds.`);
  }
  return Math.ceil(seconds * 1_000);
}

function countOption(value: string, option: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw usageError(`${option} requires a positive integer.`);
  }
  return count;
}

function isLogTarget(value: string | undefined): value is "dev" | "desktop" | "launcher" {
  return value === "dev" || value === "desktop" || value === "launcher";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function usageError(message: string): DevError {
  return new DevError("invalid_arguments", message, "Run bb-kit dev-instance --help.");
}

function isUsageCode(code: string): boolean {
  return code === "invalid_arguments" || code === "invalid_name" || code === "invalid_revision";
}
