import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGateway } from "../lib/cloudflare-tunnel-runtime.mjs";

interface CoreRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface GatewayResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("test server did not return a TCP address"));
      } else {
        resolvePort(address.port);
      }
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}

function requestGateway(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: readonly string[];
}): Promise<GatewayResponse> {
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolveResponse({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      },
    );
    request.once("error", reject);
    for (const chunk of options.body ?? []) request.write(chunk);
    request.end();
  });
}

function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolveResponse, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(request));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolveResponse(response));
    socket.once("error", reject);
  });
}

async function waitFor<T>(read: () => T | null, detail: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`timed out waiting for ${detail}`);
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the tunnel helper did not exit after SIGTERM"));
    }, 5_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

function eventWithin<T>(promise: Promise<T>, detail: string, timeoutMs = 1_000): Promise<T> {
  return new Promise((resolveEvent, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for ${detail}`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        return resolveEvent(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        return reject(error);
      },
    );
  });
}

function gatewayFixture(dir: string, corePort: number) {
  const key = "unit-test-local-key";
  const keyPath = join(dir, "local-api-key");
  const configPath = join(dir, "desired.json");
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  writeFileSync(
    configPath,
    `${JSON.stringify({
      version: 1,
      corePort,
      cloudflaredPath: join(dir, "cloudflared"),
      localApiKeyPath: keyPath,
    })}\n`,
    { mode: 0o600 },
  );
  return { configPath, key };
}

test("the gateway returns 503 and closes an idle upstream before headers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-gateway-idle-"));
  let closeUpstream!: () => void;
  const upstreamClosed = new Promise<void>((resolveClosed) => {
    closeUpstream = resolveClosed;
  });
  const core = createServer((request) => {
    request.resume();
    request.socket.once("close", closeUpstream);
  });
  const corePort = await listen(core);
  const { configPath, key } = gatewayFixture(dir, corePort);
  const gateway = createGateway(configPath, { upstreamIdleTimeoutMs: 25 });
  const gatewayPort = await listen(gateway);

  try {
    const response = await eventWithin(
      requestGateway({
        port: gatewayPort,
        path: "/v1/models",
        headers: { authorization: `Bearer ${key}` },
      }),
      "gateway idle timeout",
    );
    assert.equal(response.status, 503);
    assert.equal(response.body, "CLIProxyAPI is temporarily unavailable\n");
    await eventWithin(upstreamClosed, "idle upstream cleanup");
  } finally {
    gateway.closeAllConnections?.();
    core.closeAllConnections?.();
    await Promise.all([close(gateway), close(core)]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gateway destroys upstream work when the downstream disconnects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-gateway-downstream-close-"));
  let acceptUpstream!: () => void;
  const upstreamAccepted = new Promise<void>((resolveAccepted) => {
    acceptUpstream = resolveAccepted;
  });
  let closeUpstream!: () => void;
  const upstreamClosed = new Promise<void>((resolveClosed) => {
    closeUpstream = resolveClosed;
  });
  const core = createServer((request) => {
    request.resume();
    request.socket.once("close", closeUpstream);
    acceptUpstream();
  });
  const corePort = await listen(core);
  const { configPath, key } = gatewayFixture(dir, corePort);
  const gateway = createGateway(configPath, { upstreamIdleTimeoutMs: 5_000 });
  const gatewayPort = await listen(gateway);
  const downstream = httpRequest({
    host: "127.0.0.1",
    port: gatewayPort,
    path: "/v1/models",
    headers: { authorization: `Bearer ${key}` },
  });
  downstream.on("error", () => {});
  downstream.end();

  try {
    await eventWithin(upstreamAccepted, "upstream request acceptance");
    downstream.destroy();
    await eventWithin(upstreamClosed, "downstream-close upstream cleanup");
  } finally {
    downstream.destroy();
    gateway.closeAllConnections?.();
    core.closeAllConnections?.();
    await Promise.all([close(gateway), close(core)]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "the helper retries cloudflared and enforces the loopback gateway boundary",
  { timeout: 20_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-proxy-tunnel-integration-"));
    const keyPath = join(dir, "local-api-key");
    const configPath = join(dir, "desired.json");
    const observationPath = join(dir, "observation.json");
    const fakeStatePath = join(dir, "fake-cloudflared.json");
    const terminatedPath = join(dir, "cloudflared-terminated");
    const cloudflaredPath = join(dir, "cloudflared.mjs");
    const fakeHome = join(dir, "home");
    const runtimePath = fileURLToPath(
      new URL("../lib/cloudflare-tunnel-runtime.mjs", import.meta.url),
    );
    const localApiKey = "unit-test-local-key";
    writeFileSync(keyPath, `${localApiKey}\n`, { mode: 0o600 });
    mkdirSync(join(fakeHome, ".cloudflared"), { recursive: true });
    writeFileSync(join(fakeHome, ".cloudflared", "config.yaml"), "tunnel: user-config\n");
    writeFileSync(
      cloudflaredPath,
      `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const statePath = process.env.FAKE_CLOUDFLARED_STATE;
const terminatedPath = process.env.FAKE_CLOUDFLARED_TERMINATED;
const previous = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { attempts: 0 };
const state = { attempts: previous.attempts + 1, gatewayUrl: process.argv.at(-1), args: process.argv.slice(2) };
writeFileSync(statePath, JSON.stringify(state));
if (state.attempts === 1) process.exit(7);
process.stderr.write("Quick Tunnel: https://unit-test.trycloudflare.com\\n");
if (state.attempts === 2) setTimeout(() => process.exit(8), 25);
process.on("SIGTERM", () => {
  writeFileSync(terminatedPath, "terminated\\n");
  process.exit(0);
});
setInterval(() => {}, 10_000);
`,
      { mode: 0o700 },
    );
    chmodSync(cloudflaredPath, 0o700);

    const coreRequests: CoreRequest[] = [];
    const core = createServer((request, response) => {
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        coreRequests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body,
        });
        response.writeHead(200, {
          "content-type": "text/plain",
          connection: "x-upstream-private",
          "x-upstream-private": "remove-me",
        });
        response.write("core:");
        setImmediate(() => response.end(`${request.method}:${request.url}:${body}`));
      });
    });
    const corePort = await listen(core);
    const writeConfig = (port: number) => {
      const temporary = `${configPath}.tmp`;
      writeFileSync(
        temporary,
        `${JSON.stringify({
          version: 1,
          corePort: port,
          cloudflaredPath,
          localApiKeyPath: keyPath,
        })}\n`,
        { mode: 0o600 },
      );
      renameSync(temporary, configPath);
    };
    writeConfig(corePort);

    let helperError = "";
    const helperStartedAt = Date.now();
    const helper = spawn(
      process.execPath,
      [runtimePath, "helper", "--config", configPath, "--observation", observationPath],
      {
        env: {
          ...process.env,
          HOME: fakeHome,
          FAKE_CLOUDFLARED_STATE: fakeStatePath,
          FAKE_CLOUDFLARED_TERMINATED: terminatedPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", (chunk) => {
      helperError += chunk;
    });

    let secondCore: ReturnType<typeof createServer> | null = null;
    try {
      const observation = await waitFor(() => {
        if (!existsSync(observationPath) || !existsSync(fakeStatePath)) return null;
        const state = JSON.parse(readFileSync(fakeStatePath, "utf8")) as { attempts?: number };
        if ((state.attempts ?? 0) < 3) return null;
        const value = JSON.parse(readFileSync(observationPath, "utf8")) as {
          phase?: string;
          ownerPid?: number;
          publicOrigin?: string;
        };
        return value.phase === "ready" ? value : null;
      }, "a ready tunnel observation");
      const fakeState = JSON.parse(readFileSync(fakeStatePath, "utf8")) as {
        attempts: number;
        gatewayUrl: string;
        args: string[];
      };
      assert.equal(fakeState.attempts, 3);
      assert.ok(Date.now() - helperStartedAt >= 2_700);
      assert.deepEqual(fakeState.args.slice(0, 5), [
        "tunnel",
        "--config",
        "/dev/null",
        "--no-autoupdate",
        "--url",
      ]);
      assert.equal(observation.ownerPid, helper.pid);
      assert.equal(observation.publicOrigin, "https://unit-test.trycloudflare.com");
      const gatewayPort = Number.parseInt(new URL(fakeState.gatewayUrl).port, 10);

      const headers = {
        authorization: `Bearer ${localApiKey}`,
        host: "public.example.test",
        forwarded: "for=203.0.113.10",
        "x-forwarded-for": "203.0.113.10",
        "cf-connecting-ip": "203.0.113.10",
        "cf-connecting-ipv6": "2001:db8::1",
        "cf-pseudo-ipv4": "192.0.2.1",
        "cf-ew-via": "cloudflare",
        "cf-connecting-o2o": "1",
        "cf-worker": "worker.example",
        via: "1.1 proxy.example",
        connection: "keep-alive, x-remove, authorization",
        "x-remove": "private",
      };
      const models = await requestGateway({
        port: gatewayPort,
        path: "/v1/models?limit=1",
        headers,
      });
      assert.equal(models.status, 200);
      assert.equal(models.body, "core:GET:/v1/models?limit=1:");
      assert.equal(models.headers["x-upstream-private"], undefined);
      assert.equal(coreRequests[0]?.headers.host, `127.0.0.1:${corePort}`);
      assert.equal(coreRequests[0]?.headers.authorization, `Bearer ${localApiKey}`);
      assert.equal(coreRequests[0]?.headers.forwarded, undefined);
      assert.equal(coreRequests[0]?.headers["x-forwarded-for"], undefined);
      assert.equal(coreRequests[0]?.headers["cf-connecting-ip"], undefined);
      for (const name of [
        "cf-connecting-ipv6",
        "cf-pseudo-ipv4",
        "cf-ew-via",
        "cf-connecting-o2o",
        "cf-worker",
        "via",
      ]) {
        assert.equal(coreRequests[0]?.headers[name], undefined, name);
      }
      assert.equal(coreRequests[0]?.headers["x-remove"], undefined);

      const chat = await requestGateway({
        port: gatewayPort,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { authorization: `Bearer ${localApiKey}` },
        body: ["hello", " world"],
      });
      assert.equal(chat.status, 200);
      assert.equal(coreRequests.at(-1)?.body, "hello world");
      const responses = await requestGateway({
        port: gatewayPort,
        path: "/v1/responses",
        method: "POST",
        headers: { authorization: `Bearer ${localApiKey}` },
        body: ["response body"],
      });
      assert.equal(responses.status, 200);

      for (const [path, expectedStatus] of [
        ["/", 404],
        ["/management", 404],
        ["/v1/%2e%2e/admin", 400],
        ["/v1%2fadmin", 400],
        ["/v1/%2525252fadmin", 400],
        ["http://example.test/v1/models", 400],
        ["//example.test/v1/models", 400],
      ] as const) {
        const before = coreRequests.length;
        const rejected = await requestGateway({
          port: gatewayPort,
          path,
          headers: { authorization: `Bearer ${localApiKey}` },
        });
        assert.equal(rejected.status, expectedStatus, path);
        assert.equal(coreRequests.length, before, path);
      }

      const beforeUnauthorized = coreRequests.length;
      const unauthorized = await requestGateway({
        port: gatewayPort,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { authorization: "Bearer wrong-key" },
        body: ["must not reach the core"],
      });
      assert.equal(unauthorized.status, 401);
      assert.equal(coreRequests.length, beforeUnauthorized);

      const beforeContinue = coreRequests.length;
      const refusedContinue = await rawRequest(
        gatewayPort,
        "POST /v1/responses HTTP/1.1\r\n" +
          "Host: public.example.test\r\n" +
          "Authorization: Bearer wrong-key\r\n" +
          "Expect: 100-continue\r\n" +
          "Content-Length: 10\r\n\r\n",
      );
      assert.match(refusedContinue, /^HTTP\/1\.1 401 /);
      assert.doesNotMatch(refusedContinue, /HTTP\/1\.1 100 Continue/);
      assert.equal(coreRequests.length, beforeContinue);

      const beforeMissingKey = coreRequests.length;
      const hiddenKeyPath = `${keyPath}.hidden`;
      renameSync(keyPath, hiddenKeyPath);
      const missingKey = await requestGateway({
        port: gatewayPort,
        path: "/v1/models",
        headers: { authorization: `Bearer ${localApiKey}` },
      });
      renameSync(hiddenKeyPath, keyPath);
      assert.equal(missingKey.status, 503);
      assert.equal(coreRequests.length, beforeMissingKey);

      const upgrade = await requestGateway({
        port: gatewayPort,
        path: "/v1/models",
        headers: {
          authorization: `Bearer ${localApiKey}`,
          connection: "upgrade",
          upgrade: "websocket",
        },
      });
      assert.equal(upgrade.status, 426);

      const secondCoreRequests: CoreRequest[] = [];
      secondCore = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          secondCoreRequests.push({
            method: request.method ?? "",
            url: request.url ?? "",
            headers: request.headers,
            body: "",
          });
          response.end("second core");
        });
      });
      const secondCorePort = await listen(secondCore);
      writeConfig(secondCorePort);
      const afterPortChange = await requestGateway({
        port: gatewayPort,
        path: "/v1/models",
        headers: { authorization: `Bearer ${localApiKey}` },
      });
      assert.equal(afterPortChange.body, "second core");
      assert.equal(secondCoreRequests.length, 1);
      const sameObservation = JSON.parse(readFileSync(observationPath, "utf8")) as {
        ownerPid: number;
        publicOrigin: string;
      };
      assert.equal(sameObservation.ownerPid, observation.ownerPid);
      assert.equal(sameObservation.publicOrigin, observation.publicOrigin);

      await close(secondCore);
      secondCore = null;
      const unavailable = await requestGateway({
        port: gatewayPort,
        path: "/v1/models",
        headers: { authorization: `Bearer ${localApiKey}` },
      });
      assert.equal(unavailable.status, 503);
    } finally {
      if (secondCore !== null) await close(secondCore);
      await close(core);
      const exit = waitForExit(helper);
      helper.kill("SIGTERM");
      const exitCode = await exit;
      assert.equal(exitCode, 0, helperError);
    }

    await waitFor(() => (existsSync(terminatedPath) ? true : null), "cloudflared cleanup");
    assert.equal(existsSync(observationPath), false);
    rmSync(dir, { recursive: true, force: true });
  },
);

test(
  "a ready-observation write failure still terminates cloudflared",
  { timeout: 10_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-proxy-tunnel-observation-failure-"));
    const keyPath = join(dir, "local-api-key");
    const configPath = join(dir, "desired.json");
    const observationDir = join(dir, "observation-dir");
    const observationPath = join(observationDir, "observation.json");
    const terminatedPath = join(dir, "cloudflared-terminated");
    const cloudflaredPath = join(dir, "cloudflared.mjs");
    const runtimePath = fileURLToPath(
      new URL("../lib/cloudflare-tunnel-runtime.mjs", import.meta.url),
    );
    writeFileSync(keyPath, "unit-test-local-key\n", { mode: 0o600 });
    writeFileSync(
      cloudflaredPath,
      `#!${process.execPath}
import { rmSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(process.env.FAKE_CLOUDFLARED_TERMINATED, "terminated\\n");
  process.exit(0);
});
rmSync(process.env.FAKE_OBSERVATION_DIR, { recursive: true, force: true });
writeFileSync(process.env.FAKE_OBSERVATION_DIR, "not a directory");
process.stderr.write("Quick Tunnel: https://unit-test.trycloudflare.com\\n");
setInterval(() => {}, 10_000);
`,
      { mode: 0o700 },
    );
    chmodSync(cloudflaredPath, 0o700);
    writeFileSync(
      configPath,
      `${JSON.stringify({
        version: 1,
        corePort: 8317,
        cloudflaredPath,
        localApiKeyPath: keyPath,
      })}\n`,
      { mode: 0o600 },
    );

    const helper = spawn(
      process.execPath,
      [runtimePath, "helper", "--config", configPath, "--observation", observationPath],
      {
        env: {
          ...process.env,
          FAKE_CLOUDFLARED_TERMINATED: terminatedPath,
          FAKE_OBSERVATION_DIR: observationDir,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let helperError = "";
    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", (chunk) => {
      helperError += chunk;
    });

    try {
      await waitFor(() => (existsSync(terminatedPath) ? true : null), "cloudflared termination");
      const exitCode = await waitForExit(helper);
      assert.notEqual(exitCode, 0, helperError);
    } finally {
      if (helper.exitCode === null) helper.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
