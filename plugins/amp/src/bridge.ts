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

import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { execute } from "@ampcode/sdk";
import { AmpBridgeAgent, type AmpExecuteFn } from "./bridge-core.ts";
import { createFileSessionStore } from "./session-store.ts";

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

// Held in a binding, not constructed for effect: the connection owns the
// JSON-RPC stream for the life of the process and must not be collected.
const connection = new AgentSideConnection(
  (client) =>
    new AmpBridgeAgent(client, {
      execute: execute as unknown as AmpExecuteFn,
      store: createFileSessionStore(),
    }),
  stream,
);

// Keep the process alive while waiting for JSON-RPC traffic on `connection`.
process.stdin.resume();
void connection;
