import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("the headless plugin registers its service and reports missing configuration", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "agent-trace" });

  await plugin(bb);

  expect(harness.registrations.rpcMethods).toEqual([]);
  expect(harness.registrations.cli?.commands.map((command) => command.name)).toEqual([
    "backfill",
    "rpc",
  ]);
  expect(
    harness.registrations.httpRoutes.map(({ method, path, auth }) => ({ method, path, auth })),
  ).toEqual([{ method: "POST", path: "/remote-session", auth: "local" }]);
  expect(harness.registrations.services.map((service) => service.name)).toEqual(["trace-pump"]);
  expect(harness.registrations.settingsDescriptors.laminarApiKey).toEqual(
    expect.objectContaining({ type: "string", secret: true }),
  );
  expect(harness.registrations.settingsDescriptors.langfuseSecretKey).toEqual(
    expect.objectContaining({ type: "string", secret: true }),
  );
  expect(harness.needsConfigurationMessages).toEqual([
    "Set a Laminar project API key or Langfuse public and secret keys in plugin settings.",
  ]);
  await harness.dispose();
});

test("invalid endpoints report needs-configuration without crashing setup", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-trace",
    settings: {
      laminarApiKey: "secret",
      laminarEndpoint: "ftp://example.com/v1/traces",
      langfuseBaseUrl: "https://cloud.langfuse.com",
      deploymentEnvironment: "test",
      contentMode: "metadata",
    },
  });

  await plugin(bb);

  expect(harness.needsConfigurationMessages).toEqual([
    "Set a valid HTTP or HTTPS Laminar endpoint ending in /v1/traces.",
  ]);
  expect(harness.registrations.services).toHaveLength(1);
  await harness.dispose();
});
