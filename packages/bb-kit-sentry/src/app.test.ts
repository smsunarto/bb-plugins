import assert from "node:assert/strict";
import { test } from "node:test";
import { sentryAppTelemetry } from "./app.ts";

test("missing and blank DSNs disable browser reporting", () => {
  const setup = () => undefined;
  assert.equal(
    sentryAppTelemetry({ pluginId: "demo", pluginVersion: "1.0.0" }).instrument(setup),
    setup,
  );
  assert.equal(
    sentryAppTelemetry({ pluginId: "demo", pluginVersion: "1.0.0", dsn: "  " }).instrument(setup),
    setup,
  );
});

test("browser capture sends one sanitized event after the settings gate", async () => {
  const target = createFetchTarget(true);
  const telemetry = sentryAppTelemetry({
    pluginId: "demo",
    pluginVersion: "1.2.3",
    environment: "test",
    dsn: target.dsn,
    fetch: target.fetch,
  });
  const failure = new Error("token=private");
  failure.stack =
    "PrivateError: token=private\n    at callback (https://bb.test/api/v1/plugins/demo/assets/app.js:7:3)";

  telemetry.capture({
    boundary: "app.callback",
    operation: "slots.action:demo.run",
    error: failure,
  });
  await telemetry.flush(5_000);

  assert.deepEqual(target.settingsRequests, ["/api/v1/plugins/demo/settings"]);
  assert.equal(target.envelopes.length, 1);
  const event = parseEnvelopeEvent(target.envelopes[0] ?? "");
  assert.deepEqual(readRecord(event, "tags"), {
    "bb.plugin.id": "demo",
    "bb.kit.boundary": "app.callback",
    "bb.kit.operation": "slots.action:demo.run",
  });
  assert.equal(event.release, "bb-plugin-demo@1.2.3");
  assert.equal(event.environment, "test");
  assert.doesNotMatch(JSON.stringify(event), /token=private|https:\/\/bb\.test/u);
  assert.match(JSON.stringify(event), /Unexpected plugin callback failure/u);
});

test("the browser settings gate drops events after opt-out", async () => {
  const target = createFetchTarget(false);
  const telemetry = sentryAppTelemetry({
    pluginId: "demo",
    pluginVersion: "1.0.0",
    dsn: target.dsn,
    fetch: target.fetch,
  });

  telemetry.capture({ boundary: "app.render", error: new Error("private") });
  await telemetry.flush(5_000);

  assert.equal(target.settingsRequests.length, 1);
  assert.equal(target.envelopes.length, 0);
});

test("instrument wraps components, callbacks, and content-script failures", async () => {
  const target = createFetchTarget(true);
  const telemetry = sentryAppTelemetry({
    pluginId: "demo",
    pluginVersion: "1.0.0",
    dsn: target.dsn,
    fetch: target.fetch,
  });
  const registrations = createRegistrations();
  const RenderDemo = () => null;
  const callbackError = new Error("callback private");
  const mountError = new Error("mount private");

  const setup = telemetry.instrument((app: typeof registrations.app) => {
    app.slots.commandPaletteAction({
      id: "demo-action",
      component: RenderDemo,
      run: async () => {
        throw callbackError;
      },
    });
    app.contentScripts.register({
      id: "demo-script",
      async mount() {
        throw mountError;
      },
    });
  });
  setup(registrations.app);

  assert.equal(registrations.contentScripts.length, 2);
  const action = registrations.slots[0];
  const component = action?.component as { displayName?: string } | undefined;
  const run = action?.run as (() => Promise<unknown>) | undefined;
  const mount = registrations.contentScripts[1]?.mount as (() => Promise<unknown>) | undefined;
  assert.notEqual(component, RenderDemo);
  assert.equal(component?.displayName, "SentryBoundary(RenderDemo)");
  assert.ok(run);
  assert.ok(mount);
  await assert.rejects(run, callbackError);
  await assert.rejects(mount, mountError);
  await telemetry.flush(5_000);

  assert.equal(target.envelopes.length, 2);
  const events = target.envelopes.map(parseEnvelopeEvent);
  assert.deepEqual(
    events.map((event) => readRecord(event, "tags")["bb.kit.boundary"]),
    ["app.callback", "app.contentScript"],
  );
});

function createRegistrations() {
  type Registration = Record<string, unknown>;
  type ContentScript = Record<string, unknown>;
  const slots: Registration[] = [];
  const contentScripts: ContentScript[] = [];
  return {
    slots,
    contentScripts,
    app: {
      slots: {
        commandPaletteAction(registration: Registration) {
          slots.push(registration);
        },
      },
      composer: {},
      contentScripts: {
        register(registration: ContentScript) {
          contentScripts.push(registration);
        },
      },
    },
  };
}

function createFetchTarget(telemetry: boolean): {
  dsn: string;
  settingsRequests: string[];
  envelopes: string[];
  fetch: typeof globalThis.fetch;
} {
  const settingsRequests: string[] = [];
  const envelopes: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("/api/v1/plugins/")) {
      settingsRequests.push(url);
      return Response.json({ values: { telemetry } });
    }
    envelopes.push(await new Response(init?.body as BodyInit | null | undefined).text());
    return Response.json({});
  };
  return {
    dsn: "https://public@example.test/42",
    settingsRequests,
    envelopes,
    fetch: fetchImpl,
  };
}

function parseEnvelopeEvent(body: string): Record<string, unknown> {
  const lines = body.split("\n");
  for (let index = 1; index < lines.length - 1; index += 2) {
    const header: unknown = JSON.parse(lines[index] ?? "null");
    if (isRecord(header) && header.type === "event") {
      const event: unknown = JSON.parse(lines[index + 1] ?? "null");
      if (isRecord(event)) return event;
    }
  }
  throw new Error("Sentry envelope did not contain an event item");
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`expected ${key} to be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
