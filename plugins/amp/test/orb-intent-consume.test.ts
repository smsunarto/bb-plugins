// The bridge consumes the composer's armed Orb intent exactly once, at
// thread/start, and only when that start creates a fresh record. The
// executor is fixed at thread creation (Amp's own model), so this is the
// only seam the toggle acts through; restarting an existing thread must
// leave the intent alone. thread/start without input spawns no CLI, which
// keeps this test free of fake processes.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_REQUEST_METHODS } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge, handleLine } from "../src/bridge/entry.ts";
import { armOrbIntent, ORB_INTENT_FILE } from "../src/orb-intent.ts";

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

test("thread/start consumes an armed intent only for a fresh record", async () => {
  const root = mkdtempSync(join(tmpdir(), "amp-orb-consume-"));
  const dataDir = join(root, "data");
  const tempDir = join(root, "temp");
  const workspace = join(root, "workspace");
  for (const dir of [dataDir, tempDir, workspace]) mkdirSync(dir, { recursive: true });
  const intentFile = join(dataDir, ORB_INTENT_FILE);
  const output = captureBridgeJsonRpcOutput();
  try {
    experimental_providerBridge.start?.({ pluginId: "amp", dataDir, tempDir });
    const start = (id: number, threadId: string) => {
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
            },
          },
        }),
      );
      return waitForAnswer(output.takeMessages, id);
    };

    armOrbIntent(dataDir);
    const first = await start(1, "thr_orb_consume_a");
    assert.equal(first.error, undefined);
    assert.equal(existsSync(intentFile), false);
    assert.deepEqual(storedTargets(dataDir), [["thr_orb_consume_a", "orb"]]);

    // No intent armed: the next fresh thread stays Local, and Local has no
    // write-through, so the store still holds only the Orb record.
    const second = await start(2, "thr_orb_consume_b");
    assert.equal(second.error, undefined);
    assert.deepEqual(storedTargets(dataDir), [["thr_orb_consume_a", "orb"]]);

    // Restarting a thread that has a record finds it and must not consume.
    armOrbIntent(dataDir);
    const again = await start(3, "thr_orb_consume_a");
    assert.equal(again.error, undefined);
    assert.equal(existsSync(intentFile), true);

    // The surviving intent arms the next fresh thread instead.
    const third = await start(4, "thr_orb_consume_c");
    assert.equal(third.error, undefined);
    assert.equal(existsSync(intentFile), false);
    assert.deepEqual(storedTargets(dataDir), [
      ["thr_orb_consume_a", "orb"],
      ["thr_orb_consume_c", "orb"],
    ]);
  } finally {
    output.restore();
    rmSync(root, { recursive: true, force: true });
  }
});
