import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deriveTunnelStatus,
  discoverCloudflared,
  extractTryCloudflareOrigin,
  installTunnelRuntime,
  parseTunnelDesiredConfig,
  parseTunnelObservation,
  renderTunnelDesiredConfig,
  resolveTunnelHostRuntime,
  type BundledTunnelRuntime,
} from "../lib/cloudflare-tunnel.ts";
import type { ServiceSnapshot } from "../lib/persistent-service.ts";

const runningService: ServiceSnapshot = {
  state: "running",
  pid: 4100,
  loaded: true,
  crashCount: 0,
  lastExit: null,
};

test("discovers an executable cloudflared as an absolute canonical path", () => {
  const executablePaths = new Set(["/custom/bin/cloudflared", "/opt/homebrew/bin/cloudflared"]);
  assert.deepEqual(
    discoverCloudflared({
      path: "/missing:/custom/bin",
      platform: "darwin",
      executable: (path) => executablePaths.has(path),
      realpath: (path) => `/canonical${path}`,
    }),
    { state: "found", path: "/canonical/custom/bin/cloudflared" },
  );
  const fallback = discoverCloudflared({
    path: "",
    platform: "darwin",
    executable: (path) => executablePaths.has(path),
    realpath: (path) => path,
  });
  assert.deepEqual(fallback, { state: "found", path: "/opt/homebrew/bin/cloudflared" });
});

test("missing cloudflared is an actionable state", () => {
  const result = discoverCloudflared({
    path: "/missing",
    platform: "darwin",
    executable: () => false,
  });
  assert.equal(result.state, "missing");
  if (result.state === "missing") assert.match(result.detail, /brew install cloudflared/);
});

