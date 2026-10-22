// The bb server, the user's browser, and the hosts that run Amp threads are
// often different machines. These tests load the real server entry against a
// fake bb and pin which machine each answer comes from: Oracle reports and
// the Amp CLI from the thread's host (through the host entry), and the Orb
// choice carried to that host in providerOptions.
import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  createFakePluginHost,
  type ExperimentalFakeHostRpcCall,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { createAmpPlugin } from "../server.ts";

const REPORT_ID = "5f0c1a52-3b7e-4d2a-9c1e-2b9f6a7d8e01";
const REPORT = {
  id: REPORT_ID,
  request: "Why does the cache miss?",
  response: "The key includes the timestamp.",
  status: "completed",
  trace: [],
  createdAt: "2026-10-09T00:00:00.000Z",
};

const HOSTS = [
  { id: "host_mac", name: "Local Mac", status: "connected" },
  { id: "host_server", name: "linux-builder", status: "connected" },
  { id: "host_dev", name: "Build Mac", status: "disconnected" },
];

/** Before any test presses the Orb toggle. */
const LONG_AGO = Date.parse("2026-01-01T00:00:00.000Z");

const THREADS: Record<string, unknown> = {
  thr_mac: {
    id: "thr_mac",
    providerId: "acp-amp",
    createdAt: LONG_AGO,
    environment: { hostId: "host_mac" },
  },
  thr_moved: {
    id: "thr_moved",
    providerId: "acp-amp",
    createdAt: LONG_AGO,
    environment: { hostId: "host_server" },
  },
  thr_history: { id: "thr_history", providerId: "acp-amp", createdAt: LONG_AGO, environment: null },
};

/** A thread bb creates during a test, after the toggle was pressed. */
function createdNow(threadId: string): { id: string; providerId: string; createdAt: number } {
  const thread = { id: threadId, providerId: "acp-amp", createdAt: Date.now() + 1 };
  THREADS[threadId] = thread;
  return thread;
}

/** bb thread reads per thread id, so a test can pin what the server memoizes. */
const threadReads = new Map<string, number>();

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  threadReads.clear();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function loadAmp(
  callHostRpc: (call: ExperimentalFakeHostRpcCall) => unknown = () => {
    throw new Error("no host entry in this test");
  },
): Promise<FakePluginHarness> {
  // An empty bb data dir, so the legacy-config cleanup never reads a real one.
  const dataDir = tempDir("amp-server-data-");
  const { bb, harness } = createFakePluginHost({
    pluginId: "amp",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          threadReads.set(threadId, (threadReads.get(threadId) ?? 0) + 1);
          return THREADS[threadId];
        },
        events: { list: async () => [] },
      },
      hosts: {
        list: async () => HOSTS,
        get: async ({ hostId }: { hostId: string }) => HOSTS.find((host) => host.id === hostId),
      },
      providers: { list: async () => [{ id: "acp-amp" }] },
      system: { config: async () => ({ dataDir }) },
    } as never,
    experimental_callHostRpc: callHostRpc,
  });
  await createAmpPlugin(() => undefined)(bb);
  return harness;
}

function hostCalls(harness: FakePluginHarness) {
  return harness.inspection.experimental_hostRpcCalls.map(({ method, hostId, input }) => ({
    method,
    hostId,
    input,
  }));
}

function deriveOptions(harness: FakePluginHarness, threadId: string) {
  const [provider] = harness.registrations.providerRegistrations;
  assert.ok(provider, "the Amp provider registered");
  return provider.deriveProviderOptions?.({
    threadId,
    projectId: "prj_1",
    model: "default",
    permissionMode: "full",
    settings: {},
  });
}

async function register(harness: FakePluginHarness): Promise<void> {
  await harness.behavior.runService("register").done;
}

