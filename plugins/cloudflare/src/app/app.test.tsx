import { beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import type { Overview, TunnelDetails } from "../shared/schema.ts";

// The DOM must exist before the SDK's render harness is evaluated.
installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, waitFor } = await import("@testing-library/react");

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
const quickHosts = { items: [{ id: "host_1", name: "Dev Mac", online: true }] };
const rpc = {
  overview: async () => overview,
  quickList: async () => ({ hosts: quickHosts, shares: [] }),
};

async function loaded(slot: {
  findByRole: (role: string, options: { name: string }) => Promise<unknown>;
}) {
  await slot.findByRole("button", { name: "Tunnels 1" });
}

// The panel keeps one module-level query cache so tab switches stay instant;
// each test starts from an empty cache. The module is only importable once
// loadPluginApp has installed the SDK runtime, so the handle is captured lazily.
let appModule: { queryClient: { clear(): void } } | undefined;
beforeEach(() => appModule?.queryClient.clear());

async function panel() {
  const app = await loadPluginApp(() => import("./app.tsx"));
  appModule ??= await import("./app.tsx");
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

test("a running quick share shows its public URL with open and copy controls", async () => {
  const client = {
    ...rpc,
    quickList: async () => ({
      hosts: quickHosts,
      shares: [
        {
          id: "7c2a8e1e-0d0f-4c8e-9a6b-6a4a0b6f2b11",
          hostId: "host_1",
          port: 3000,
          label: "Storybook",
          state: "running" as const,
          url: "https://brave-otter-quick.trycloudflare.com",
          createdAt: "2026-09-06T12:00:00Z",
          updatedAt: "2026-09-06T12:00:00Z",
        },
      ],
    }),
  };
  const slot = renderSlot(await panel(), { subPath: "" }, { rpc: client });
  await slot.findByRole("button", { name: "Shares 1" });
  expect(slot.getByText("Running").className).toContain("cf-tone-good");
  expect(slot.getByRole("link", { name: "Open Storybook" }).getAttribute("href")).toBe(
    "https://brave-otter-quick.trycloudflare.com",
  );
  expect(
    slot.getByRole("button", { name: "Copy URL: https://brave-otter-quick.trycloudflare.com" }),
  ).toBeTruthy();
  expect(slot.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(slot.queryByText("No development shares yet")).toBeNull();
  slot.unmount();
});

test("New share opens the quick share form with the only online host preselected", async () => {
  const slot = renderSlot(await panel(), { subPath: "" }, { rpc });
  await loaded(slot);
  fireEvent.click(slot.getAllByRole("button", { name: "New share" })[0]!);
  expect((slot.getByLabelText("BB host") as HTMLSelectElement).value).toBe("host_1");
  expect(slot.getByRole("button", { name: "Start quick share" })).toBeTruthy();
  slot.unmount();
});

test("identity providers without a name are listed by type", async () => {
  const slot = renderSlot(await panel(), { subPath: "" }, { rpc });
  await loaded(slot);
  fireEvent.click(slot.getAllByRole("button", { name: "Protected share…" })[0]!);
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

test("Manage opens the registered editor and keeps an unsaved draft across panel tab remounts", async () => {
  const detail: TunnelDetails = {
    target: {
      accountId: overview.setup.accountId,
      clientId: overview.setup.oauth.clientId,
      tunnelId,
    },
    name: "bb-remote",
    status: "healthy",
    configSource: "cloudflare",
    owner: { kind: "account" },
    writeState: { kind: "ready" },
    observedAt: "2026-09-06T12:00:00Z",
    connectors: { kind: "ready", value: [] },
    routes: {
      kind: "editable",
      revision: "a".repeat(64),
      advanced: false,
      rules: [],
      fallback: { kind: "plain", service: "http_status:404" },
      fallbackAdvanced: false,
    },
  };
  const client = { ...rpc, tunnelDetails: async () => detail };
  const first = renderSlot(await panel(), { subPath: "tunnels" }, { rpc: client });
  fireEvent.click(await first.findByRole("button", { name: "Manage" }));
  const input = await first.findByLabelText("Tunnel name");
  fireEvent.change(input, { target: { value: "Unsaved tunnel name" } });
  expect(
    first.getByRole("button", { name: `Copy target: ${tunnelId}.cfargotunnel.com` }),
  ).toBeTruthy();
  first.unmount();
  const dns = renderSlot(await panel(), { subPath: "dns" }, { rpc: client });
  expect(dns.getByText("blog.example.com")).toBeTruthy();
  dns.unmount();
  const returned = renderSlot(await panel(), { subPath: "tunnels" }, { rpc: client });
  await waitFor(() =>
    expect((returned.getByLabelText("Tunnel name") as HTMLInputElement).value).toBe(
      "Unsaved tunnel name",
    ),
  );
  expect(returned.getByRole("button", { name: "Close editor" })).toBeTruthy();
  returned.unmount();
});
