import assert from "node:assert/strict";
import { test } from "node:test";
import { installDom } from "@bb-kit/core/testing";
import { fireEvent } from "@testing-library/react";

installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

const configuration = {
  values: {
    autostart: true,
    cloudflareQuickTunnelForCursor: false,
    port: 8317,
    sourceRepository: "router-for-me/CLIProxyAPI",
    sourceBranch: "latest",
    routingStrategy: "fill-first" as const,
  },
  defaults: {
    autostart: true,
    cloudflareQuickTunnelForCursor: false,
    port: 8317,
    sourceRepository: "router-for-me/CLIProxyAPI",
    sourceBranch: "latest",
    routingStrategy: "round-robin" as const,
  },
  managementKeyConfigured: false,
  sourceError: null,
};

test("bb Settings contains one button that opens Agent Proxy Advanced", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  assert.equal(app.settingsSections.length, 1);
  const shortcut = app.settingsSections[0];
  assert.ok(shortcut);
  assert.equal(shortcut.title, undefined);
  assert.equal(shortcut.description, undefined);

  const slot = renderSlot(shortcut, {});
  fireEvent.click(slot.getByRole("button", { name: "Open Agent Proxy settings" }));
  assert.deepEqual(slot.inspection.navigateCalls, [
    {
      method: "toPluginPanel",
      path: "agent-proxy",
      options: { subPath: "advanced" },
    },
  ]);
  slot.unmount();
});

test("Agent Proxy Advanced owns every configuration field", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels[0];
  assert.ok(panel);
  const slot = renderSlot(
    panel,
    { subPath: "advanced" },
    {
      rpc: {
        configuration: async () => configuration,
        configurationUpdate: async () => configuration,
      },
    },
  );

  await slot.findByText("Service");
  slot.getByRole("checkbox", { name: /Keep the proxy running as a login service/ });
  slot.getByLabelText("Proxy listen port");
  slot.getByRole("combobox", { name: /Credential routing/ });
  slot.getByRole("checkbox", { name: /Cloudflare Quick Tunnel/ });
  slot.getByLabelText("Management key override");
  slot.getByRole("textbox", { name: /Repository/ });
  slot.getByRole("textbox", { name: /Branch or ref/ });
  slot.unmount();
});
