import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { sentryPerformanceReporter } from "./performance.ts";

test("missing and blank DSNs disable performance reporting", () => {
  assert.equal(sentryPerformanceReporter({})({ pluginId: "demo" }), undefined);
  assert.equal(sentryPerformanceReporter({ dsn: "   " })({ pluginId: "demo" }), undefined);
  assert.equal(
    sentryPerformanceReporter({ dsn: "not-a-sentry-dsn" })({ pluginId: "demo" }),
    undefined,
  );
});

test("performance reporter sends elapsed checkpoints without application context", async () => {
  const target = await startEnvelopeTarget();
  try {
    const reporter = sentryPerformanceReporter({
      dsn: target.dsn,
      release: "demo@1.0.0",
      environment: "test",
    })({ pluginId: "demo" });
    assert.ok(reporter);
    const trace = reporter.start({
      operation: "cli.startup",
      variant: "local.fresh.mcp.medium.attempt-0",
    });
    trace.checkpoint("spawn_called");
    trace.checkpoint("spawn_called");
    await delay(2);
    trace.checkpoint("system_init");
    trace.finish("ok");
    trace.finish("error");
    await reporter.dispose(5_000);

    assert.equal(target.bodies.length, 1);
    assert.equal(target.urls[0], "/api/1/envelope/?sentry_version=7&sentry_key=public");
    const event = parseEnvelopeItem(target.bodies[0] ?? "", "transaction");
    assert.equal(event.transaction, "demo.cli.startup");
    assert.equal(event.release, "demo@1.0.0");
    assert.equal(event.environment, "test");
    assert.deepEqual(readRecord(event, "tags"), {
      "bb.plugin.id": "demo",
      "bb.kit.operation": "cli.startup",
      "bb.kit.variant": "local.fresh.mcp.medium.attempt-0",
      "bb.kit.outcome": "ok",
    });
    const measurements = readRecord(event, "measurements");
    assert.equal(typeof readRecord(measurements, "bb.spawn_called").value, "number");
    assert.equal(typeof readRecord(measurements, "bb.system_init").value, "number");
    assert.equal(typeof readRecord(measurements, "bb.total").value, "number");
    assert.doesNotMatch(JSON.stringify(event), /request|breadcrumbs|user|private/iu);
  } finally {
    await target.close();
  }
});

async function startEnvelopeTarget(): Promise<{
  dsn: string;
  bodies: string[];
  urls: string[];
  close(): Promise<void>;
}> {
  const bodies: string[] = [];
  const urls: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      urls.push(request.url ?? "");
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.statusCode = 200;
      response.end("{}\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback server did not expose a TCP address");
  }
  return {
    dsn: `http://public:private-secret@127.0.0.1:${address.port}/1`,
    bodies,
    urls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function parseEnvelopeItem(body: string, type: string): Record<string, unknown> {
  const lines = body.split("\n");
  for (let index = 1; index < lines.length - 1; index += 2) {
    const header: unknown = JSON.parse(lines[index] ?? "null");
    if (isRecord(header) && header.type === type) {
      const event: unknown = JSON.parse(lines[index + 1] ?? "null");
      if (isRecord(event)) return event;
    }
  }
  throw new Error(`Sentry envelope did not contain a ${type} item`);
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`expected ${key} to be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
