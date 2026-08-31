import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { PluginErrorReporterFactory } from "@bb-kit/core/plugin";
import { sentryErrorReporter } from "./node.ts";

const coreCompatibleReporter: PluginErrorReporterFactory = sentryErrorReporter({});
void coreCompatibleReporter;

test("missing and blank DSNs disable reporting", () => {
  assert.equal(sentryErrorReporter({})({ pluginId: "demo" }), undefined);
  assert.equal(sentryErrorReporter({ dsn: "   " })({ pluginId: "demo" }), undefined);
});

test("direct NodeClient sends one sanitized event and closes once", async () => {
  const target = await startEnvelopeTarget();
  try {
    const reporter = sentryErrorReporter({
      dsn: target.dsn,
      release: "demo@1.0.0",
      environment: "test",
    })({ pluginId: "demo" });
    assert.ok(reporter);
    const failure = new Error("token=private");
    failure.stack =
      "PrivateError: token=private\n    at callback (/Users/alice/git/bb-plugins/plugins/demo/server.ts:7:3)";
    assert.equal(
      reporter.capture({ boundary: "rpc.execute", operation: "status", error: failure }),
      undefined,
    );
    await reporter.dispose(5_000);
    await reporter.dispose(5_000);
    reporter.capture({ boundary: "rpc.execute", operation: "after-close", error: failure });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(target.bodies.length, 1);
    const event = parseEnvelopeEvent(target.bodies[0] ?? "");
    assert.deepEqual(readRecord(event, "tags"), {
      "bb.plugin.id": "demo",
      "bb.kit.boundary": "rpc.execute",
      "bb.kit.operation": "status",
    });
    assert.equal(event.release, "demo@1.0.0");
    assert.equal(event.environment, "test");
    assert.doesNotMatch(JSON.stringify(event), /token=private|\/Users\/alice/u);
    assert.match(JSON.stringify(event), /Unexpected plugin callback failure/u);
  } finally {
    await target.close();
  }
});

test("factories use isolated clients and destinations", async () => {
  const first = await startEnvelopeTarget();
  const second = await startEnvelopeTarget();
  try {
    const firstReporter = sentryErrorReporter({ dsn: first.dsn, release: "first@1" })({
      pluginId: "first",
    });
    const secondReporter = sentryErrorReporter({ dsn: second.dsn, release: "second@1" })({
      pluginId: "second",
    });
    assert.ok(firstReporter);
    assert.ok(secondReporter);
    firstReporter.capture({ boundary: "plugin.factory", error: new Error("first") });
    secondReporter.capture({ boundary: "plugin.setup", error: new Error("second") });
    await Promise.all([firstReporter.dispose(5_000), secondReporter.dispose(5_000)]);

    assert.equal(first.bodies.length, 1);
    assert.equal(second.bodies.length, 1);
    const firstEvent = parseEnvelopeEvent(first.bodies[0] ?? "");
    const secondEvent = parseEnvelopeEvent(second.bodies[0] ?? "");
    assert.equal(readRecord(firstEvent, "tags")["bb.plugin.id"], "first");
    assert.equal(readRecord(secondEvent, "tags")["bb.plugin.id"], "second");
    assert.equal(firstEvent.release, "first@1");
    assert.equal(secondEvent.release, "second@1");
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
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
  for (let index = 1; index < lines.length - 1; index += 2) {
    const header: unknown = JSON.parse(lines[index] ?? "null");
    if (isRecord(header) && header.type === "event") {
      const event: unknown = JSON.parse(lines[index + 1] ?? "null");
      if (isRecord(event)) {
        return event;
      }
    }
  }
  throw new Error("Sentry envelope did not contain an event item");
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`expected ${key} to be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
