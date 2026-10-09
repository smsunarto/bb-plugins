// The bridge runs on the thread's host and spawns that host's Amp CLI. A
// configured path that does not exist there (a path from another machine)
// must give way to the host's own search, the same way maintenance requests
// already resolve the CLI.
import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { BRIDGE_REQUEST_METHODS } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge, handleLine } from "../src/bridge/entry.ts";

test("a session spawns this host's Amp CLI, not a stale configured path", async () => {
  const root = mkdtempSync(join(tmpdir(), "amp-cli-path-"));
  const bin = join(root, "bin");
  const dataDir = join(root, "data");
  const tempDir = join(root, "temp");
  const workspace = join(root, "workspace");
  for (const dir of [bin, dataDir, tempDir, workspace]) mkdirSync(dir, { recursive: true });
  const marker = join(root, "spawned");
  const cli = join(bin, "amp");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s' "$0" > '${marker}'\n`, "utf8");
  chmodSync(cli, 0o755);
  const previous = { PATH: process.env.PATH, AMP_CLI_PATH: process.env.AMP_CLI_PATH };
  process.env.PATH = `${bin}${delimiter}${previous.PATH ?? ""}`;
  delete process.env.AMP_CLI_PATH;
  const output = captureBridgeJsonRpcOutput();
  try {
    experimental_providerBridge.start?.({ pluginId: "amp", dataDir, tempDir });
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: BRIDGE_REQUEST_METHODS.threadStart,
        params: {
          threadId: "thr_cli_path",
          cwd: workspace,
          instructionMode: "append",
          input: [{ type: "text", text: "say hello", mentions: [] }],
          options: {
            permissionMode: "auto",
            permissionScope: "workspace",
            approvalReviewer: "automatic",
            permissionEscalation: "ask",
            providerOptions: { ampCliPath: "/home/codex/.local/bin/amp-from-the-server" },
          },
        },
      }),
    );
    const deadline = Date.now() + 4_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(marker) ? readFileSync(marker, "utf8") : "never spawned", cli);
  } finally {
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: BRIDGE_REQUEST_METHODS.threadStop,
        params: {
          threadId: "thr_cli_path",
          providerThreadId: "unused",
          activeTurnId: null,
          intent: "interrupt",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    output.restore();
    process.env.PATH = previous.PATH;
    if (previous.AMP_CLI_PATH === undefined) delete process.env.AMP_CLI_PATH;
    else process.env.AMP_CLI_PATH = previous.AMP_CLI_PATH;
    rmSync(root, { recursive: true, force: true });
  }
});
