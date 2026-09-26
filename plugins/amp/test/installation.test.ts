import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_REQUEST_METHODS,
  providerInstallationRunResultSchema,
  providerInstallationStatusSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "../src/bridge/entry.ts";
import { getAmpInstallationStatus, runAmpInstallation } from "../src/bridge/installation.ts";

const INSTALLER =
  'tmp=$(mktemp "${TMPDIR:-/tmp}/provider-installation.XXXXXX") && ' +
  "trap 'rm -f \"$tmp\"' EXIT && " +
  'curl -fsSL https://ampcode.com/install.sh -o "$tmp" && bash "$tmp"';

// A host with no Amp CLI: an empty HOME and PATH, so neither PATH nor the
// installer's ~/.amp/bin and ~/.local/bin hold one. Restored after each test.
let root: string;
let saved: Record<"HOME" | "PATH" | "AMP_CLI_PATH", string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amp-installation-"));
  saved = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    AMP_CLI_PATH: process.env.AMP_CLI_PATH,
  };
  process.env.HOME = join(root, "home");
  process.env.PATH = join(root, "empty-bin");
  delete process.env.AMP_CLI_PATH;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Put an Amp CLI where Amp's installer does, answering `--version`. */
function installFakeAmp(): string {
  const bin = join(root, "home", ".amp", "bin");
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, "amp");
  writeFileSync(cli, "#!/bin/sh\necho '0.0.1786133514-gc956d5 (released 2026-08-07)'\n", "utf8");
  chmodSync(cli, 0o755);
  return cli;
}

let nextId = 100;

async function request(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  const output = captureBridgeJsonRpcOutput();
  try {
    handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const reply = output.takeMessages().find((message) => message.id === id);
      if (reply !== undefined) return reply as unknown as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no ${method} reply within 5s`);
  } finally {
    output.restore();
  }
}

test("a host without Amp reports not installed with the install script as the action", async () => {
  const reply = await request(BRIDGE_REQUEST_METHODS.providerInstallationStatus, {
    providerId: "acp-amp",
  });
  const status = providerInstallationStatusSchema.parse(reply.result);
  assert.deepEqual(status, {
    executableName: "amp",
    executablePath: null,
    installed: false,
    installSource: "notInstalled",
    currentVersion: null,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: { kind: "install", label: "Install", command: INSTALLER },
    needsUpdate: false,
    versionUnsupported: false,
  });
});

test("install runs Amp's install script and bb verifies the CLI is then found", async () => {
  const reply = await request(BRIDGE_REQUEST_METHODS.providerInstallationRun, {
    providerId: "acp-amp",
    action: "install",
  });
  assert.deepEqual(providerInstallationRunResultSchema.parse(reply.result), {
    available: true,
    command: { command: "sh", args: ["-c", INSTALLER], displayCommand: INSTALLER },
    verification: { kind: "installed" },
  });
});

test("an Amp CLI in ~/.amp/bin is found off PATH, with its version and no action", async () => {
  const cli = installFakeAmp();
  const reply = await request(BRIDGE_REQUEST_METHODS.providerInstallationStatus, {
    providerId: "acp-amp",
    // A stale registration-time path is superseded by the fresh search.
    providerOptions: { ampCliPath: join(root, "gone", "amp") },
  });
  const status = providerInstallationStatusSchema.parse(reply.result);
  assert.equal(status.installed, true);
  assert.equal(status.executablePath, cli);
  assert.equal(status.installSource, "external");
  assert.equal(status.currentVersion, "0.0.1786133514-gc956d5");
  assert.equal(status.installAction, null);
});

test("install and update are unavailable once Amp is installed", async () => {
  const cli = installFakeAmp();
  assert.deepEqual(await runAmpInstallation(cli, "install"), {
    available: false,
    message: "Amp is already installed on this host.",
  });
  assert.deepEqual(await runAmpInstallation(cli, "update"), {
    available: false,
    message: "Amp updates itself in the background; restart Amp threads to pick up a new version.",
  });
});

test("Windows gets no install action: Amp runs there through WSL", async () => {
  const status = await getAmpInstallationStatus(null, "win32");
  assert.equal(status.installed, false);
  assert.equal(status.installAction, null);
  assert.deepEqual(await runAmpInstallation(null, "install", "win32"), {
    available: false,
    message: "Amp runs on Windows through WSL. Install it inside WSL with Amp's install script.",
  });
});

test("model/list rejects with MISSING_EXECUTABLE when there is no Amp CLI", async () => {
  const reply = await request(BRIDGE_REQUEST_METHODS.modelList, {});
  const error = reply.error as { code: number; message: string };
  assert.equal(error.code, BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE);
  assert.equal(
    error.message,
    `Could not find the Amp CLI on this host. Install it with \`${INSTALLER}\` and retry.`,
  );
});
