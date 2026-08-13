#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AMP_CLI_SHIM_FAST_ENV = "BB_AMP_FAST";
export const AMP_CLI_SHIM_REAL_CLI_ENV = "BB_AMP_REAL_CLI_PATH";

export interface AmpCliInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function hasFastFeature(args: readonly string[]): boolean {
  return args.some((arg, index) =>
    arg === "--features"
    && args[index + 1]?.split(",").includes("fast"));
}

/**
 * Build the real Amp invocation behind the SDK compatibility shim.
 *
 * The official SDK has no Fast option. The bridge marks only local execute
 * children, and this shim converts that private marker to Amp CLI `--fast`.
 * All probes and non-execute commands pass through byte-for-byte.
 */
export function buildAmpCliInvocation(
  args: readonly string[],
  sourceEnv: NodeJS.ProcessEnv,
): AmpCliInvocation {
  const realCli = sourceEnv[AMP_CLI_SHIM_REAL_CLI_ENV]?.trim();
  if (!realCli) {
    throw new Error(`${AMP_CLI_SHIM_REAL_CLI_ENV} is missing`);
  }

  const forwardedArgs = [...args];
  const executeIndex = forwardedArgs.indexOf("--execute");
  if (
    sourceEnv[AMP_CLI_SHIM_FAST_ENV] === "1"
    && executeIndex >= 0
    && !(forwardedArgs[0] === "threads" && forwardedArgs[1] === "continue")
    && !forwardedArgs.includes("--orb-execute")
    && !forwardedArgs.includes("--fast")
    && !hasFastFeature(forwardedArgs)
  ) {
    forwardedArgs.splice(executeIndex, 0, "--fast");
  }

  const env = { ...sourceEnv };
  delete env[AMP_CLI_SHIM_FAST_ENV];
  delete env[AMP_CLI_SHIM_REAL_CLI_ENV];
  env.AMP_CLI_PATH = realCli;

  const isNodeScript = /\.(?:cjs|mjs|js)$/u.test(realCli);
  return {
    command: isNodeScript ? process.execPath : realCli,
    args: isNodeScript ? [realCli, ...forwardedArgs] : forwardedArgs,
    env,
  };
}

function run(): void {
  let invocation: AmpCliInvocation;
  try {
    invocation = buildAmpCliInvocation(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`[amp] could not launch the Amp CLI: ${String(error)}`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(invocation.command, invocation.args, {
    env: invocation.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const signals = ["SIGINT", "SIGHUP", "SIGTERM"] as const;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => {
      if (!child.killed) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  let settled = false;
  const cleanup = (): boolean => {
    if (settled) return false;
    settled = true;
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    return true;
  };
  child.once("error", (error) => {
    if (!cleanup()) return;
    console.error(`[amp] could not launch ${invocation.command}: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (!cleanup()) return;
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (
  basename(fileURLToPath(import.meta.url)) === "amp-cli-shim.js"
  && process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run();
}
