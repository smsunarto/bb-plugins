#!/usr/bin/env node
// Thin stdio entry for the Amp ACP bridge. bb spawns this file (bundled to
// dist/bridge.js) and speaks ACP JSON-RPC over stdin/stdout; the bridge
// drives the Amp CLI through the official @ampcode/sdk.
import "./stderr-guard.ts";

// This one process multiplexes every active bb session. A stray EPIPE from an
// amp child's stdin (the Amp SDK writes the prompt with no 'error' listener;
// a fast cancel can SIGTERM the child before the write flushes) or a floating
// rejection anywhere in the SDK dependency tree must not take the bridge down
// and kill unrelated sessions. Log and keep serving; if bb itself goes away,
// stdin ends and the process exits naturally.
process.on("unhandledRejection", (reason) => {
  console.error("[bridge] unhandled rejection", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[bridge] uncaught exception", error);
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

new AgentSideConnection(
  (client) =>
    new AmpBridgeAgent(client, {
      execute: execute as unknown as AmpExecuteFn,
      store: createFileSessionStore(),
    }),
  stream,
);

// Keep the process alive while waiting for JSON-RPC traffic.
process.stdin.resume();
