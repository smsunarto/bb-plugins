#!/usr/bin/env bun
import type { BinResult } from "../packages/bb-kit-core/src/bin/shared.ts";
import { runDev } from "../packages/bb-kit-core/src/bin/dev/command.ts";
import { DevManager, type InstanceResult } from "../packages/bb-kit-core/src/bin/dev/manager.ts";

const USAGE = [
  "usage:",
  "  bun run dev:instance -- [owned bb-kit dev-instance start options]",
  "",
  "Starts an owned bb instance, builds this workspace, then applies the plugin baseline.",
  "",
].join("\n");

const BUILD_COMMAND = ["bun", "run", "build:managed"] as const;
export const WATCH_COMMAND = [
  "bun",
  "run",
  "--filter",
  "@smsunarto/bb-plugin-*",
  "--filter",
  "!@smsunarto/bb-plugin-agent-proxy",
  "--parallel",
  "--no-orphans",
  "dev",
] as const;

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
  runProgram?: (
    name: string,
    argv: readonly [string, ...string[]],
    options: { stdout: "inherit" | "stderr" },
  ) => Promise<number>;
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
  const watch = argv.includes("--watch");
  const startArgs = argv.filter((arg) => arg !== "--json" && arg !== "--watch");
  const log = dependencies.log ?? (() => {});
  const manager = dependencies.manager ?? new DevManager({ progress: log });
  if (startArgs.includes("--attach")) {
    return failureResult(
      json,
      undefined,
      "attached_source_unsupported",
      "The bb-plugins workflow cannot reset an attached bb instance.",
      "Use bb-kit dev-instance start --attach for bb core development.",
    );
  }
  const runProgram =
    dependencies.runProgram ??
    ((name, command, options) => manager.run(name, command, { stdout: options.stdout }));
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

  const name = envelope.result.name;
  const buildExit = await runProgram(name, BUILD_COMMAND, { stdout: "stderr" });
  if (buildExit !== 0) {
    return failureResult(
      json,
      name,
      "build_failed",
      `Workspace build exited with status ${buildExit}.`,
      "Fix the build, then rerun bun run dev:instance.",
    );
  }
  if (envelope.result.source === "attached") {
    return failureResult(
      json,
      name,
      "baseline_refused",
      "The bb-plugins baseline cannot reset an attached bb instance.",
      "Use an owned revision selector for bun run dev:instance.",
    );
  }
  const dataDir = envelope.result.dataDir;
  if (dataDir === null) {
    return failureResult(
      json,
      name,
      "baseline_target_missing",
      "The managed instance did not report its data directory.",
      "Inspect bb-kit dev-instance status, then retry bun run dev:instance.",
    );
  }

  const baselineExit = await runProgram(
    name,
    ["bun", "scripts/bb-dev-instance-setup.ts", "--expected-data-dir", dataDir],
    { stdout: "stderr" },
  );
  if (baselineExit !== 0) {
    return failureResult(
      json,
      name,
      "setup_failed",
      `Plugin baseline exited with status ${baselineExit}.`,
      "Fix the baseline error, then rerun bun run dev:instance.",
    );
  }

  if (watch) {
    const watchExit = await runProgram(name, WATCH_COMMAND, { stdout: "inherit" });
    if (watchExit !== 0) {
      return failureResult(
        json,
        name,
        "watch_failed",
        `Plugin watchers exited with status ${watchExit}.`,
        "Fix the watcher error, then rerun bun run dev.",
      );
    }
  }

  const result = { ...envelope.result, built: true, prepared: true };
  return {
    exitCode: 0,
    stdout: json
      ? `${JSON.stringify({ ...envelope, result })}\n`
      : `${envelope.result.appUrl ?? ""}\n`,
    stderr: "",
  };
}

function failureResult(
  json: boolean,
  name: string | undefined,
  code: string,
  message: string,
  action: string,
): BinResult {
  const failure: ErrorEnvelope = {
    schemaVersion: 1,
    ok: false,
    command: "start",
    ...(name === undefined ? {} : { name }),
    error: { code, message, action },
  };
  return json
    ? { exitCode: 1, stdout: `${JSON.stringify(failure)}\n`, stderr: "" }
    : { exitCode: 1, stdout: "", stderr: formatError(failure) };
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
