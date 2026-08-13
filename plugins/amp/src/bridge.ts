#!/usr/bin/env node
// Thin stdio entry for the Amp ACP bridge. bb spawns this file (bundled to
// dist/bridge.js) and speaks ACP JSON-RPC over stdin/stdout; the bridge
// drives the Amp CLI through the official @ampcode/sdk.
import "./stderr-guard.ts";

// bb normally starts one bridge process per ACP session. The Amp SDK writes
// prompts to child stdin without an error listener, so a fast cancellation can
// surface EPIPE after SIGTERM; that specific failure is safe to ignore. Every
// other uncaught failure terminates the process rather than leaving the ACP
// request hung in unknown state.
process.on("unhandledRejection", (reason) => {
  console.error("[bridge] unhandled rejection", reason);
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") {
    console.error("[bridge] ignored child stdin EPIPE", error);
    return;
  }
  console.error("[bridge] uncaught exception", error);
  process.exit(1);
});

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { execute } from "@ampcode/sdk";
import {
  AmpBridgeAgent,
  type AmpExecuteFn,
  type ExecutionUsageReport,
} from "./bridge-core.ts";
import { AMP_ACP_ORB_PROJECT_ENV } from "./execution-target.ts";
import { createFileSessionStore } from "./session-store.ts";
import { readBbFastMode, readBbPermissionMode } from "./bb-execution.ts";
import { AMP_CLI_SHIM_REAL_CLI_ENV } from "./amp-cli-shim.ts";

const ampCliShim = join(dirname(fileURLToPath(import.meta.url)), "amp-cli-shim.js");
const configuredAmpCli = process.env.AMP_CLI_PATH?.trim();
if (configuredAmpCli && existsSync(ampCliShim)) {
  process.env[AMP_CLI_SHIM_REAL_CLI_ENV] = configuredAmpCli;
  process.env.AMP_CLI_PATH = ampCliShim;
} else if (configuredAmpCli) {
  console.error(`[amp] Fast compatibility shim is missing at ${ampCliShim}`);
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

function reportExecutionUsage(report: ExecutionUsageReport): void {
  const bbCli = process.env.BB_CLI?.trim();
  if (!bbCli) return;

  const args = [
    "amp",
    "link-session",
    report.sessionId,
    report.executionTarget,
    ...(report.executionTarget === "orb" && report.ampThreadId
      ? [report.ampThreadId]
      : []),
  ];
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  execFile(
    bbCli,
    args,
    {
      env: childEnv,
      maxBuffer: 16 * 1024,
      timeout: 5_000,
      windowsHide: true,
    },
    (error, _stdout, stderr) => {
      if (!error) return;
      const detail = stderr.trim() || error.message;
      console.error(`[amp] could not update the Orb status bar: ${detail}`);
    },
  );
}

// Held in a binding, not constructed for effect: the connection owns the
// JSON-RPC stream for the life of the process and must not be collected.
const connection = new AgentSideConnection(
  (client) =>
    new AmpBridgeAgent(client, {
      execute: execute as unknown as AmpExecuteFn,
      resolveInitialPermission: readBbPermissionMode,
      resolveFastMode: readBbFastMode,
      store: createFileSessionStore(),
      orbProject: process.env[AMP_ACP_ORB_PROJECT_ENV],
      reportExecutionUsage,
    }),
  stream,
);

// Keep the process alive while waiting for JSON-RPC traffic on `connection`.
process.stdin.resume();
void connection;
