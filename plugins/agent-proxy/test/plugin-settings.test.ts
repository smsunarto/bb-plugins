import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_AGENT_PROXY_SETTINGS,
  normalizeAgentProxySettings,
} from "../lib/plugin-settings.ts";

test("normalizes legacy declarative settings into plugin-owned settings", () => {
  assert.deepEqual(
    normalizeAgentProxySettings({
      autostart: false,
      cloudflareQuickTunnelForCursor: true,
      port: "9417",
      sourceRepository: " example/proxy ",
      sourceBranch: " feature/settings ",
      routingStrategy: "fill-first",
      managementKey: "never persisted with non-secret settings",
    }),
    {
      autostart: false,
      cloudflareQuickTunnelForCursor: true,
      port: 9417,
      sourceRepository: "example/proxy",
      sourceBranch: "feature/settings",
      routingStrategy: "fill-first",
    },
  );
});

test("invalid stored values fall back to safe defaults", () => {
  assert.deepEqual(
    normalizeAgentProxySettings({
      autostart: "yes",
      cloudflareQuickTunnelForCursor: null,
      port: 70_000,
      sourceRepository: " ",
      sourceBranch: "",
      routingStrategy: "random",
    }),
    DEFAULT_AGENT_PROXY_SETTINGS,
  );
});

test("a persisted port with a numeric prefix falls back to the default", () => {
  assert.equal(
    normalizeAgentProxySettings({ port: "9417garbage" }).port,
    DEFAULT_AGENT_PROXY_SETTINGS.port,
  );
});
