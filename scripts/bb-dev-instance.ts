#!/usr/bin/env bun
import type { BinResult } from "../packages/bb-kit-core/src/bin/shared.ts";
import { runDev } from "../packages/bb-kit-core/src/bin/dev/command.ts";
import {
  DevManager,
  type EnvironmentResult,
  type InstanceResult,
} from "../packages/bb-kit-core/src/bin/dev/manager.ts";
import { setUpBbDevInstance } from "./bb-dev-instance-setup.ts";
import type { BbCommandRunner } from "./plugin-screenshot-runtime.ts";

const USAGE = [
  "usage:",
  "  bun run dev:instance -- [bb-kit dev-instance start options]",
  "",
  "Starts an isolated bb instance, then installs and resets this workspace's plugins.",
  "",
].join("\n");

type SuccessEnvelope = {
  schemaVersion: 1;
  ok: true;
  command: string;
  result: InstanceResult;
};

type ErrorEnvelope = {
  schemaVersion: 1;
  ok: false;
  command: string;
  name?: string;
  error: {
    code: string;
    message: string;
    action: string;
    details?: unknown;
  };
};

type Dependencies = {
  manager?: DevManager;
  setup?: typeof setUpBbDevInstance;
  commandRunner?: (environment: EnvironmentResult) => BbCommandRunner;
  log?: (message: string) => void;
};

export async function runPreparedDevInstance(
  argv: readonly string[],
  dependencies: Dependencies = {},
): Promise<BinResult> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")) {
    return { exitCode: 0, stdout: USAGE, stderr: "" };
  }

  const json = argv.includes("--json");
  const startArgs = argv.filter((arg) => arg !== "--json");
  const log = dependencies.log ?? (() => {});
  const manager = dependencies.manager ?? new DevManager({ progress: log });
  const started = await runDev(["start", ...startArgs, "--json"], { manager });
  const envelope = parseEnvelope(started.stdout);
  if (!envelope.ok) {
    return json
      ? started
      : {
          exitCode: started.exitCode,
          stdout: "",
          stderr: formatError(envelope),
        };
  }

  const environment = manager.environmentFor(envelope.result.name);
  const commandRunner =
    dependencies.commandRunner?.(environment) ??
    instanceCommandRunner(environment.BB_CLI, manager.cwd);
  try {
    await (dependencies.setup ?? setUpBbDevInstance)(commandRunner, log);
  } catch (error) {
    const failure: ErrorEnvelope = {
      schemaVersion: 1,
      ok: false,
      command: "start",
      name: envelope.result.name,
      error: {
        code: "setup_failed",
        message: error instanceof Error ? error.message : String(error),
        action: "Fix the setup error, then rerun bun run dev:instance with the same arguments.",
      },
    };
    return json
      ? { exitCode: 1, stdout: `${JSON.stringify(failure)}\n`, stderr: "" }
      : { exitCode: 1, stdout: "", stderr: formatError(failure) };
  }

  const result = { ...envelope.result, prepared: true };
  return {
    exitCode: 0,
    stdout: json
      ? `${JSON.stringify({ ...envelope, result })}\n`
      : `${envelope.result.appUrl ?? ""}\n`,
    stderr: "",
  };
}

function instanceCommandRunner(executable: string, cwd: string): BbCommandRunner {
  return async (args) => {
    const child = Bun.spawn([executable, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
      throw new Error(`bb ${args.join(" ")} failed: ${detail}`);
    }
    return stdout;
  };
}

function parseEnvelope(raw: string): SuccessEnvelope | ErrorEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("bb-kit returned malformed JSON while starting the dev instance");
  }
  if (value === null || typeof value !== "object" || !("ok" in value)) {
    throw new Error("bb-kit returned an invalid start result");
  }
  return value as SuccessEnvelope | ErrorEnvelope;
}

function formatError(envelope: ErrorEnvelope): string {
  return `${envelope.name === undefined ? "" : `Instance: ${envelope.name}\n`}[${envelope.error.code}] ${envelope.error.message}\nNext action: ${envelope.error.action}\n`;
}

if (import.meta.main) {
  const result = await runPreparedDevInstance(process.argv.slice(2), {
    log: (message) => console.error(message),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
