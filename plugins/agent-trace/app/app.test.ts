import { expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";

installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

test("registers an Agent Trace dashboard sidebar panel", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const panel = app.navPanels[0];

  expect(panel).toBeDefined();
  expect(panel).toMatchObject({ id: "dashboard", title: "Agent Trace", path: "dashboard" });
});

test("renders the configured dashboard in a sandboxed iframe", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const panel = app.navPanels[0];
  expect(panel).toBeDefined();
  if (!panel) return;

  const slot = renderSlot(
    panel,
    { subPath: "" },
    {
      settings: { dashboardUrl: "https://laminar.example.test/projects" },
    },
  );
  const frame = await slot.findByTitle("Trace dashboard");

  expect(frame.getAttribute("src")).toBe("https://laminar.example.test/projects");
  expect(frame.getAttribute("sandbox")).toContain("allow-same-origin");
  slot.unmount();
});

test("offers backend links when no embedded dashboard is configured", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const panel = app.navPanels[0];
  expect(panel).toBeDefined();
  if (!panel) return;

  const slot = renderSlot(
    panel,
    { subPath: "" },
    {
      settings: {
        langfusePublicKey: "pk-lf-test",
        langfuseBaseUrl: "https://us.cloud.langfuse.com",
      },
    },
  );
  const langfuse = await slot.findByText("Open Langfuse");

  expect(langfuse.getAttribute("href")).toBe("https://us.cloud.langfuse.com/");
  expect(slot.container.querySelector("iframe")).toBeNull();
  slot.unmount();
});

test("prepares a Connect session before rendering a remote dashboard share", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<string | URL | Request> = [];
  globalThis.fetch = (async (input) => {
    requests.push(input);
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;

  try {
    const app = await loadPluginApp(() => import("./app.tsx"));
    const panel = app.navPanels[0];
    expect(panel).toBeDefined();
    if (!panel) return;

    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        settings: { dashboardUrl: "https://scott--5668.getbb.app/" },
      },
    );
    const frame = await slot.findByTitle("Trace dashboard");

    expect(frame.getAttribute("src")).toBe("https://scott--5668.getbb.app/");
    expect(requests).toEqual(["/api/v1/plugins/agent-trace/http/remote-session"]);
    slot.unmount();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
