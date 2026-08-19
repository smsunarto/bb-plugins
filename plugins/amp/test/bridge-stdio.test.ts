// Smoke test: spawn the built bridge bundle and do a raw JSON-RPC
// initialize round-trip over stdio. Skips when dist/bridge.js is unbuilt.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BRIDGE_BUILD_HINT } from "../lib/provision.ts";
import { AMP_ACP_EXECUTOR_ENV } from "../src/execution-target.ts";

const BRIDGE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "bridge.js");

function bridgeEnv(executor?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (executor === undefined) {
    delete env[AMP_ACP_EXECUTOR_ENV];
  } else {
    env[AMP_ACP_EXECUTOR_ENV] = executor;
  }
  return env;
}

function nextResponse(child: ReturnType<typeof spawn>): Promise<{
  id: number;
  result?: unknown;
  error?: { message?: string };
}> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`bridge exited before its JSON-RPC response (code ${code})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for JSON-RPC response"));
    }, 10_000);
    timeout.unref();
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

async function initializeBridge(executor?: string): Promise<{
  parsed: {
    id: number;
    result?: {
      protocolVersion?: number;
      agentCapabilities?: {
        loadSession?: boolean;
        mcpCapabilities?: { http?: boolean; sse?: boolean };
      };
    };
    error?: unknown;
  };
  child: ReturnType<typeof spawn>;
}> {
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: bridgeEnv(executor),
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const responseLine = new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(buffer.slice(0, newline));
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      reject(
        new Error(`bridge exited early (code ${code}): ${Buffer.concat(stderr).toString("utf8")}`),
      ),
    );
    setTimeout(
      () => reject(new Error("timed out waiting for initialize response")),
      10_000,
    ).unref();
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "bb", version: "1.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
    })}\n`,
  );

  try {
    return { parsed: JSON.parse(await responseLine), child };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

test(
  "bundled bridge answers initialize over stdio",
  { skip: !existsSync(BRIDGE) && `dist/bridge.js not built; ${BRIDGE_BUILD_HINT}` },
  async () => {
    const { parsed, child } = await initializeBridge();
    try {
      assert.equal(parsed.id, 1);
      assert.equal(parsed.error, undefined);
      assert.equal(parsed.result?.protocolVersion, 1);
      assert.equal(parsed.result?.agentCapabilities?.loadSession, true);
    } finally {
      child.kill("SIGKILL");
    }
  },
);

test(
  "bundled bridge ignores the deprecated executor environment",
  { skip: !existsSync(BRIDGE) && `dist/bridge.js not built; ${BRIDGE_BUILD_HINT}` },
  async () => {
    const { parsed, child } = await initializeBridge("orb");
    try {
      assert.equal(parsed.error, undefined);
      assert.deepEqual(parsed.result?.agentCapabilities?.mcpCapabilities, {
        http: true,
        sse: true,
      });
    } finally {
      child.kill("SIGKILL");
    }
  },
);

test(
  "bundled bridge ignores an empty deprecated executor environment",
  { skip: !existsSync(BRIDGE) && `dist/bridge.js not built; ${BRIDGE_BUILD_HINT}` },
  async () => {
    const { parsed, child } = await initializeBridge("");
    try {
      assert.equal(parsed.error, undefined);
      assert.deepEqual(parsed.result?.agentCapabilities?.mcpCapabilities, {
        http: true,
        sse: true,
      });
    } finally {
      child.kill("SIGKILL");
    }
  },
);

test(
  "bundled bridge rejects bb's session/new fallback after a missing load",
  { skip: !existsSync(BRIDGE) && `dist/bridge.js not built; ${BRIDGE_BUILD_HINT}` },
  async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "amp-stdio-state-"));
    const child = spawn(process.execPath, [BRIDGE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...bridgeEnv(),
        XDG_STATE_HOME: stateHome,
      },
    });
    try {
      let response = nextResponse(child);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientInfo: { name: "bb", version: "1.0.0" },
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          },
        })}\n`,
      );
      assert.equal((await response).error, undefined);

      response = nextResponse(child);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/load",
          params: { sessionId: "S-missing", cwd: "/work", mcpServers: [] },
        })}\n`,
      );
      assert.ok((await response).error, "the missing session/load must fail");

      response = nextResponse(child);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "session/new",
          params: { cwd: "/work", mcpServers: [] },
        })}\n`,
      );
      assert.ok((await response).error, "the fallback session/new must also fail");
    } finally {
      child.kill("SIGKILL");
      rmSync(stateHome, { recursive: true, force: true });
    }
  },
);
