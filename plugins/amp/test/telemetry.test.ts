import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "bun:test";
import { AMP_SENTRY_ENV, ampSentryRelease } from "../lib/telemetry.ts";
import {
  ampStartupVariant,
  createAmpPerformanceReporter,
  createIdempotentShutdown,
  startAmpStartupTrace,
} from "../src/bridge/telemetry.ts";

test("Amp forwards the complete Sentry environment contract", () => {
  assert.deepEqual(AMP_SENTRY_ENV, ["SENTRY_DSN", "SENTRY_ENVIRONMENT"]);
  assert.equal(
    ampSentryRelease({ pluginId: "amp", pluginVersion: "1.2.3" }),
    "bb-plugin-amp@1.2.3",
  );
});

test("Amp derives the performance release from final host metadata", async () => {
  const target = await startEnvelopeTarget();
  const dir = await mkdtemp(join(tmpdir(), "bb-amp-telemetry-"));
  const metaPath = join(dir, "host.meta.json");
  writeFileSync(metaPath, JSON.stringify({ pluginId: "amp", pluginVersion: "1.2.3" }));
  try {
    const reporter = createAmpPerformanceReporter(
      "amp",
      { SENTRY_DSN: target.dsn, SENTRY_ENVIRONMENT: "test" },
      pathToFileURL(metaPath),
    );
    assert.ok(reporter);
    const trace = startAmpStartupTrace(reporter, {
      executor: "local",
      continuation: "fresh",
      mcp: true,
      mode: "medium",
      attempt: 0,
    });
    trace?.checkpoint("spawn_called");
    trace?.finish("ok");
    await reporter.dispose(5_000);

    const event = parseEnvelopeEvent(target.bodies[0] ?? "");
    assert.equal(event.release, "bb-plugin-amp@1.2.3");
    assert.equal(event.environment, "test");
    assert.equal(event.transaction, "amp.cli.startup");
    assert.equal(readRecord(event, "tags")["bb.kit.variant"], "local.fresh.mcp.medium.attempt-0");
  } finally {
    await Promise.all([target.close(), rm(dir, { recursive: true, force: true })]);
  }
});

test("a missing DSN avoids host metadata reads", () => {
  assert.equal(
    createAmpPerformanceReporter("amp", {}, new URL("file:///does/not/exist/host.meta.json")),
    undefined,
  );
});

test("telemetry fails open when host metadata cannot identify this plugin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-amp-telemetry-invalid-"));
  const metaPath = join(dir, "host.meta.json");
  const env = { SENTRY_DSN: "https://public@example.com/1" };
  try {
    assert.equal(
      createAmpPerformanceReporter("amp", env, pathToFileURL(join(dir, "missing.json"))),
      undefined,
    );

    writeFileSync(metaPath, "{not-json");
    assert.equal(createAmpPerformanceReporter("amp", env, pathToFileURL(metaPath)), undefined);

    writeFileSync(metaPath, JSON.stringify({ pluginId: "other", pluginVersion: "1.2.3" }));
    assert.equal(createAmpPerformanceReporter("amp", env, pathToFileURL(metaPath)), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the startup variant renderer owns every spelling", () => {
  assert.equal(
    ampStartupVariant({
      executor: "orb",
      continuation: "continued",
      mcp: false,
      mode: "ultra",
      attempt: 1,
    }),
    "orb.continued.no-mcp.ultra.attempt-1",
  );
});

test("shutdown starts synchronously and memoizes one promise", async () => {
  let calls = 0;
  let resolve!: () => void;
  const shutdown = createIdempotentShutdown(() => {
    calls += 1;
    return new Promise<void>((done) => {
      resolve = done;
    });
  });
  const first = shutdown();
  const second = shutdown();
  assert.equal(calls, 1);
  assert.equal(first, second);
  resolve();
  await first;
  assert.equal(shutdown(), first);
});

async function startEnvelopeTarget(): Promise<{
  dsn: string;
  bodies: string[];
  close(): Promise<void>;
}> {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing server address");
  return {
    dsn: `http://public@127.0.0.1:${address.port}/1`,
    bodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function parseEnvelopeEvent(body: string): Record<string, unknown> {
  const lines = body.split("\n");
  const event: unknown = JSON.parse(lines[2] ?? "null");
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new Error("missing transaction event");
  }
  return event as Record<string, unknown>;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${key} to be an object`);
  }
  return value as Record<string, unknown>;
}
