import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOST_ENTRY_PATH = fileURLToPath(new URL("./host.ts", import.meta.url));

interface BridgeClient {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

function spawnBridgeClient(extraEnv?: Record<string, string>): BridgeClient {
  const bootstrap = `
    import readline from "node:readline";
    import { experimental_providerBridge as bridge } from ${JSON.stringify(HOST_ENTRY_PATH)};
    bridge.start?.({
      pluginId: "antigravity",
      dataDir: process.env.BB_TEST_DATA_DIR || "/tmp",
      tempDir: process.env.BB_TEST_TEMP_DIR || "/tmp",
    });
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => { if (line.trim()) bridge.handleLine(line); });
    rl.on("close", () => { bridge.onClose?.(); process.exit(0); });
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", bootstrap],
    {
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, (message: Record<string, unknown>) => void>();

  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const id = parsed["id"];
        if (typeof id === "number") {
          const resolve = pending.get(id);
          if (resolve) {
            pending.delete(id);
            resolve(parsed);
          }
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method} (id ${id})`));
        }, 10_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    close() {
      return new Promise((resolve) => {
        child.once("close", () => resolve());
        child.stdin.end();
      });
    },
  };
}

test("bridge process handles initialize, installation, health, and usage over stdio JSON-RPC", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "bb-antigravity-bridge-"));
  const fakeAgy = path.join(scratch, "fake-agy");
  const fakeScript = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "1.5.17"
  exit 0
fi
if [ "$1" = "-p" ] && [ "$2" = "/usage" ]; then
  if [ "$FAKE_AGY_SIGNED_OUT" = "1" ]; then
    echo "Authentication required" >&2
    exit 1
  fi
  cat <<'JSON'
{"conversation_id":"","status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.7,"reset_time":"2026-11-26T08:59:22Z"},{"name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.9,"reset_time":"2026-12-02T21:46:18Z"}]}]}}}
JSON
  exit 0
fi
exit 0
`;
  await writeFile(fakeAgy, fakeScript, "utf8");
  await chmod(fakeAgy, 0o755);

  const client = spawnBridgeClient({
    BB_TEST_DATA_DIR: scratch,
    BB_TEST_TEMP_DIR: scratch,
  });

  try {
    const init = await client.request("initialize", {
      protocolVersion: 2,
      grammarVersions: [3, 3],
      client: { name: "bb-test", version: "0.0.1" },
    });
    const initResult = init["result"] as {
      protocolVersion: number;
      capabilities: { grammarVersions: number[] };
    };
    assert.equal(initResult.protocolVersion, 2);
    assert.deepEqual(initResult.capabilities.grammarVersions, [3, 3]);

    // Missing executable -> install action points to official installer.
    const missingStatus = await client.request("provider/installation/status", {
      providerId: "antigravity",
      checkUpdates: false,
      providerOptions: {
        acpDialect: "antigravity",
        acpLaunchSpec: {
          displayName: "Antigravity",
          command: "definitely-not-installed-agy-xyz",
          args: ["acp"],
          env: {},
        },
      },
    });
    const missing = missingStatus["result"] as {
      installed: boolean;
      installAction: { kind: string; command: string } | null;
    };
    assert.equal(missing.installed, false);
    assert.equal(missing.installAction?.kind, "install");
    assert.match(missing.installAction?.command ?? "", /antigravity\.google\/cli\/install\.sh/);

    // Installed fake binary -> version + update action (`agy update`).
    const installedOptions = {
      acpDialect: "antigravity",
      acpLaunchSpec: {
        displayName: "Antigravity",
        command: fakeAgy,
        args: ["acp"],
        env: {},
      },
    };
    const installedStatus = await client.request("provider/installation/status", {
      providerId: "antigravity",
      checkUpdates: false,
      providerOptions: installedOptions,
    });
    const installed = installedStatus["result"] as {
      installed: boolean;
      currentVersion: string | null;
      installAction: { kind: string; command: string } | null;
    };
    assert.equal(installed.installed, true);
    assert.equal(installed.currentVersion, "1.5.17");
    assert.equal(installed.installAction?.kind, "update");
    assert.equal(installed.installAction?.command, "agy update");

    const updateRun = await client.request("provider/installation/run", {
      providerId: "antigravity",
      action: "update",
      providerOptions: installedOptions,
    });
    const updateResult = updateRun["result"] as {
      available: boolean;
      command?: { command: string; args: string[]; displayCommand: string };
    };
    assert.equal(updateResult.available, true);
    assert.deepEqual(updateResult.command, {
      command: fakeAgy,
      args: ["update"],
      displayCommand: "agy update",
    });

    // Health and quota via the registered `antigravity` dialect.
    const health = await client.request("provider/health", {
      providerId: "antigravity",
      providerOptions: installedOptions,
    });
    const healthResult = health["result"] as {
      supported: boolean;
      health: { status: string; installedVersion: string | null; loginCommand: string | null };
    };
    assert.equal(healthResult.supported, true);
    assert.equal(healthResult.health.status, "ready");
    assert.equal(healthResult.health.installedVersion, "1.5.17");
    assert.equal(healthResult.health.loginCommand, "agy acp --login");

    const usage = await client.request("provider/usage", {
      providerId: "antigravity",
      providerOptions: installedOptions,
    });
    const usageResult = usage["result"] as {
      supported: boolean;
      usage: {
        status: string;
        windows: { label: string; usedPercent: number; resetsAt: string | null }[];
      };
    };
    assert.equal(usageResult.supported, true);
    assert.equal(usageResult.usage.status, "ok");
    assert.deepEqual(usageResult.usage.windows, [
      { label: "Gemini 5-hour", usedPercent: 30, resetsAt: "2026-11-26T08:59:22.000Z" },
      { label: "Gemini weekly", usedPercent: 10, resetsAt: "2026-12-02T21:46:18.000Z" },
    ]);
  } finally {
    await client.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
