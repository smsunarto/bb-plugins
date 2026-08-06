// Smoke test: spawn the built bridge bundle and do a raw JSON-RPC
// initialize round-trip over stdio. Skips when dist/bridge.js is unbuilt.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const BRIDGE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "bridge.js");

test("bundled bridge answers initialize over stdio", { skip: !existsSync(BRIDGE) && "dist/bridge.js not built; run npm run build" }, async () => {
  const child = spawn(process.execPath, [BRIDGE], { stdio: ["pipe", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    const responseLine = new Promise<string>((resolve, reject) => {
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline >= 0) resolve(buffer.slice(0, newline));
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        reject(new Error(`bridge exited early (code ${code}): ${Buffer.concat(stderr).toString("utf8")}`)));
      setTimeout(() => reject(new Error("timed out waiting for initialize response")), 10_000).unref();
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "bb", version: "1.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
    })}\n`);

    const parsed = JSON.parse(await responseLine) as {
      id: number;
      result?: { protocolVersion?: number; agentCapabilities?: { loadSession?: boolean } };
      error?: unknown;
    };
    assert.equal(parsed.id, 1);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.result?.protocolVersion, 1);
    assert.equal(parsed.result?.agentCapabilities?.loadSession, true);
  } finally {
    child.kill("SIGKILL");
  }
});
