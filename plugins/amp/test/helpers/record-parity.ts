// Records the parity cells under test/recordings/acp-amp/. A manual tool, not
// a test: run it when the bridge's wire behavior changes on purpose, then
// commit the refreshed recordings that test/bridge-parity.test.ts replays.
//
//   node --experimental-strip-types test/helpers/record-parity.ts
//
// It spawns the real bridge (dist/host.js) through the SDK's worker bootstrap
// with BB_PROVIDER_BRIDGE_RECORD_DIR set, so the bootstrap itself records the
// runtime<->bridge lanes; this script only drives the JSON-RPC session and
// merges the bootstrap's per-scope lane files into one flat cell directory
// (the reader orders entries by (run, seq), so concatenation is safe).
//
// Determinism: replay re-runs this same fake CLI, and the recorded wire
// carries two absolute paths — the session cwd and providerOptions.ampCliPath
// (entry.ts exports the latter into AMP_CLI_PATH). Both therefore live under
// the fixed PARITY_ROOT rather than a per-run temp dir, and the parity test
// recreates them before replaying. Fixed POSIX paths: the recordings do not
// replay on Windows.
// Must be first: bb SDK modules expect a CJS-style global require.
import "./global-require.ts";
import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_resolveProviderBridgeLaunch as resolveProviderBridgeLaunch } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { FAKE_CLI, PARITY_CELLS, PARITY_ROOT, prepareParityRoot } from "./parity-fixture.ts";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST_MODULE = join(PLUGIN_ROOT, "dist", "host.js");
const RECORDINGS_ROOT = join(PLUGIN_ROOT, "test", "recordings", "acp-amp");

interface CellDriver {
  send(method: string, params: unknown): Promise<unknown>;
  /** Resolves at the next `turn.boundary` delta (a settled turn). */
  nextBoundary(): Promise<void>;
  /** Resolves once at least one delta arrived and the wire then went quiet. */
  firstDeltaQuiet(): Promise<void>;
}

const OPTIONS = {
  providerOptions: {
    ampCliPath: join(PARITY_ROOT, "fake-amp.mjs"),
    ampRealCliPath: join(PARITY_ROOT, "fake-amp.mjs"),
  },
  approvalReviewer: null,
  permissionEscalation: null,
  permissionMode: "full",
  permissionScope: "full",
} as const;

const text = (value: string) => [{ type: "text", text: value, mentions: [] }];

/** One script per recorded cell; each runs against a fresh bridge process. */
const CELL_SCRIPTS: Record<string, (drive: CellDriver, threadId: string) => Promise<void>> = {
  "turn-tools": async (drive, threadId) => {
    const started = (await drive.send("thread/start", {
      threadId,
      cwd: join(PARITY_ROOT, "workspace"),
      instructionMode: "append",
      options: OPTIONS,
    })) as { providerThreadId: string };
    await drive.send("turn/start", {
      threadId,
      providerThreadId: started.providerThreadId,
      clientRequestId: "creq_recparity2",
      input: text("TOOL"),
      options: OPTIONS,
    });
    await drive.nextBoundary();
    await drive.send("thread/stop", {
      threadId,
      providerThreadId: started.providerThreadId,
      activeTurnId: null,
      intent: "release",
    });
  },
  steer: async (drive, threadId) => {
    const started = (await drive.send("thread/start", {
      threadId,
      cwd: join(PARITY_ROOT, "workspace"),
      instructionMode: "append",
      options: OPTIONS,
    })) as { providerThreadId: string };
    await drive.send("turn/start", {
      threadId,
      providerThreadId: started.providerThreadId,
      clientRequestId: "creq_recparity2",
      input: text("HOLD_OPEN"),
      options: OPTIONS,
    });
    await drive.firstDeltaQuiet();
    // The bridge validates expectedTurnId as a non-empty string only (one
    // turn at a time; the settled check covers staleness), so a synthetic id
    // is a faithful runtime line.
    await drive.send("turn/steer", {
      threadId,
      providerThreadId: started.providerThreadId,
      clientRequestId: "creq_recparity3",
      expectedTurnId: "turn-recorded-1",
      input: text("finish now"),
      options: OPTIONS,
    });
    await drive.nextBoundary();
    await drive.send("thread/stop", {
      threadId,
      providerThreadId: started.providerThreadId,
      activeTurnId: null,
      intent: "release",
    });
  },
  "stop-interrupt": async (drive, threadId) => {
    const started = (await drive.send("thread/start", {
      threadId,
      cwd: join(PARITY_ROOT, "workspace"),
      instructionMode: "append",
      options: OPTIONS,
    })) as { providerThreadId: string };
    await drive.send("turn/start", {
      threadId,
      providerThreadId: started.providerThreadId,
      clientRequestId: "creq_recparity2",
      input: text("HOLD_OPEN"),
      options: OPTIONS,
    });
    await drive.firstDeltaQuiet();
    // stop() flushes the interrupted boundary before this result arrives.
    await drive.send("thread/stop", {
      threadId,
      providerThreadId: started.providerThreadId,
      activeTurnId: null,
      intent: "interrupt",
    });
  },
  resume: async (drive, threadId) => {
    const started = (await drive.send("thread/start", {
      threadId,
      cwd: join(PARITY_ROOT, "workspace"),
      instructionMode: "append",
      options: OPTIONS,
    })) as { providerThreadId: string };
    await drive.send("turn/start", {
      threadId,
      providerThreadId: started.providerThreadId,
      clientRequestId: "creq_recparity2",
      input: text("say hello"),
      options: OPTIONS,
    });
    await drive.nextBoundary();
    await drive.send("thread/stop", {
      threadId,
      providerThreadId: started.providerThreadId,
      activeTurnId: null,
      intent: "release",
    });
    await drive.send("thread/resume", {
      threadId,
      providerThreadId: started.providerThreadId,
      cwd: join(PARITY_ROOT, "workspace"),
      instructionMode: "append",
      options: OPTIONS,
    });
    await drive.send("turn/start", {
      threadId,
      providerThreadId: started.providerThreadId,
      clientRequestId: "creq_recparity4",
      input: text("say hello again"),
      options: OPTIONS,
    });
    await drive.nextBoundary();
    await drive.send("thread/stop", {
      threadId,
      providerThreadId: started.providerThreadId,
      activeTurnId: null,
      intent: "release",
    });
  },
};

