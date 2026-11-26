import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginSettingValue } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { usageFetchMethod, usageListMethod } from "./lib/usage-contract.ts";
import plugin from "./server.ts";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const hosts: { lifecycle: { dispose(): Promise<void> } }[] = [];
after(async () => {
  for (const harness of hosts.splice(0)) await harness.lifecycle.dispose();
});

async function loaded(sdkOverrides?: Record<string, unknown>) {
  const host = createFakePluginHost({
    pluginId: "antigravity",
    ...(sdkOverrides === undefined ? {} : { sdk: sdkOverrides as never }),
  });
  hosts.push(host.harness);
  await plugin(host.bb);
  const [provider] = host.harness.inspection.registrations.providerRegistrations;
  assert.ok(provider, "expected antigravity provider registration");
  return { ...host, provider };
}

test("registers Antigravity as an always-visible first-class provider", async () => {
  const { provider } = await loaded();
  assert.equal(provider.id, "antigravity");
  assert.equal(provider.displayName, "Antigravity");
  assert.equal(provider.experimental_visibility, "always");
  assert.deepEqual(provider.capabilities.permissionModes, ["accept-edits", "auto", "full"]);
  assert.equal(provider.capabilities.supportsManualCompaction, true);
  assert.equal(provider.capabilities.fork, "none");
  assert.deepEqual(provider.composerActions, ["plan"]);
  assert.deepEqual(provider.maintenance, { health: true, usage: true, installation: true });
  assert.equal(provider.experimental_resolvesNativeRoots, true);
  assert.deepEqual(provider.experimental_bridgeOptions, {
    acpDialect: "antigravity",
    acpLaunchSpec: { displayName: "Antigravity", command: "agy", args: ["acp"], env: {} },
  });
  assert.ok(provider.env?.passthrough?.includes("BB_ANTIGRAVITY_EXECUTABLE"));
  assert.ok(provider.env?.passthrough?.includes("GEMINI_API_KEY"));
});

test("deriveProviderOptions applies sandbox, telemetry, default agent, and executable overrides", async () => {
  const { provider } = await loaded();
  const derive = (
    settings: Readonly<Record<string, PluginSettingValue | undefined>>,
    permissionMode: "accept-edits" | "auto" | "full" = "auto",
  ) =>
    provider.deriveProviderOptions?.({
      threadId: "thr_1",
      projectId: "proj_1",
      model: "gemini-4-neon",
      permissionMode,
      settings,
    });

  // Default settings emit no override, letting static bridgeOptions stand.
  assert.deepEqual(derive({}), {});

  // Sandbox applies in accept-edits and auto, but not full.
  assert.deepEqual(derive({ sandboxEnabled: true }, "auto"), {
    acpLaunchSpec: {
      displayName: "Antigravity",
      command: "agy",
      args: ["acp", "--sandbox"],
      env: {},
    },
  });
  assert.deepEqual(derive({ sandboxEnabled: true }, "full"), {});

  // Telemetry, agent, and executable path combine cleanly.
  assert.deepEqual(
    derive(
      {
        sandboxEnabled: true,
        disableTelemetry: true,
        defaultAgent: "reviewer",
        executablePath: "/custom/bin/agy",
      },
      "accept-edits",
    ),
    {
      acpLaunchSpec: {
        displayName: "Antigravity",
        command: "/custom/bin/agy",
        args: ["acp", "--sandbox", "--disable-telemetry", "--agent", "reviewer"],
        env: {},
      },
    },
  );
});

test("usage-source RPC lists host resources and normalizes usage windows", async () => {
  const hostInfo = makeHostResponse({ id: "host_1", name: "Dev PC", status: "connected" });
  let fetchCount = 0;
  const { harness } = await loaded({
    hosts: {
      list: async () => [hostInfo],
      get: async () => hostInfo,
    },
    providers: {
      list: async () => [
        {
          id: "antigravity",
          pluginId: "antigravity",
          displayName: "Antigravity",
        },
      ],
    },
    system: {
      usageLimits: async () => {
        fetchCount += 1;
        return {
          antigravity: {
            status: "ok",
            accountEmail: null,
            planLabel: null,
            windows: [
              {
                label: "Gemini 5-hour",
                usedPercent: 37,
                resetsAt: "2026-11-26T08:59:22.000Z",
              },
              {
                label: "Gemini weekly",
                usedPercent: 11,
                resetsAt: "2026-12-02T21:46:18.000Z",
              },
            ],
          },
        };
      },
    },
  });

  const listed = (await harness.behavior.callRpc(usageListMethod, {})) as {
    resources: { id: string; providerId: string; label: string }[];
  };
  assert.equal(listed.resources.length, 1);
  assert.equal(listed.resources[0]?.providerId, "antigravity");

  const resourceId = listed.resources[0]!.id;
  const first = (await harness.behavior.callRpc(usageFetchMethod, {
    resourceId,
    refresh: false,
  })) as {
    observedAt: number | null;
    usage: {
      status: string;
      windows: { kind: string; model: string | null; usedPercent: number }[];
    };
  };
  assert.equal(first.usage.status, "ok");
  assert.equal(first.usage.windows.length, 2);
  assert.equal(first.usage.windows[0]?.kind, "five-hour");
  assert.equal(first.usage.windows[0]?.model, "Gemini");
  assert.equal(first.usage.windows[1]?.kind, "weekly");
  assert.equal(fetchCount, 1);

  // Cached read within TTL avoids re-fetching.
  await harness.behavior.callRpc(usageFetchMethod, { resourceId, refresh: false });
  assert.equal(fetchCount, 1);

  // Explicit refresh bypasses cache.
  await harness.behavior.callRpc(usageFetchMethod, { resourceId, refresh: true });
  assert.equal(fetchCount, 2);
});

test("plugin imports only public SDK subpaths", async () => {
  const scan = await experimental_scanPublicSdkOnly(PLUGIN_ROOT);
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.privateDependencies, []);
});
