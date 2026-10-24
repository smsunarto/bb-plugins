import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, useState, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
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
  const availabilityError = new Error("availability private");
  const commandError = new Error("command private");

  const setup = telemetry.instrument((app: typeof registrations.app) => {
    app.commands.register({
      id: "demo-command",
      title: "Demo",
      isAvailable: () => {
        throw availabilityError;
      },
      run: async () => {
        throw commandError;
      },
    });
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
  const command = registrations.commands[0];
  const commandRun = command?.run as (() => Promise<unknown>) | undefined;
  const isAvailable = command?.isAvailable as (() => boolean) | undefined;
  assert.notEqual(component, RenderDemo);
  assert.equal(component?.displayName, "SentryBoundary(RenderDemo)");
  assert.ok(run);
  assert.ok(mount);
  await assert.rejects(run, callbackError);
  await assert.rejects(mount, mountError);
  assert.ok(commandRun);
  assert.ok(isAvailable);
  await assert.rejects(commandRun, commandError);
  assert.throws(isAvailable, availabilityError);
  await telemetry.flush(5_000);

  assert.equal(target.envelopes.length, 4);
  const events = target.envelopes.map(parseEnvelopeEvent);
  assert.deepEqual(
    events.map((event) => readRecord(event, "tags")["bb.kit.boundary"]),
    ["app.callback", "app.contentScript", "app.callback", "app.callback"],
  );
  assert.deepEqual(events.map((event) => readRecord(event, "tags")["bb.kit.operation"]).sort(), [
    "commands.register:demo-command.isAvailable",
    "commands.register:demo-command.run",
    "contentScripts.register:demo-script",
    "slots.commandPaletteAction:demo-action.run",
  ]);
});

test("instrument keeps registered hooks working as hooks and reports what they throw", async () => {
  const target = createFetchTarget(true);
  const telemetry = sentryAppTelemetry({
    pluginId: "demo",
    pluginVersion: "1.0.0",
    dsn: target.dsn,
    fetch: target.fetch,
  });
  const registrations = createRegistrations();
  const badgeError = new Error("badge private");
  const visibleError = new Error("visible private");
  // What React 19's `use()` throws to suspend, as production builds name it.
  const useSuspension = new Error("Minified React error #460; visit https://react.dev/errors/460");
  const Sidebar = () => createElement("nav", null, "sidebar");
  const waiting = Promise.resolve();

  telemetry.instrument((app: typeof registrations.app) => {
    app.slots.navPanel({
      id: "demo-panel",
      component: () => null,
      experimental_sidebar: Sidebar,
      // A real hook: the wrapper must leave React's hook order intact.
      experimental_useBadge: () => {
        const [count] = useState(3);
        return { count, label: `${count} waiting` };
      },
      experimental_usePageTitle: () => {
        throw waiting;
      },
    });
    app.slots.navPanel({
      id: "broken-panel",
      component: () => null,
      experimental_useBadge: () => {
        throw badgeError;
      },
    });
    app.slots.experimental_tab({
      id: "demo-tab",
      context: { kind: "nav-panel", panelId: "demo-panel" },
      availability: "fixed",
      component: () => null,
      useVisible: (suspend: boolean) => {
        throw suspend ? useSuspension : visibleError;
      },
    });
  })(registrations.app);

  const [panel, broken, tab] = registrations.slots;
  assert.ok(panel && broken && tab);
  const useBadge = panel.experimental_useBadge as () => { count: number; label: string };
  const sidebar = panel.experimental_sidebar as ComponentType & { displayName?: string };
  assert.equal(sidebar.displayName, "SentryBoundary(Sidebar)");
  // The tab's context is data, kept as registered.
  assert.deepEqual(tab.context, { kind: "nav-panel", panelId: "demo-panel" });

  function BadgeProbe() {
    const badge = useBadge();
    return createElement("span", null, `${badge.count}|${badge.label}`);
  }
  assert.equal(renderToString(createElement(BadgeProbe)), "<span>3|3 waiting</span>");
  // Suspense throws to wait; that is not a failure.
  assert.throws(
    () => (panel.experimental_usePageTitle as () => unknown)(),
    (thrown) => thrown === waiting,
  );
  assert.throws(() => (tab.useVisible as (suspend: boolean) => unknown)(true), useSuspension);
  assert.throws(() => (tab.useVisible as (suspend: boolean) => unknown)(false), visibleError);
  assert.throws(() => (broken.experimental_useBadge as () => unknown)(), badgeError);
  await telemetry.flush(5_000);

  const events = target.envelopes.map(parseEnvelopeEvent);
  assert.deepEqual(events.map((event) => readRecord(event, "tags")["bb.kit.operation"]).sort(), [
    "slots.experimental_tab:demo-tab.useVisible",
    "slots.navPanel:broken-panel.experimental_useBadge",
  ]);
  assert.deepEqual(
    events.map((event) => readRecord(event, "tags")["bb.kit.boundary"]),
    ["app.render", "app.render"],
  );
});

test("instrument reports thread action runs and sidebar footer actions", async () => {
  const target = createFetchTarget(true);
  const telemetry = sentryAppTelemetry({
    pluginId: "demo",
    pluginVersion: "1.0.0",
    dsn: target.dsn,
    fetch: target.fetch,
  });
  const registrations = createRegistrations();
  const runError = new Error("run private");
  const activateError = new Error("activate private");

  telemetry.instrument((app: typeof registrations.app) => {
    app.slots.experimental_threadAction({
      id: "demo-action",
      item: ({ thread }: { thread: { id: string } }) =>
        thread.id === "hidden"
          ? null
          : {
              label: `Open ${thread.id}`,
              run: async () => {
                throw runError;
              },
            },
    });
    app.experimental_sidebarFooter.register({
      id: "demo-footer",
      kind: "action",
      onActivate: () => {
        throw activateError;
      },
    });
  })(registrations.app);

  const item = registrations.slots[0]?.item as (input: {
    thread: { id: string };
  }) => { label: string; run: () => Promise<void> } | null;
  assert.equal(item({ thread: { id: "hidden" } }), null);
  const action = item({ thread: { id: "t1" } });
  assert.equal(action?.label, "Open t1");
  assert.ok(action);
  await assert.rejects(() => action.run(), runError);
  const onActivate = registrations.footer[0]?.onActivate as () => void;
  assert.throws(onActivate, activateError);
  await telemetry.flush(5_000);

  const events = target.envelopes.map(parseEnvelopeEvent);
  assert.deepEqual(events.map((event) => readRecord(event, "tags")["bb.kit.operation"]).sort(), [
    "experimental_sidebarFooter.register:demo-footer.onActivate",
    "slots.experimental_threadAction:demo-action.item.run",
  ]);
});

function createRegistrations() {
  type Registration = Record<string, unknown>;
  type ContentScript = Record<string, unknown>;
  const slots: Registration[] = [];
  const commands: Registration[] = [];
  const contentScripts: ContentScript[] = [];
  const footer: Registration[] = [];
  const slot = (registration: Registration) => {
    slots.push(registration);
  };
  return {
    slots,
    commands,
    contentScripts,
    footer,
    app: {
      commands: {
        register(registration: Registration) {
          commands.push(registration);
        },
      },
      slots: {
        commandPaletteAction: slot,
        navPanel: slot,
        experimental_tab: slot,
        experimental_threadAction: slot,
      },
      experimental_sidebarFooter: {
        register(registration: Registration) {
          footer.push(registration);
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
