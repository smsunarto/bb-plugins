import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import { createNanocodexErrorReporter } from "./telemetry.ts";

test("NanoCodex host errors use artifact identity and sanitized envelopes", async () => {
  const target = await startEnvelopeTarget();
  const dir = await mkdtemp(join(tmpdir(), "bb-nanocodex-telemetry-"));
  const metaPath = join(dir, "host.meta.json");
  writeFileSync(metaPath, JSON.stringify({ pluginId: "nanocodex", pluginVersion: "1.2.3" }));
  try {
    const reporter = createNanocodexErrorReporter(
      "nanocodex",
      { SENTRY_DSN: target.dsn, SENTRY_ENVIRONMENT: "test" },
      pathToFileURL(metaPath),
    );
    assert.ok(reporter);
    reporter.capture({
      boundary: "host.bridge",
      operation: "thread/start",
      error: new Error("private host failure"),
    });
    await reporter.dispose(5_000);

    const event = parseEnvelopeEvent(target.bodies[0] ?? "");
    assert.equal(event.release, "bb-plugin-nanocodex@1.2.3");
    assert.equal(event.environment, "test");
    assert.equal(readRecord(event, "tags")["bb.plugin.id"], "nanocodex");
    assert.equal(readRecord(event, "tags")["bb.kit.boundary"], "host.bridge");
    assert.equal(readRecord(event, "tags")["bb.kit.operation"], "thread/start");
    assert.equal(exceptionValue(event), "Unexpected plugin callback failure");
    assert.equal(JSON.stringify(event).includes("private host failure"), false);
  } finally {
    await Promise.all([target.close(), rm(dir, { recursive: true, force: true })]);
  }
});

test("NanoCodex host reporting requires an explicit DSN", () => {
  assert.equal(
    createNanocodexErrorReporter("nanocodex", {}, new URL("file:///does/not/exist/host.meta.json")),
    undefined,
  );
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
    throw new Error("missing error event");
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

function exceptionValue(event: Record<string, unknown>): unknown {
  const exception = readRecord(event, "exception");
  const values = exception.values;
  if (!Array.isArray(values)) throw new Error("expected exception values");
  const first = values[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    throw new Error("expected exception value");
  }
  return (first as Record<string, unknown>).value;
}
