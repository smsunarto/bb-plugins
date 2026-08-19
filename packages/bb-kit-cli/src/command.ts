import { resolve } from "node:path";
import { buildProject, formatBuild } from "./build.js";
import {
  addFixture,
  addMigration,
  addModule,
  addOperation,
  addPanel,
  initializeProject,
  type PluginKind,
} from "./generate.js";
import { checkProject, formatDiagnostic } from "./check.js";
import { formatInfo, inspectProject } from "./info.js";
import { invokeOperation, InvocationError, operationInvokeCommand } from "./invoke.js";
import { doctorProject, formatDoctor } from "./doctor.js";
import { discoverProject, findProjectRoot } from "./project.js";
import { FixtureError, formatFixtureRun, runFixtures } from "./fixtures.js";
import { formatVerification, verifyProject, type CommandRunner } from "./verify.js";
import { ProcessError } from "./process.js";
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
  fetch?: typeof fetch;
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
  bb-kit init [directory] [--kind backend|fullstack|theme] [--skip-install] [--skip-types]
  bb-kit add module <name>
  bb-kit add operation <module.name> --kind query|command [--risk safe|mutating|destructive]
  bb-kit add fixture <module.name> <name>
  bb-kit add migration <module> <name>
  bb-kit add panel <module> --location nav|thread
  bb-kit operations [--json]
  bb-kit describe <module.name> [--json]
  bb-kit invoke <module.name> [--input <json|@file>] [--confirm] [--server <url>] [--json]
  bb-kit fixtures run [module] [--confirm] [--server <url>] [--json]
  bb-kit info [--json]
  bb-kit check [--workspace] [--json]
  bb-kit compatibility inspect [--json]
  bb-kit compatibility check [--json]
  bb-kit compatibility upgrade [--json]
  bb-kit build [--json]
  bb-kit verify [--json]
  bb-kit doctor [--json]`;

const COMMAND_USAGE: Readonly<Record<string, string>> = {
  init: "Usage: bb-kit init [directory] [--kind backend|fullstack|theme] [--skip-install] [--skip-types] [--json]",
  "add module": "Usage: bb-kit add module <name> [--json]",
  "add operation":
    "Usage: bb-kit add operation <module.name> --kind query|command [--risk safe|mutating|destructive] [--json]",
  "add fixture": "Usage: bb-kit add fixture <module.name> <name> [--json]",
  "add migration": "Usage: bb-kit add migration <module> <name> [--json]",
  "add panel": "Usage: bb-kit add panel <module> --location nav|thread [--json]",
  operations: "Usage: bb-kit operations [--json]",
  describe: "Usage: bb-kit describe <module.name> [--json]",
  invoke:
    "Usage: bb-kit invoke <module.name> [--input <json|@file>] [--confirm] [--server <url>] [--json]",
  "fixtures run": "Usage: bb-kit fixtures run [module] [--confirm] [--server <url>] [--json]",
  info: "Usage: bb-kit info [--json]",
  check: "Usage: bb-kit check [--workspace] [--json]",
  "compatibility inspect": "Usage: bb-kit compatibility inspect [--json]",
  "compatibility check": "Usage: bb-kit compatibility check [--json]",
  "compatibility upgrade": "Usage: bb-kit compatibility upgrade [--json]",
  build: "Usage: bb-kit build [--json]",
  verify: "Usage: bb-kit verify [--json]",
  doctor: "Usage: bb-kit doctor [--json]",
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
  issues?: readonly unknown[];
} {
  if (error instanceof InvocationError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.issues.length > 0 ? { issues: error.issues } : {}),
    };
  }
  if (error instanceof FixtureError) return { code: error.code, message: error.message };
  if (error instanceof CliUsageError) return { code: error.code, message: error.message };
  if (error instanceof ProcessError) return { code: error.code, message: error.message };
  return {
    code: "bb_kit_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function operations(root: string) {
  return discoverProject(root).modules.flatMap((module) =>
    module.operations.map((operation) => ({
      identity: operation.identity,
      kind: operation.kind,
      risk: operation.risk,
      rpcMethod: operation.rpcMethod,
      input: operation.input,
      metadataError: operation.metadataError,
    })),
  );
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
    if (command === "init") {
      const parsed = parseArguments(args, ["--kind"], ["--skip-install", "--skip-types"]);
      expectPositionals(parsed, 0, 1);
      const kind = (parsed.values.get("--kind") ?? "backend") as PluginKind;
      if (!["backend", "fullstack", "theme"].includes(kind)) {
        throw new CliUsageError(`invalid plugin kind "${kind}"`);
      }
      const target = resolve(cwd, parsed.positionals[0] ?? ".");
      const created = initializeProject(target, {
        kind,
        syncTypes: !parsed.flags.has("--skip-types"),
        install: !parsed.flags.has("--skip-install"),
        env,
        ...(options.run ? { run: options.run } : {}),
      });
      if (json) io.stdout(JSON.stringify({ ok: true, created }, null, 2));
      else
        io.stdout(
          created.length === 0
            ? "Already initialized."
            : `Created:\n${created.map((file) => `  ${file}`).join("\n")}`,
        );
      return 0;
    }
    if (command === "add") {
      const [subject, ...subjectArgs] = args;
      if (subject === "module") {
        const parsed = parseArguments(subjectArgs);
        expectPositionals(parsed, 1);
        const name = parsed.positionals[0] as string;
        const created = addModule(findProjectRoot(cwd), name);
        if (json) io.stdout(JSON.stringify({ ok: true, created }, null, 2));
        else
          io.stdout(
            created.length === 0 ? `Module ${name} already exists.` : `Created module ${name}.`,
          );
        return 0;
      }
      if (subject === "operation") {
        const parsed = parseArguments(subjectArgs, ["--kind", "--risk"]);
        expectPositionals(parsed, 1);
        const identity = parsed.positionals[0] as string;
        const kind = parsed.values.get("--kind");
        if (kind !== "query" && kind !== "command") {
          throw new CliUsageError("--kind must be query or command");
        }
        const risk = parsed.values.get("--risk");
        if (risk && risk !== "safe" && risk !== "mutating" && risk !== "destructive") {
          throw new CliUsageError("--risk must be safe, mutating, or destructive");
        }
        if (kind === "query" && risk) {
          throw new CliUsageError("queries do not accept --risk");
        }
        const created = addOperation(
          findProjectRoot(cwd),
          identity,
          kind,
          risk as "safe" | "mutating" | "destructive" | undefined,
        );
        if (json) io.stdout(JSON.stringify({ ok: true, created }, null, 2));
        else
          io.stdout(
            created.length === 0
              ? `Operation ${identity} already exists.`
              : `Created operation ${identity}.`,
          );
        return 0;
      }
      if (subject === "migration") {
        const parsed = parseArguments(subjectArgs);
        expectPositionals(parsed, 2);
        const moduleName = parsed.positionals[0] as string;
        const name = parsed.positionals[1] as string;
        const created = addMigration(findProjectRoot(cwd), moduleName, name);
        if (json) io.stdout(JSON.stringify({ ok: true, created }, null, 2));
        else
          io.stdout(
            created.length === 0
              ? `Migration ${moduleName}/${name} already exists.`
              : `Created migration ${created[0]}.`,
          );
        return 0;
      }
      if (subject === "fixture") {
        const parsed = parseArguments(subjectArgs);
        expectPositionals(parsed, 2);
        const identity = parsed.positionals[0] as string;
        const name = parsed.positionals[1] as string;
        const created = addFixture(findProjectRoot(cwd), identity, name);
        if (json) io.stdout(JSON.stringify({ ok: true, created }, null, 2));
        else
          io.stdout(
            created.length === 0
              ? `Fixture ${identity}/${name} already exists.`
              : `Created fixture ${created[0]}.`,
          );
        return 0;
      }
      if (subject === "panel") {
        const parsed = parseArguments(subjectArgs, ["--location"]);
        expectPositionals(parsed, 1);
        const moduleName = parsed.positionals[0] as string;
        const location = parsed.values.get("--location");
        if (location !== "nav" && location !== "thread") {
          throw new CliUsageError("--location must be nav or thread");
        }
        const created = addPanel(findProjectRoot(cwd), moduleName, location);
        if (json) io.stdout(JSON.stringify({ ok: true, created }, null, 2));
        else
          io.stdout(
            created.length === 0
              ? `Panel ${moduleName} already exists.`
              : `Created ${location} panel for ${moduleName}.`,
          );
        return 0;
      }
      throw new CliUsageError("add requires module, operation, fixture, migration, or panel");
    }
    if (command === "operations") {
      const parsed = parseArguments(args);
      expectPositionals(parsed, 0);
      const result = operations(findProjectRoot(cwd));
      if (json) io.stdout(JSON.stringify(result, null, 2));
      else if (result.length === 0) io.stdout("No operations.");
      else
        io.stdout(
          result
            .map(
              (operation) =>
                `${operation.kind.padEnd(7)} ${operation.identity}` +
                `${operation.risk ? ` [${operation.risk}]` : ""}` +
                ` → ${operation.rpcMethod ?? "unlocked"}`,
            )
            .join("\n"),
        );
      return 0;
    }
    if (command === "describe") {
      const parsed = parseArguments(args);
      expectPositionals(parsed, 1);
      const identity = parsed.positionals[0] as string;
      const operation = operations(findProjectRoot(cwd)).find((item) => item.identity === identity);
      if (!operation)
        throw new InvocationError("unknown_operation", `unknown operation "${identity}"`);
      if (operation.input === null || operation.metadataError !== null) {
        throw new InvocationError(
          "invalid_operation_metadata",
          `${identity} has invalid input metadata: ${operation.metadataError ?? "input state is missing"}`,
        );
      }
      if (json) io.stdout(JSON.stringify(operation, null, 2));
      else
        io.stdout(
          [
            `Operation: ${operation.identity}`,
            `Kind: ${operation.kind}`,
            ...(operation.risk ? [`Risk: ${operation.risk}`] : []),
            `RPC method: ${operation.rpcMethod ?? "unlocked"}`,
            `Input: ${operation.input.mode}`,
            ...(operation.input.mode === "none"
              ? ["Wire input: null"]
              : [`Example input: ${JSON.stringify(operation.input.example)}`]),
            `Invoke: ${operationInvokeCommand(operation)}`,
          ].join("\n"),
        );
      return 0;
    }
    if (command === "invoke") {
      const parsed = parseArguments(args, ["--input", "--server"], ["--confirm"]);
      expectPositionals(parsed, 1);
      const identity = parsed.positionals[0] as string;
      const result = await invokeOperation(findProjectRoot(cwd), identity, {
        confirm: parsed.flags.has("--confirm"),
        cwd,
        ...(parsed.values.get("--input") === undefined
          ? {}
          : { input: parsed.values.get("--input") as string }),
        ...((parsed.values.get("--server") ?? env.BB_SERVER_URL)
          ? { serverUrl: (parsed.values.get("--server") ?? env.BB_SERVER_URL) as string }
          : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      if (json) io.stdout(JSON.stringify({ ok: true, ...result }, null, 2));
      else {
        if (result.kind === "command") io.stderr(`Risk: ${result.risk}`);
        io.stdout(JSON.stringify(result.result, null, 2));
      }
      return 0;
    }
    if (command === "fixtures") {
      const [subject, ...subjectArgs] = args;
      if (subject !== "run") throw new CliUsageError("fixtures requires run");
      const parsed = parseArguments(subjectArgs, ["--server"], ["--confirm"]);
      expectPositionals(parsed, 0, 1);
      const result = await runFixtures(findProjectRoot(cwd), {
        ...(parsed.positionals[0] ? { module: parsed.positionals[0] } : {}),
        confirm: parsed.flags.has("--confirm"),
        ...((parsed.values.get("--server") ?? env.BB_SERVER_URL)
          ? { serverUrl: (parsed.values.get("--server") ?? env.BB_SERVER_URL) as string }
          : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      if (json) io.stdout(JSON.stringify(result, null, 2));
      else (result.ok ? io.stdout : io.stderr)(formatFixtureRun(result));
      return result.ok ? 0 : 1;
    }
    if (command === "info") {
      const parsed = parseArguments(args);
      expectPositionals(parsed, 0);
      const result = inspectProject(findProjectRoot(cwd));
      io.stdout(json ? JSON.stringify(result, null, 2) : formatInfo(result));
      return 0;
    }
    if (command === "check") {
      const parsed = parseArguments(args, [], ["--workspace"]);
      expectPositionals(parsed, 0);
      const diagnostics = parsed.flags.has("--workspace")
        ? checkWorkspaceCompatibility(findWorkspaceRoot(cwd))
        : checkProject(findProjectRoot(cwd));
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
    if (command === "build") {
      const parsed = parseArguments(args);
      expectPositionals(parsed, 0);
      const result = buildProject(findProjectRoot(cwd), {
        env,
        ...(options.run ? { run: options.run } : {}),
      });
      if (json) io.stdout(JSON.stringify(result, null, 2));
      else (result.ok ? io.stdout : io.stderr)(formatBuild(result));
      return result.ok ? 0 : 1;
    }
    if (command === "verify") {
      const parsed = parseArguments(args);
      expectPositionals(parsed, 0);
      const result = verifyProject(findProjectRoot(cwd), {
        env,
        ...(options.run ? { run: options.run } : {}),
      });
      if (json) io.stdout(JSON.stringify(result, null, 2));
      else (result.ok ? io.stdout : io.stderr)(formatVerification(result));
      return result.ok ? 0 : 1;
    }
    if (command === "doctor") {
      const parsed = parseArguments(args);
      expectPositionals(parsed, 0);
      const result = doctorProject(findProjectRoot(cwd), {
        env,
        ...(options.run ? { run: options.run } : {}),
      });
      if (json) io.stdout(JSON.stringify(result, null, 2));
      else (result.ok ? io.stdout : io.stderr)(formatDoctor(result));
      return result.ok ? 0 : 1;
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
