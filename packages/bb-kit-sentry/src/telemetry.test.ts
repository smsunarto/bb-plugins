import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { sentryPluginRelease, sentryPluginTelemetry } from "./telemetry.ts";

const IDENTITY = { pluginId: "demo", pluginVersion: "9.9.9" };

test("telemetry stays disabled without SENTRY_DSN", () => {
  const fixture = createArtifactFixture("built", IDENTITY);
  try {
    for (const env of [{}, { SENTRY_DSN: "   " }]) {
      const telemetry = sentryPluginTelemetry({
        pluginId: "demo",
        serverEntryUrl: fixture.serverEntryUrl,
        env,
      });
      assert.equal(telemetry.errorReporter({ pluginId: "demo" }), undefined);
      assert.equal(telemetry.performanceReporter({ pluginId: "demo" }), undefined);
    }
  } finally {
    fixture.cleanup();
  }
});

test("telemetry stays disabled when artifact identity is missing or drifted", () => {
  const env = { SENTRY_DSN: "https://public@example.com/1" };
  const missing = sentryPluginTelemetry({
    pluginId: "demo",
    serverEntryUrl: pathToFileURL(join(tmpdir(), "bb-kit-sentry-nowhere", "server.js")).href,
    env,
  });
  assert.equal(missing.errorReporter({ pluginId: "demo" }), undefined);

  const drifted = createArtifactFixture("built", { pluginId: "other", pluginVersion: "9.9.9" });
  const malformed = createArtifactFixture("built", { pluginVersion: "9.9.9" });
  try {
    for (const fixture of [drifted, malformed]) {
      const telemetry = sentryPluginTelemetry({
        pluginId: "demo",
        serverEntryUrl: fixture.serverEntryUrl,
        env,
      });
      assert.equal(telemetry.errorReporter({ pluginId: "demo" }), undefined);
      assert.equal(telemetry.performanceReporter({ pluginId: "demo" }), undefined);
    }
  } finally {
    drifted.cleanup();
    malformed.cleanup();
  }
});

test("enabled telemetry derives the release from the sidecar in both layouts", async () => {
  const target = await startEnvelopeTarget();
  const built = createArtifactFixture("built", IDENTITY);
  const source = createArtifactFixture("source", IDENTITY);
  try {
    for (const fixture of [built, source]) {
      const telemetry = sentryPluginTelemetry({
        pluginId: "demo",
        serverEntryUrl: fixture.serverEntryUrl,
        env: { SENTRY_DSN: target.dsn, SENTRY_ENVIRONMENT: "ci" },
        tracesSampleRate: 1,
      });
      const errorReporter = telemetry.errorReporter({ pluginId: "demo" });
      assert.notEqual(errorReporter, undefined);
      await errorReporter?.dispose?.(1_000);
      const performance = telemetry.performanceReporter({ pluginId: "demo" });
      assert.ok(performance);
      performance.start({ operation: "plugin.startup" }).finish("ok");
      await performance.dispose?.(5_000);
    }
    assert.equal(target.bodies.length, 2);
    for (const body of target.bodies) {
      assert.match(body, /"release":"bb-plugin-demo@9\.9\.9"/u);
      assert.match(body, /"environment":"ci"/u);
    }
  } finally {
    built.cleanup();
    source.cleanup();
    await target.close();
  }
});

test("SENTRY_TRACES_SAMPLE_RATE overrides the sampling default", async () => {
  const target = await startEnvelopeTarget();
  const fixture = createArtifactFixture("built", IDENTITY);
  try {
    const telemetry = sentryPluginTelemetry({
      pluginId: "demo",
      serverEntryUrl: fixture.serverEntryUrl,
      env: { SENTRY_DSN: target.dsn, SENTRY_TRACES_SAMPLE_RATE: "0" },
      tracesSampleRate: 1,
    });
    const performance = telemetry.performanceReporter({ pluginId: "demo" });
    assert.ok(performance);
    performance.start({ operation: "plugin.startup" }).finish("ok");
    await performance.dispose?.(5_000);
    assert.equal(target.bodies.length, 0);
  } finally {
    fixture.cleanup();
    await target.close();
  }
});

test("the release name matches the source-map pipeline convention", () => {
  assert.equal(sentryPluginRelease({ pluginId: "amp", pluginVersion: "1.2.3" }), "bb-plugin-amp@1.2.3");
});

function createArtifactFixture(
  layout: "built" | "source",
  meta: unknown,
): { serverEntryUrl: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "bb-kit-sentry-telemetry-"));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  if (layout === "built") {
    writeFileSync(join(dir, "server.meta.json"), JSON.stringify(meta));
    return { serverEntryUrl: pathToFileURL(join(dir, "server.js")).href, cleanup };
  }
  mkdirSync(join(dir, "server"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "server.meta.json"), JSON.stringify(meta));
  return { serverEntryUrl: pathToFileURL(join(dir, "server", "server.ts")).href, cleanup };
}

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
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    dsn: `http://public@127.0.0.1:${port}/42`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