test("an Oracle card reads its report from the host that ran the thread", async () => {
  const harness = await loadAmp((call) => ({
    report: call.hostId === "host_mac" ? REPORT : null,
  }));
  const result = await harness.behavior.callRpc("getOracleReport", {
    reportId: REPORT_ID,
    threadId: "thr_mac",
  });
  assert.deepEqual(result, { report: REPORT, error: null });
  assert.deepEqual(hostCalls(harness), [
    { method: "oracleReport", hostId: "host_mac", input: { reportId: REPORT_ID } },
  ]);
});

test("a thread with no environment finds its report on the connected host that has it", async () => {
  const harness = await loadAmp((call) => ({
    report: call.hostId === "host_mac" ? REPORT : null,
  }));
  const result = await harness.behavior.callRpc("getOracleReport", {
    reportId: REPORT_ID,
    threadId: "thr_history",
  });
  assert.deepEqual(result, { report: REPORT, error: null });
  assert.deepEqual(
    hostCalls(harness).map((call) => call.hostId),
    ["host_mac", "host_server"],
  );
});

test("a thread that moved hosts finds its report on the host that ran the Oracle", async () => {
  // The report stays on Local Mac; the thread now runs on linux-builder.
  const harness = await loadAmp((call) => ({
    report: call.hostId === "host_mac" ? REPORT : null,
  }));
  const result = await harness.behavior.callRpc("getOracleReport", {
    reportId: REPORT_ID,
    threadId: "thr_moved",
  });
  assert.deepEqual(result, { report: REPORT, error: null });
  assert.deepEqual(
    hostCalls(harness).map((call) => call.hostId),
    ["host_server", "host_mac"],
  );
});

test("a report found by asking every host is read from that host next time", async () => {
  const harness = await loadAmp((call) => ({
    report: call.hostId === "host_mac" ? REPORT : null,
  }));
  const read = () =>
    harness.behavior.callRpc("getOracleReport", { reportId: REPORT_ID, threadId: "thr_moved" });
  assert.deepEqual(await read(), { report: REPORT, error: null });
  assert.deepEqual(await read(), { report: REPORT, error: null });
  assert.deepEqual(
    hostCalls(harness).map((call) => call.hostId),
    ["host_server", "host_mac", "host_mac"],
  );
  assert.equal(threadReads.get("thr_moved"), 1);
});

test("the Orb banner reads a thread's provider once, and an unlinked Amp thread is not hidden", async () => {
  const harness = await loadAmp();
  THREADS.thr_claude = { id: "thr_claude", providerId: "claude-code", createdAt: LONG_AGO };
  assert.deepEqual(await harness.behavior.callRpc("getOrbUsage", { threadId: "thr_claude" }), {
    state: "hidden",
  });
  assert.deepEqual(await harness.behavior.callRpc("getOrbUsage", { threadId: "thr_claude" }), {
    state: "hidden",
  });
  assert.equal(threadReads.get("thr_claude"), 1);
  assert.deepEqual(await harness.behavior.callRpc("getOrbUsage", { threadId: "thr_mac" }), {
    state: "unlinked",
  });
});

test("the first host that has the report answers without waiting for a slow one", async () => {
  // linux-builder never answers; the lookup must not wait out its timeout.
  const harness = await loadAmp((call) =>
    call.hostId === "host_mac" ? { report: REPORT } : new Promise(() => {}),
  );
  const result = await Promise.race([
    harness.behavior.callRpc("getOracleReport", { reportId: REPORT_ID, threadId: "thr_history" }),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
  ]);
  assert.deepEqual(result, { report: REPORT, error: null });
});

test("an unreachable thread host is named on the card", async () => {
  const harness = await loadAmp(() => {
    throw new Error("host host_mac is not connected");
  });
  const result = await harness.behavior.callRpc("getOracleReport", {
    reportId: REPORT_ID,
    threadId: "thr_mac",
  });
  assert.deepEqual(result, {
    report: null,
    error:
      "The Oracle report is stored on Local Mac, which bb cannot reach right now. Open the native tool call to view its output.",
  });
});

