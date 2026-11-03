import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { setImmediate } from "node:timers/promises";
import { loadPluginApp, mountPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";

before(() =>
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "hidden" },
  }),
);
after(() => {
  Reflect.deleteProperty(globalThis, "document");
});

const tick = () => setImmediate();
test("footer wake starts only on click, coalesces clicks, and reports connection", async (t) => {
  const app = await loadPluginApp(() => import("./app.ts"));
  let starts = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /startWake$/);
    starts++;
    return Response.json({ ok: true, result: { jobId: "job", state: { kind: "ready" } } });
  });
  const mount = await mountPluginContentScripts(app, { pluginId: "gcp-machine", generation: 1 });
  t.after(() => mount.lifecycle.dispose());
  const action = app.experimentalSidebarFooterItems[0];
  assert.equal(action?.label, "Wake GCP machine");
  assert.equal(starts, 0);
  assert.ok(action?.kind === "action");
  action.onActivate({ openPluginDetails() {} });
  action.onActivate({ openPluginDetails() {} });
  await tick();
  assert.equal(starts, 1);
  const result = toast.getHistory().find((item) => item.id === "gcp-machine-wake");
  assert.ok(result && "type" in result);
  assert.equal(result.type, "success");
  assert.equal(result?.title, "GCP machine connected");
});

test("failed wake leaves a visible manual retry and disposal stops feedback", async (t) => {
  const app = await loadPluginApp(() => import("./app.ts"));
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      ok: true,
      result: {
        jobId: "job",
        state: { kind: "failed", error: "Controller unavailable" },
      },
    }),
  );
  const mount = await mountPluginContentScripts(app, { pluginId: "gcp-machine", generation: 2 });
  const action = app.experimentalSidebarFooterItems[0];
  assert.ok(action?.kind === "action");
  action.onActivate({ openPluginDetails() {} });
  await tick();
  const result = toast.getHistory().find((item) => item.id === "gcp-machine-wake");
  assert.ok(result && "type" in result);
  assert.equal(result.type, "error");
  assert.equal(result?.description, "Controller unavailable");
  assert.equal(
    typeof result?.action === "object" && result.action !== null && "label" in result.action
      ? result.action.label
      : null,
    "Try again",
  );
  await mount.lifecycle.dispose();
  assert.equal(mount.inspection.signal.aborted, true);
});

test("visible indicator rejects stale reads, becomes neutral offline, and recovers", async (t) => {
  Object.assign(document, { visibilityState: "visible" });
  let online = true;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  const events = new EventTarget();
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value: events.addEventListener.bind(events),
  });
  Object.defineProperty(globalThis, "removeEventListener", {
    configurable: true,
    value: events.removeEventListener.bind(events),
  });
  t.after(() => {
    Object.assign(document, { visibilityState: "hidden" });
    Reflect.deleteProperty(navigator, "onLine");
    Reflect.deleteProperty(globalThis, "addEventListener");
    Reflect.deleteProperty(globalThis, "removeEventListener");
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release: ((response: Response) => void) | undefined;
  let reads = 0;
  let complete = false;
  let failedRead = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("getIndicator")) {
      if (++reads === 1)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return failedRead
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ ok: true, result: "awake" });
    }
    if (url.endsWith("startWake"))
      return Response.json({
        ok: true,
        result: { jobId: "job", state: { kind: "waking", attempt: 1 } },
      });
    return Response.json({
      ok: true,
      result: complete ? { kind: "ready" } : { kind: "waking", attempt: 1 },
    });
  });
  const app = await loadPluginApp(() => import("./app.ts"));
  const mount = await mountPluginContentScripts(app, { pluginId: "gcp-machine", generation: 3 });
  t.after(() => mount.lifecycle.dispose());
  const icon = app.icons[0];
  assert.ok(icon);
  const markup = () => renderToStaticMarkup(createElement(icon.component));
  const action = app.experimentalSidebarFooterItems[0];
  assert.ok(action?.kind === "action");
  action.onActivate({ openPluginDetails() {} });
  await tick();
  assert.ok(release);
  release(Response.json({ ok: true, result: "offline" }));
  await tick();
  assert.match(markup(), /data-gcp-state="waking"/);
  online = false;
  events.dispatchEvent(new Event("offline"));
  assert.match(markup(), /data-gcp-state="offline"/);
  complete = true;
  online = true;
  t.mock.timers.tick(5000);
  await tick();
  assert.match(markup(), /data-gcp-state="awake"/);
  failedRead = true;
  t.mock.timers.tick(5000);
  await tick();
  assert.match(markup(), /data-gcp-state="offline"/);
});
