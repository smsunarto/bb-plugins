import { formatDiagnostic } from "./check.js";
import { ProcessError, type CommandRunner } from "./process.js";
import {
  checkWorkspaceCompatibility,
  findWorkspaceRoot,
  formatCompatibilityInspection,
  inspectCompatibility,
  upgradeCompatibility,
} from "./compatibility-workspace.js";

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  run?: CommandRunner;
}

class CliUsageError extends Error {
  readonly code = "usage";
}

interface ParsedArguments {
  positionals: string[];
  values: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}

const USAGE = `Usage:
  bb-kit check --workspace [--json]
  bb-kit compatibility inspect [--json]
  bb-kit compatibility check [--json]
  bb-kit compatibility upgrade [--json]`;

const COMMAND_USAGE: Readonly<Record<string, string>> = {
  check: "Usage: bb-kit check --workspace [--json]",
  "compatibility inspect": "Usage: bb-kit compatibility inspect [--json]",
  "compatibility check": "Usage: bb-kit compatibility check [--json]",
  "compatibility upgrade": "Usage: bb-kit compatibility upgrade [--json]",
};

function parseArguments(
  args: readonly string[],
  valueNames: readonly string[] = [],
  flagNames: readonly string[] = [],
): ParsedArguments {
  const allowedValues = new Set(valueNames);
  const allowedFlags = new Set(["--json", ...flagNames]);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (allowedFlags.has(argument)) {
      if (flags.has(argument)) throw new CliUsageError(`duplicate option ${argument}`);
      flags.add(argument);
      continue;
    }
    if (allowedValues.has(argument)) {
      if (values.has(argument)) throw new CliUsageError(`duplicate option ${argument}`);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliUsageError(`${argument} requires a value`);
      }
      values.set(argument, value);
      index += 1;
      continue;
    }
    throw new CliUsageError(`unknown option ${argument}`);
  }
  return { positionals, values, flags };
}

function expectPositionals(parsed: ParsedArguments, minimum: number, maximum = minimum): void {
  if (parsed.positionals.length < minimum || parsed.positionals.length > maximum) {
    throw new CliUsageError(
      `expected ${minimum === maximum ? minimum : `${minimum}-${maximum}`} positional arguments`,
    );
  }
}

function printableError(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof CliUsageError) return { code: error.code, message: error.message };
  if (error instanceof ProcessError) return { code: error.code, message: error.message };
  return {
    code: "bb_kit_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const io = options.io ?? {
    stdout: (value: string) => console.log(value),
    stderr: (value: string) => console.error(value),
  };
  const json = argv.includes("--json");
  try {
    const [command, ...args] = argv;
    if (!command || command === "help" || command === "--help" || command === "-h") {
      io.stdout(USAGE);
      return command ? 0 : 2;
    }
    if (args.includes("--help") || args.includes("-h")) {
      const subject = args.find((argument) => !argument.startsWith("-"));
      io.stdout(COMMAND_USAGE[subject ? `${command} ${subject}` : command] ?? USAGE);
      return 0;
    }
    if (command === "check") {
      const parsed = parseArguments(args, [], ["--workspace"]);
      expectPositionals(parsed, 0);
      if (!parsed.flags.has("--workspace")) {
        throw new CliUsageError("check requires --workspace");
      }
      const diagnostics = checkWorkspaceCompatibility(findWorkspaceRoot(cwd));
      if (json) io.stdout(JSON.stringify(diagnostics, null, 2));
      else if (diagnostics.length === 0) io.stdout("✓ bb-kit check passed");
      else io.stderr(diagnostics.map(formatDiagnostic).join("\n\n"));
      return diagnostics.some((value) => value.severity === "error") ? 1 : 0;
    }
    if (command === "compatibility") {
      const [subject, ...subjectArgs] = args;
      if (subject !== "inspect" && subject !== "check" && subject !== "upgrade") {
        throw new CliUsageError("compatibility requires inspect, check, or upgrade");
      }
      const parsed = parseArguments(subjectArgs);
      expectPositionals(parsed, 0);
      if (subject === "check") {
        const diagnostics = checkWorkspaceCompatibility(findWorkspaceRoot(cwd));
        if (json) io.stdout(JSON.stringify(diagnostics, null, 2));
        else if (diagnostics.length === 0) io.stdout("✓ bb-kit compatibility check passed");
        else io.stderr(diagnostics.map(formatDiagnostic).join("\n\n"));
        return diagnostics.some((value) => value.severity === "error") ? 1 : 0;
      }
      const commandOptions = {
        env,
        ...(options.run ? { run: options.run } : {}),
      };
      const result =
        subject === "inspect"
          ? inspectCompatibility(cwd, commandOptions)
          : upgradeCompatibility(cwd, commandOptions);
      io.stdout(json ? JSON.stringify(result, null, 2) : formatCompatibilityInspection(result));
      return 0;
    }
    throw new CliUsageError(`unknown command "${command}"`);
  } catch (error) {
    const formatted = printableError(error);
    if (json) io.stdout(JSON.stringify({ ok: false, error: formatted }, null, 2));
    else {
      io.stderr(`${formatted.code}: ${formatted.message}`);
      if (formatted.code === "usage") io.stderr(USAGE);
    }
    return formatted.code === "usage" ? 2 : 1;
  }
}