/** Every driver step re-arms this timer; a stall names the step and exits 3. */
let watchdog: ReturnType<typeof setTimeout> | null = null;
function armWatchdog(step: string): void {
  if (watchdog !== null) clearTimeout(watchdog);
  console.error(`[recorder] ${step}`);
  watchdog = setTimeout(() => {
    console.error(`[recorder] watchdog: stalled at "${step}" for 45s`);
    process.exit(3);
  }, 45_000);
  watchdog.unref();
}

async function recordCell(cell: string): Promise<void> {
  const recordDir = join(PARITY_ROOT, "raw", cell);
  rmSync(recordDir, { recursive: true, force: true });
  mkdirSync(recordDir, { recursive: true });
  const dataDir = join(PARITY_ROOT, "data", cell);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const launch = resolveProviderBridgeLaunch({
    modulePath: HOST_MODULE,
    pluginId: "amp",
    dataDir,
  });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: {
      // launch.env alone has no PATH, and the bridge spawns the fake CLI
      // through `#!/usr/bin/env node` — the ambient env must ride along.
      ...process.env,
      ...launch.env,
      AMP_CLI_PATH: join(PARITY_ROOT, "fake-amp.mjs"),
      BB_PROVIDER_BRIDGE_RECORD_DIR: recordDir,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const pending = new Map<string, (result: unknown) => void>();
  let boundaryWaiter: (() => void) | null = null;
  let deltaWaiter: (() => void) | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  const rl = createInterface({ input: child.stdout!, terminal: false });
  rl.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "string" && pending.has(message.id)) {
      if (message.error !== undefined) {
        console.error(`${cell}: error response`, JSON.stringify(message.error));
        process.exit(1);
      }
      pending.get(message.id)!(message.result);
      pending.delete(message.id);
      return;
    }
    if (message.method !== "thread/delta") return;
    const params = message.params as { deltas?: Array<{ kind?: string }> };
    if (deltaWaiter !== null) {
      // A short quiet period after the last delta batch: the turn is open
      // and the fake CLI has said all it will say without further input.
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        deltaWaiter?.();
        deltaWaiter = null;
      }, 400);
    }
    if (params.deltas?.some((delta) => delta.kind === "turn.boundary")) {
      boundaryWaiter?.();
      boundaryWaiter = null;
    }
  });

  let nextId = 0;
  const drive: CellDriver = {
    send(method, params) {
      armWatchdog(`${cell}: send ${method}`);
      const id = `rec-${++nextId}`;
      const result = new Promise<unknown>((resolve) => pending.set(id, resolve));
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return result;
    },
    nextBoundary: () => {
      armWatchdog(`${cell}: await turn.boundary`);
      return new Promise((resolve) => (boundaryWaiter = resolve));
    },
    firstDeltaQuiet: () => {
      armWatchdog(`${cell}: await delta quiet`);
      return new Promise((resolve) => (deltaWaiter = resolve));
    },
  };

  await drive.send("initialize", {});
  const threadId = `thr-parity-${cell}`;
  await CELL_SCRIPTS[cell]!(drive, threadId);

  child.stdin!.end();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  rl.close();
  if (quietTimer !== null) clearTimeout(quietTimer);

  // Merge the bootstrap's per-scope lane files (`_process/` plus the
  // sanitized thread scope) into the flat cell directory the reader expects.
  const cellDir = join(RECORDINGS_ROOT, cell);
  rmSync(cellDir, { recursive: true, force: true });
  mkdirSync(cellDir, { recursive: true });
  const lanes = new Map<string, string[]>();
  for (const scope of readdirSync(recordDir)) {
    const scopeDir = join(recordDir, scope);
    for (const lane of readdirSync(scopeDir)) {
      const list = lanes.get(lane) ?? [];
      list.push(join(scopeDir, lane));
      lanes.set(lane, list);
    }
  }
  for (const [lane, files] of lanes) {
    if (files.length === 1) {
      cpSync(files[0]!, join(cellDir, lane));
      continue;
    }
    const { readFileSync } = await import("node:fs");
    writeFileSync(join(cellDir, lane), files.map((file) => readFileSync(file, "utf8")).join(""));
  }
  console.log(`${cell}: recorded ${[...lanes.keys()].sort().join(", ")}`);
}

async function main(): Promise<void> {
  if (!existsSync(HOST_MODULE)) {
    console.error(`Build first: ${HOST_MODULE} is missing (run \`bun run build\`).`);
    process.exit(1);
  }
  prepareParityRoot();
  writeFileSync(join(PARITY_ROOT, "fake-amp.mjs"), FAKE_CLI, "utf8");
  chmodSync(join(PARITY_ROOT, "fake-amp.mjs"), 0o755);
  for (const cell of PARITY_CELLS) await recordCell(cell);
}

await main();