test("`bb amp status` reports the Amp CLI each host would run", async () => {
  const harness = await loadAmp((call) => ({
    path: call.hostId === "host_mac" ? "/Users/example/.local/bin/amp" : null,
  }));
  const result = await harness.behavior.runCli(["status"]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stdout.split("\n").slice(0, 3), [
    "Amp CLI on Local Mac: /Users/example/.local/bin/amp",
    "Amp CLI on linux-builder: NOT FOUND. Install it with the Install button in bb's composer, or from https://ampcode.com/docs/cli (on Windows, inside WSL), then run `amp login`.",
    "Amp CLI on Build Mac: host not connected",
  ]);
  assert.deepEqual(
    hostCalls(harness).map((call) => [call.method, call.hostId]),
    [
      ["cliStatus", "host_mac"],
      ["cliStatus", "host_server"],
    ],
  );
});

test("the server sends no Amp CLI path to the hosts, even when it has one itself", async () => {
  const bin = tempDir("amp-server-bin-");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "amp"), "#!/bin/sh\n", "utf8");
  chmodSync(join(bin, "amp"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    const harness = await loadAmp();
    await register(harness);
    assert.deepEqual(deriveOptions(harness, "thr_mac"), {});
  } finally {
    process.env.PATH = previousPath;
  }
});

test("the armed Orb toggle rides providerOptions to the next Amp thread", async () => {
  const harness = await loadAmp();
  await register(harness);
  await harness.behavior.callRpc("setOrbIntent", { armed: true });
  // Another provider's thread leaves the intent for the Amp thread.
  await harness.behavior.emitThreadEvent("thread.created", {
    thread: { id: "thr_claude", providerId: "claude-code" },
  } as never);
  assert.deepEqual(await harness.behavior.callRpc("getOrbIntent", {}), { armed: true });

  await harness.behavior.emitThreadEvent("thread.created", {
    thread: { id: "thr_new", providerId: "acp-amp" },
  } as never);
  assert.deepEqual(await harness.behavior.callRpc("getOrbIntent", {}), { armed: false });
  assert.deepEqual(deriveOptions(harness, "thr_new"), { executionTarget: "orb" });
  assert.deepEqual(deriveOptions(harness, "thr_mac"), {});
});

test("two Amp threads whose first commands precede thread.created: only the first runs on Orb", async () => {
  const harness = await loadAmp();
  await register(harness);
  await harness.behavior.callRpc("setOrbIntent", { armed: true });
  const first = createdNow("thr_first");
  const second = createdNow("thr_second");
  assert.deepEqual(deriveOptions(harness, first.id), { executionTarget: "orb" });
  assert.deepEqual(deriveOptions(harness, second.id), {});
  await harness.behavior.emitThreadEvent("thread.created", { thread: first } as never);
  await harness.behavior.emitThreadEvent("thread.created", { thread: second } as never);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deriveOptions(harness, first.id), { executionTarget: "orb" });
  assert.deepEqual(deriveOptions(harness, second.id), {});
  assert.deepEqual(await harness.behavior.callRpc("getOrbIntent", {}), { armed: false });
});

test("a command from an Amp thread older than the press leaves the press for the new thread", async () => {
  const harness = await loadAmp();
  await register(harness);
  await harness.behavior.callRpc("setOrbIntent", { armed: true });
  // This server has not seen thr_mac yet, as after a restart.
  deriveOptions(harness, "thr_mac");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await harness.behavior.callRpc("getOrbIntent", {}), { armed: true });
  assert.deepEqual(deriveOptions(harness, "thr_mac"), {});

  const fresh = createdNow("thr_fresh");
  await harness.behavior.emitThreadEvent("thread.created", { thread: fresh } as never);
  assert.deepEqual(deriveOptions(harness, fresh.id), { executionTarget: "orb" });
});
