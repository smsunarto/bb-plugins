import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const CONFIG_VERSION = 1;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const STABLE_CHILD_MS = 30_000;
const FIXED_REQUEST_HEADERS = new Set([
  "connection",
  "expect",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
  "true-client-ip",
  "x-real-ip",
]);
const FIXED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPort(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65_536;
}

function parseConfig(value) {
  if (!isRecord(value) || value.version !== CONFIG_VERSION || !isPort(value.corePort)) return null;
  if (typeof value.cloudflaredPath !== "string" || !isAbsolute(value.cloudflaredPath)) return null;
  if (typeof value.localApiKeyPath !== "string" || !isAbsolute(value.localApiKeyPath)) return null;
  return {
    version: CONFIG_VERSION,
    corePort: value.corePort,
    cloudflaredPath: value.cloudflaredPath,
    localApiKeyPath: value.localApiKeyPath,
  };
}

function readConfig(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read desired tunnel config: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const config = parseConfig(parsed);
  if (config === null) throw new Error("desired tunnel config is invalid");
  return config;
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function publicOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(parsed.hostname)
  ) {
    return null;
  }
  return parsed.origin;
}

function extractPublicOrigin(output) {
  for (const match of output.matchAll(
    /https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?(?![a-z0-9.-])/gi,
  )) {
    const origin = publicOrigin(match[0]);
    if (origin !== null) return origin;
  }
  return null;
}

function inspectRequestTarget(rawTarget) {
  if (typeof rawTarget !== "string" || !rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
    return { accepted: false, status: 400, detail: "absolute request targets are not allowed" };
  }
  const queryIndex = rawTarget.indexOf("?");
  const rawPath = queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
  if (rawPath.includes("#") || rawPath.includes("\\")) {
    return { accepted: false, status: 400, detail: "invalid request target" };
  }
  let decoded = rawPath;
  for (let depth = 0; ; depth += 1) {
    if (depth === 16) {
      return { accepted: false, status: 400, detail: "request target is encoded too deeply" };
    }
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return { accepted: false, status: 400, detail: "invalid request target encoding" };
    }
    if (next.includes("\\") || next.split("/").length !== decoded.split("/").length) {
      return { accepted: false, status: 400, detail: "encoded path separators are not allowed" };
    }
    if (next.split("/").some((segment) => segment === "." || segment === "..")) {
      return { accepted: false, status: 400, detail: "dot segments are not allowed" };
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (rawPath !== "/v1" && !rawPath.startsWith("/v1/")) {
    return { accepted: false, status: 404, detail: "not found" };
  }
  return { accepted: true, target: rawTarget };
}

function connectionHeaderNames(headers) {
  const value = headers.connection;
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return new Set(
    values
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

function requestHeaders(headers, corePort) {
  const connectionNames = connectionHeaderNames(headers);
  const clean = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      FIXED_REQUEST_HEADERS.has(lower) ||
      connectionNames.has(lower) ||
      lower === "via" ||
      lower.startsWith("cf-") ||
      lower.startsWith("x-forwarded-")
    ) {
      continue;
    }
    clean[lower] = value;
  }
  clean.host = `127.0.0.1:${corePort}`;
  clean.authorization = headers.authorization;
  return clean;
}

function responseHeaders(headers) {
  const connectionNames = connectionHeaderNames(headers);
  const clean = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || FIXED_RESPONSE_HEADERS.has(lower) || connectionNames.has(lower)) {
      continue;
    }
    clean[lower] = value;
  }
  return clean;
}

function validBearer(value, expected) {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const received = Buffer.from(value.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

function send(response, status, detail) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = `${detail}\n`;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
}

function createGateway(configPath) {
  const handleRequest = (incoming, outgoing, continueAfterAuth = false) => {
    const target = inspectRequestTarget(incoming.url);
    if (!target.accepted) {
      send(outgoing, target.status, target.detail);
      return;
    }
    if (
      incoming.headers.upgrade !== undefined ||
      /(?:^|,)\s*upgrade\s*(?:,|$)/i.test(incoming.headers.connection ?? "")
    ) {
      send(outgoing, 426, "protocol upgrades are not allowed");
      return;
    }
    let config;
    let key;
    try {
      config = readConfig(configPath);
      key = readFileSync(config.localApiKeyPath, "utf8").trim();
      if (key.length === 0) throw new Error("the local API key is empty");
    } catch {
      send(outgoing, 503, "gateway configuration is unavailable");
      return;
    }
    if (!validBearer(incoming.headers.authorization, key)) {
      outgoing.setHeader("www-authenticate", "Bearer");
      send(outgoing, 401, "unauthorized");
      return;
    }
    if (continueAfterAuth) outgoing.writeContinue();
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: config.corePort,
        method: incoming.method,
        path: target.target,
        headers: requestHeaders(incoming.headers, config.corePort),
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, responseHeaders(response.headers));
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => send(outgoing, 503, "CLIProxyAPI is temporarily unavailable"));
    incoming.on("aborted", () => upstream.destroy());
    incoming.pipe(upstream);
  };
  const server = createServer(handleRequest);
  server.on("checkContinue", (incoming, outgoing) => {
    handleRequest(incoming, outgoing, true);
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return server;
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the loopback gateway did not return a TCP address"));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections?.();
  });
}

