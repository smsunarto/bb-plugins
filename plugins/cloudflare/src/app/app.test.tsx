import { expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import type { Overview } from "../shared/schema.ts";

// The DOM must exist before the SDK's render harness is evaluated.
installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent } = await import("@testing-library/react");

const tunnelId = "996b473a-4a3e-4c5f-b8f1-b109e60f19de";
const overview: Overview = {
  setup: {
    configured: true,
    accountId: "d26dc9bfb142ea89cf63a376001bf4ea",
    missing: [],
    permissions: [],
    oauth: {
      configured: true,
      connected: true,
      accountId: "d26dc9bfb142ea89cf63a376001bf4ea",
      clientId: "client",
      redirectUri: "https://bb.example/api/v1/plugins/cloudflare/http/oauth/callback",
      missing: [],
    },
  },
  shares: [],
  hosts: { items: [{ id: "host_1", name: "Dev Mac", online: true }] },
  zones: { items: [{ id: "zone_1", name: "example.com" }] },
  dnsRecords: {
    items: [
      {
        id: "rec_1",
        zoneId: "zone_1",
        zoneName: "example.com",
        name: "blog.example.com",
        type: "CNAME",
        content: "pages.dev",
        proxied: true,
        ttl: 1,
      },
      {
        id: "rec_2",
        zoneId: "zone_1",
        zoneName: "example.com",
        name: "bb.example.com",
        type: "CNAME",
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
        tunnelId,
      },
    ],
  },
  identityProviders: {
    items: [
      { id: "idp_1", name: "", type: "onetimepin" },
      { id: "idp_2", name: "Work SSO", type: "saml" },
    ],
  },
  tunnels: {
    items: [
      {
        id: tunnelId,
        name: "bb-remote",
        status: "healthy",
        configSource: "cloudflare",
        connections: 4,
        dnsTarget: `${tunnelId}.cfargotunnel.com`,
        publicHostnames: [
          { hostname: "bb.example.com", url: "https://bb.example.com", source: "dns+ingress" },
        ],
      },
    ],
  },
  apps: { items: [] },
  policies: { items: [] },
};
const rpc = { overview: async () => overview };

async function loaded(slot: {
  findByRole: (role: string, options: { name: string }) => Promise<unknown>;
}) {
  await slot.findByRole("button", { name: "Tunnels 1" });
}

async function panel() {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const registration = app.navPanels[0];
  if (!registration) throw new Error("app.tsx registers one nav panel");
  return registration;
}

test("the shares tab shows the connected account and inventory counts", async () => {
  const slot = renderSlot(await panel(), { subPath: "" }, { rpc });
  await loaded(slot);
  expect(slot.getByText("Connected").className).toContain("cf-tone-good");
  expect(slot.getByRole("button", { name: "DNS 2" })).toBeTruthy();
  expect(slot.getByText("No development shares yet")).toBeTruthy();
  slot.unmount();
});

test("switching tabs reuses the cached overview instead of reloading it", async () => {
  const first = renderSlot(await panel(), { subPath: "" }, { rpc });
  await loaded(first);
  first.unmount();
  const second = renderSlot(await panel(), { subPath: "dns" }, { rpc });
  expect(second.getByText("blog.example.com")).toBeTruthy();
  expect(second.getByText("example.com · via bb-remote")).toBeTruthy();
  expect(second.rpcCalls).toHaveLength(0);
  second.unmount();
});

test("identity providers without a name are listed by type", async () => {
  const slot = renderSlot(await panel(), { subPath: "" }, { rpc });
  await loaded(slot);
  fireEvent.click(slot.getAllByRole("button", { name: "New share" })[0]!);
  expect(slot.getByRole("option", { name: "One-time PIN" })).toBeTruthy();
  expect(slot.getByRole("option", { name: "Work SSO · SAML" })).toBeTruthy();
  slot.unmount();
});

test("the tunnels tab colours status and exposes copyable targets", async () => {
  const slot = renderSlot(await panel(), { subPath: "tunnels" }, { rpc });
  const badge = await slot.findByText("Healthy");
  expect(badge.className).toContain("cf-tone-good");
  expect(slot.getByRole("button", { name: `Copy target: ${tunnelId}.cfargotunnel.com` }));
  expect(slot.getByText("Remotely managed", { exact: false })).toBeTruthy();
  slot.unmount();
});
