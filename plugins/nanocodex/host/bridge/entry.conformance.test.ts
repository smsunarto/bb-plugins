import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { BRIDGE_REQUEST_METHODS } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_captureBridgeJsonRpcOutput as captureOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createBridge } from "./entry.ts";
import type { ThreadWriter } from "./timeline.ts";
import { SessionBusyError, type SessionRegistry } from "../session.ts";
import { createNanocodexStorage } from "../storage.ts";
import { FakeNativeBinding, snapshot } from "../testing/fake-native.ts";

const OPTIONS = {
  model: "gpt-5.6-sol",
  reasoningLevel: "high",
  serviceTier: "default",
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

test("accepted RPC replies precede notifications and every request settles once", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-protocol-"));
  const output = captureOutput();
  let writer: ThreadWriter | undefined;
  let busy = false;
  let failActivation = false;
  const failures: Array<{ operation: string; error: unknown }> = [];
  const registry: SessionRegistry = {
    prepareNew: async (options) => ({
      providerThreadId: options.providerThreadId,
      activate(next) {
        if (failActivation) throw new Error("activation failed after reply");
        writer = next;
      },
      async dispose() {
        throw new Error("dispose failed after reply");
      },
    }),
    prepareResume: async () => {
      throw new Error("unused");
    },
    prepareFork: async () => {
      throw new Error("unused");
    },
    prepareTurn: (options) => {
      if (busy) throw new SessionBusyError("thread is busy");
      return () => {
        const scribe = writer?.scribe({
          ordinal: 0,
          clientRequestIds: options.clientRequestId === null ? [] : [options.clientRequestId],
        });
        scribe?.open(null);
        scribe?.acceptAll();
        scribe?.settle("completed");
      };
    },
    prepareSteer: (options) => () => {
      const scribe = writer?.scribe({ ordinal: 1, clientRequestIds: [] });
      scribe?.open(null);
      scribe?.adopt([options.clientRequestId]);
      scribe?.acceptAll();
      return Promise.resolve();
    },
    stop: async () => {
      writer?.recovery({ kind: "restartRecommended", message: "test stop", retryable: true });
      throw new Error("stop failed after reply");
    },
    discard: async () => {
      throw new Error("discard failed after reply");
    },
    close: async () => {},
  };
  const bridge = createBridge({
    createStorage: createNanocodexStorage,
    createBinding: () => new FakeNativeBinding(),
    createRegistry: () => registry,
    captureFailure: (operation, error) => failures.push({ operation, error }),
  });
  bridge.start({ dataDir: root });
  try {
    send(bridge, 1, BRIDGE_REQUEST_METHODS.threadStart, {
      threadId: "thread",
      cwd: "/workspace",
      options: OPTIONS,
      instructionMode: "append",
    });
    await settle();
    assertReplyBeforeNotification(output.messages, 1);

    const beforeTurn = output.messages.length;
    send(bridge, 2, BRIDGE_REQUEST_METHODS.turnStart, {
      threadId: "thread",
      providerThreadId: "provider",
      input: [{ type: "text", text: "hello", mentions: [] }],
      clientRequestId: "turn-request",
      options: OPTIONS,
    });
    await settle();
    assertReplyBeforeNotification(output.messages.slice(beforeTurn), 2);

    busy = true;
    send(bridge, 3, BRIDGE_REQUEST_METHODS.turnStart, {
      threadId: "thread",
      providerThreadId: "provider",
      input: [{ type: "text", text: "busy", mentions: [] }],
      clientRequestId: "busy-request",
      options: OPTIONS,
    });
    await settle();
    const busyResponses = output.messages.filter((message) => message.id === 3);
    assert.equal(busyResponses.length, 1);
    assert.equal(busyResponses[0]?.error?.code, -32602);
    busy = false;

    const beforeSteer = output.messages.length;
    send(bridge, 4, BRIDGE_REQUEST_METHODS.turnSteer, {
      threadId: "thread",
      providerThreadId: "provider",
      input: [{ type: "text", text: "steer", mentions: [] }],
      clientRequestId: "steer-request",
      expectedTurnId: "turn-1",
      options: OPTIONS,
    });
    await settle();
    assertReplyBeforeNotification(output.messages.slice(beforeSteer), 4);

    const beforeStop = output.messages.length;
    send(bridge, 5, BRIDGE_REQUEST_METHODS.threadStop, {
      threadId: "thread",
      providerThreadId: "provider",
      intent: "interrupt",
      activeTurnId: null,
    });
    await settle();
    const stopMessages = output.messages.slice(beforeStop);
    assertReplyBeforeNotification(stopMessages, 5);
    assert.equal(stopMessages.filter((message) => message.id === 5).length, 1);

    failActivation = true;
    send(bridge, 6, BRIDGE_REQUEST_METHODS.threadStart, {
      threadId: "broken-activation",
      cwd: "/workspace",
      options: OPTIONS,
      instructionMode: "append",
    });
    await settle();
    assert.equal(output.messages.filter((message) => message.id === 6).length, 1);
    assert.equal(output.messages.find((message) => message.id === 6)?.error, undefined);
    assert.deepEqual(
      failures.map(({ operation }) => operation),
      [
        BRIDGE_REQUEST_METHODS.threadStop,
        "thread/activate",
        "thread/activate/dispose",
        "thread/activate/stop",
      ],
    );
  } finally {
    await bridge.close();
    output.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("the native bridge passes the SDK lifecycle and grammar conformance suite", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-sdk-conformance-"));
  const output = captureOutput();
  const binding = new FakeNativeBinding();
  for (let index = 0; index < 20; index += 1) {
    binding.plans.push({ snapshot: snapshot(`conformance-${index}`) });
  }
  const bridge = createBridge({
    createStorage: createNanocodexStorage,
    createBinding: () => binding,
  });
  bridge.start({ dataDir: root });
  try {
    const report = await runBridgeConformance({
      providerId: "nanocodex",
      transport: { send: (line) => bridge.handleLine(line), takeMessages: output.takeMessages },
      session: {
        cwd: "/workspace",
        promptInput: [{ type: "text", text: "hello", mentions: [] }],
      },
      timeoutMs: 2_000,
    });
    for (const result of report.results) {
      assert.equal(result.status, "pass", `${result.id}: ${result.detail}`);
    }
    assert.equal(report.passed, true, formatConformanceReport(report));
  } finally {
    await bridge.close();
    output.restore();
    await rm(root, { recursive: true, force: true });
  }
});

function send(
  bridge: ReturnType<typeof createBridge>,
  id: number,
  method: string,
  params: Record<string, unknown>,
): void {
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

function assertReplyBeforeNotification(
  messages: readonly { readonly id?: string | number; readonly method?: string }[],
  id: number,
): void {
  const reply = messages.findIndex((message) => message.id === id);
  const notification = messages.findIndex((message) => message.method !== undefined);
  assert.ok(reply >= 0, `missing reply ${id}`);
  if (notification >= 0) assert.ok(reply < notification, `reply ${id} followed a notification`);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 2));
}
