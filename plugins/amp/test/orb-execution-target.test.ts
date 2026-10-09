// The bridge takes the server's Orb choice from providerOptions at
// thread/start, and only when that start creates a fresh record. The server
// settles the choice (src/orb-intent.ts) and sends it on the daemon wire, so
// it reaches whichever host runs the thread. The executor is fixed at thread
// creation (Amp's own model); restarting an existing thread keeps it.
// thread/start without input spawns no CLI, which keeps this test free of
// fake processes.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_REQUEST_METHODS } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge, handleLine } from "../src/bridge/entry.ts";

interface JsonRpcAnswer {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

async function waitForAnswer(takeMessages: () => unknown[], id: number): Promise<JsonRpcAnswer> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const message of takeMessages()) {
      const answer = message as JsonRpcAnswer;
      if (answer.id === id) return answer;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`No JSON-RPC answer for request ${id}`);
}

function storedTargets(dataDir: string): [string, string][] {
  const dir = join(dataDir, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        threadId: string;
        executionTarget: string;
      };
      return [record.threadId, record.executionTarget] as [string, string];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function bridgeHarness() {
  const root = mkdtempSync(join(tmpdir(), "amp-orb-start-"));
  const dataDir = join(root, "data");
  const tempDir = join(root, "temp");
  const workspace = join(root, "workspace");
  for (const dir of [dataDir, tempDir, workspace]) mkdirSync(dir, { recursive: true });
  const output = captureBridgeJsonRpcOutput();
  experimental_providerBridge.start?.({ pluginId: "amp", dataDir, tempDir });
  const start = (id: number, threadId: string, providerOptions: Record<string, string>) => {
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: BRIDGE_REQUEST_METHODS.threadStart,
        params: {
          threadId,
          cwd: workspace,
          instructionMode: "append",
          options: {
            permissionMode: "auto",
            permissionScope: "workspace",
            approvalReviewer: "automatic",
            permissionEscalation: "ask",
            providerOptions,
          },
        },
      }),
    );
    return waitForAnswer(output.takeMessages, id);
  };
  return {
    dataDir,
    start,
    dispose() {
      output.restore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("thread/start runs a fresh thread on Orb only when the server says so", async () => {
  const bridge = bridgeHarness();
  try {
    assert.equal(
      (await bridge.start(1, "thr_orb_start_a", { executionTarget: "orb" })).error,
      undefined,
    );
    assert.equal((await bridge.start(2, "thr_orb_start_b", {})).error, undefined);
    assert.deepEqual(storedTargets(bridge.dataDir), [
      ["thr_orb_start_a", "orb"],
      ["thr_orb_start_b", "local"],
    ]);
  } finally {
    bridge.dispose();
  }
});

test("a restarted thread keeps its executor whatever the server sends", async () => {
  const bridge = bridgeHarness();
  try {
    assert.equal((await bridge.start(1, "thr_orb_restart", {})).error, undefined);
    // While the toggle is armed the server sends Orb to every Amp thread
    // command. A restart is not a creation, so the record decides.
    assert.equal(
      (await bridge.start(2, "thr_orb_restart", { executionTarget: "orb" })).error,
      undefined,
    );
    assert.deepEqual(storedTargets(bridge.dataDir), [["thr_orb_restart", "local"]]);
  } finally {
    bridge.dispose();
  }
});