test("resolves one stable host runtime and its required service environment", () => {
  assert.deepEqual(
    resolveTunnelHostRuntime({
      platform: "darwin",
      execPath: "/Applications/bb.app/Contents/MacOS/bb",
      electronVersion: "40.0.0",
      realpath: (path) => path,
    }),
    {
      executablePath: "/Applications/bb.app/Contents/MacOS/bb",
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  assert.deepEqual(
    resolveTunnelHostRuntime({
      platform: "linux",
      execPath: "/tmp/.mount_bb/bb",
      appImagePath: "/opt/bb.AppImage",
      executable: (path) => path === "/opt/bb.AppImage",
      realpath: (path) => path,
    }),
    { executablePath: "/opt/bb.AppImage", environment: {} },
  );
});

test("parses desired config and rejects relative executable or key paths", () => {
  const config = {
    version: 1,
    corePort: 8317,
    cloudflaredPath: "/usr/local/bin/cloudflared",
    localApiKeyPath: "/tmp/local-api-key",
  } as const;
  assert.deepEqual(parseTunnelDesiredConfig(config), config);
  assert.deepEqual(JSON.parse(renderTunnelDesiredConfig(config)), config);
  assert.equal(parseTunnelDesiredConfig({ ...config, corePort: 0 }), null);
  assert.equal(parseTunnelDesiredConfig({ ...config, cloudflaredPath: "cloudflared" }), null);
  assert.equal(parseTunnelDesiredConfig({ ...config, localApiKeyPath: "local-api-key" }), null);
});

test("extracts only a valid Quick Tunnel origin", () => {
  assert.equal(
    extractTryCloudflareOrigin(
      "INF Your quick Tunnel has been created! Visit it at https://swift-river.trycloudflare.com",
    ),
    "https://swift-river.trycloudflare.com",
  );
  assert.equal(extractTryCloudflareOrigin("https://trycloudflare.com.example.test"), null);
  assert.equal(extractTryCloudflareOrigin("https://swift-river.trycloudflare.com.evil.test"), null);
});

test("parses observation variants without accepting invalid origins", () => {
  const shared = { version: 1, ownerPid: 4100, sessionId: "session", updatedAt: 123 } as const;
  assert.deepEqual(parseTunnelObservation({ ...shared, phase: "starting" }), {
    ...shared,
    phase: "starting",
  });
  assert.deepEqual(
    parseTunnelObservation({
      ...shared,
      phase: "ready",
      cloudflaredPid: 4200,
      publicOrigin: "https://swift-river.trycloudflare.com",
    }),
    {
      ...shared,
      phase: "ready",
      cloudflaredPid: 4200,
      publicOrigin: "https://swift-river.trycloudflare.com",
    },
  );
  assert.equal(
    parseTunnelObservation({
      ...shared,
      phase: "ready",
      cloudflaredPid: 4200,
      publicOrigin: "https://example.com",
    }),
    null,
  );
});

test("derives ready only from an observation owned by the live service", () => {
  const observation = {
    version: 1,
    phase: "ready",
    ownerPid: 4100,
    sessionId: "session",
    cloudflaredPid: 4200,
    publicOrigin: "https://swift-river.trycloudflare.com",
    updatedAt: 123,
  } as const;
  const ready = deriveTunnelStatus({
    enabled: true,
    coreDesiredRunning: true,
    coreLoaded: true,
    discovery: { state: "found", path: "/usr/local/bin/cloudflared" },
    preparationError: null,
    service: runningService,
    observation,
  });
  assert.deepEqual(ready, {
    state: "ready",
    pid: 4100,
    openaiBaseUrl: "https://swift-river.trycloudflare.com/v1",
  });

  const stale = deriveTunnelStatus({
    enabled: true,
    coreDesiredRunning: true,
    coreLoaded: true,
    discovery: { state: "found", path: "/usr/local/bin/cloudflared" },
    preparationError: null,
    service: { ...runningService, pid: 5000 },
    observation,
  });
  assert.equal(stale.state, "running-without-url");
  assert.equal("openaiBaseUrl" in stale, false);
});

test("disabled status wins before cloudflared discovery", () => {
  assert.deepEqual(
    deriveTunnelStatus({
      enabled: false,
      coreDesiredRunning: false,
      coreLoaded: false,
      discovery: null,
      preparationError: null,
      service: { ...runningService, loaded: false, pid: null, state: "stopped" },
      observation: null,
    }),
    { state: "disabled" },
  );
});

test("disabled status waits for the service to stop and reports stop failures", () => {
  const shared = {
    enabled: false,
    coreDesiredRunning: false,
    coreLoaded: false,
    discovery: null,
    preparationError: null,
    observation: null,
  } as const;
  assert.deepEqual(deriveTunnelStatus({ ...shared, service: runningService }), {
    state: "stopping",
    pid: 4100,
    detail: "Waiting for the operating system to stop the public tunnel.",
  });
  assert.deepEqual(
    deriveTunnelStatus({
      ...shared,
      stopError: "Could not stop the public tunnel: launchctl failed",
      service: runningService,
    }),
    {
      state: "crashed",
      lastExit: null,
      detail: "Could not stop the public tunnel: launchctl failed",
    },
  );
});

test("derives actionable missing-binary and stopped states", () => {
  const missing = deriveTunnelStatus({
    enabled: true,
    coreDesiredRunning: true,
    coreLoaded: true,
    discovery: { state: "missing", detail: "install cloudflared" },
    preparationError: null,
    service: { ...runningService, loaded: false, pid: null, state: "stopped" },
    observation: null,
  });
  assert.deepEqual(missing, { state: "missing-binary", detail: "install cloudflared" });

  const stopped = deriveTunnelStatus({
    enabled: true,
    coreDesiredRunning: true,
    coreLoaded: false,
    discovery: { state: "found", path: "/usr/local/bin/cloudflared" },
    preparationError: null,
    service: { ...runningService, loaded: false, pid: null, state: "stopped" },
    observation: null,
  });
  assert.deepEqual(stopped, { state: "stopped", reason: "core-stopped" });
});

test("installs a content-addressed runtime and validates it with the host executable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-tunnel-runtime-"));
  const content = Buffer.from("export const value = 1;\n");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const runtime: BundledTunnelRuntime = {
    sourcePath: "/source/cloudflare-tunnel-runtime.mjs",
    content,
    sha256,
    targetPath: join(dir, `cloudflare-tunnel-runtime-${sha256}.mjs`),
  };
  const calls: {
    file: string;
    args: string[];
    environment: Readonly<Record<string, string>>;
  }[] = [];
  const result = await installTunnelRuntime({
    runtime,
    hostRuntime: {
      executablePath: "/host/runtime",
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    },
    commandRunner: async (file, args, environment) => {
      calls.push({ file, args, environment });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(result, { state: "ready", runtimePath: runtime.targetPath });
  assert.equal(existsSync(runtime.targetPath), true);
  assert.deepEqual(readFileSync(runtime.targetPath), content);
  assert.deepEqual(calls, [
    {
      file: "/host/runtime",
      args: [runtime.targetPath, "helper", "--self-test"],
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    },
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("reports a host runtime self-test failure as a blocked state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-tunnel-runtime-blocked-"));
  const content = Buffer.from("invalid for this host\n");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const runtime: BundledTunnelRuntime = {
    sourcePath: "/source/cloudflare-tunnel-runtime.mjs",
    content,
    sha256,
    targetPath: join(dir, `cloudflare-tunnel-runtime-${sha256}.mjs`),
  };
  const result = await installTunnelRuntime({
    runtime,
    hostRuntime: { executablePath: "/host/runtime", environment: {} },
    commandRunner: async () => ({ code: 1, stdout: "", stderr: "unsupported syntax" }),
  });
  assert.deepEqual(result, {
    state: "blocked",
    detail: "/host/runtime cannot run the Cloudflare tunnel helper: unsupported syntax",
  });
  rmSync(dir, { recursive: true, force: true });
});