function childOutcome(child, onOutput) {
  const { promise: outcome, resolve: resolveOutcome } = Promise.withResolvers();
  let outputError = null;
  let childError = null;
  let killTimer = null;
  const failOutput = (error) => {
    if (outputError !== null) return;
    outputError = error instanceof Error ? error : new Error(String(error));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }
  };
  for (const [stream, output] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      output.write(chunk);
      try {
        onOutput(String(chunk));
      } catch (error) {
        failOutput(error);
      }
    });
  }
  child.once("error", (error) => {
    childError = error;
  });
  child.once("close", (code, signal) => {
    if (killTimer !== null) clearTimeout(killTimer);
    resolveOutcome({ code, signal, error: outputError ?? childError });
  });
  return outcome;
}

async function terminateChild(child, outcome) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await outcome;
    return;
  }
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await outcome;
  } finally {
    clearTimeout(killTimer);
  }
}

async function wait(ms, signal) {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

function waitForOutcomeOrAbort(outcome, signal) {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolveResult) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      resolveResult(value);
    };
    const abort = () => finish(null);
    signal.addEventListener("abort", abort, { once: true });
    outcome.then(finish);
  });
}

async function runHelper(configPath, observationPath) {
  const sessionId = randomUUID();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const gateway = createGateway(configPath);
  let child = null;
  let outcome = null;
  try {
    const gatewayPort = await listen(gateway);
    let failures = 0;
    while (!controller.signal.aborted) {
      const config = readConfig(configPath);
      writeAtomic(observationPath, {
        version: CONFIG_VERSION,
        phase: "starting",
        ownerPid: process.pid,
        sessionId,
        updatedAt: Date.now(),
      });
      child = spawn(
        config.cloudflaredPath,
        [
          "tunnel",
          "--config",
          "/dev/null",
          "--no-autoupdate",
          "--url",
          `http://127.0.0.1:${gatewayPort}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const startedAt = Date.now();
      let outputBuffer = "";
      let ready = false;
      outcome = childOutcome(child, (chunk) => {
        if (ready || child?.pid === undefined) return;
        outputBuffer = `${outputBuffer}${chunk}`.slice(-16_384);
        const origin = extractPublicOrigin(outputBuffer);
        if (origin === null) return;
        ready = true;
        writeAtomic(observationPath, {
          version: CONFIG_VERSION,
          phase: "ready",
          ownerPid: process.pid,
          sessionId,
          cloudflaredPid: child.pid,
          publicOrigin: origin,
          updatedAt: Date.now(),
        });
      });
      const result = await waitForOutcomeOrAbort(outcome, controller.signal);
      if (controller.signal.aborted) {
        await terminateChild(child, outcome);
        break;
      }
      const detail =
        result?.error instanceof Error
          ? `tunnel attempt failed: ${result.error.message}`
          : `cloudflared exited with code ${result?.code ?? "null"} and signal ${result?.signal ?? "null"}; retrying`;
      writeAtomic(observationPath, {
        version: CONFIG_VERSION,
        phase: "error",
        ownerPid: process.pid,
        sessionId,
        detail,
        updatedAt: Date.now(),
      });
      child = null;
      outcome = null;
      if (ready && Date.now() - startedAt >= STABLE_CHILD_MS) failures = 0;
      const retryDelay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
      failures += 1;
      await wait(retryDelay, controller.signal);
    }
  } finally {
    if (child !== null && outcome !== null) await terminateChild(child, outcome);
    await closeServer(gateway);
    rmSync(observationPath, { force: true });
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

function selfTest() {
  const valid = inspectRequestTarget("/v1/models?limit=1");
  if (!valid.accepted) throw new Error("valid /v1 request target was rejected");
  for (const target of ["https://example.com/v1", "/v1/%2e%2e/admin", "/v1%2fadmin"]) {
    if (inspectRequestTarget(target).accepted)
      throw new Error(`unsafe request target was accepted: ${target}`);
  }
  if (publicOrigin("https://example.trycloudflare.com") === null) {
    throw new Error("valid Quick Tunnel origin was rejected");
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "helper")
    throw new Error("usage: helper [--self-test | --config PATH --observation PATH]");
  if (args.includes("--self-test")) {
    selfTest();
    return;
  }
  const configIndex = args.indexOf("--config");
  const observationIndex = args.indexOf("--observation");
  const configPath = args[configIndex + 1];
  const observationPath = args[observationIndex + 1];
  if (configIndex === -1 || observationIndex === -1 || !configPath || !observationPath) {
    throw new Error("usage: helper --config PATH --observation PATH");
  }
  await runHelper(configPath, observationPath);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
