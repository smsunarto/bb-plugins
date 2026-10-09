import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import { createStatus } from "./status.ts";

test("status names this bb plugin, in upstream Desktop's key order, with nothing machine-local", () => {
  const { bb } = createFakePluginHost({
    pluginId: "whiteboard",
    appUrl: "https://scott.getbb.app",
    loopbackBaseUrl: "http://127.0.0.1:40000",
    dataDir: "/data/bb",
  });
  const status = createStatus(bb)();
  expect(Object.keys(status)).toEqual([
    "key",
    "channel",
    "checkout",
    "appVersion",
    "cliVersion",
    "instanceId",
    "url",
    "home",
  ]);
  // The agent may run on another machine: no server loopback URL or data dir.
  expect(status).toEqual({
    key: "stable",
    channel: "bb-plugin",
    checkout: null,
    appVersion: "0.1.0",
    cliVersion: null,
    instanceId: "https://scott.getbb.app",
    url: null,
    home: null,
  });
});

test("without a public app URL the instance id is null", () => {
  const { bb } = createFakePluginHost({
    pluginId: "whiteboard",
    loopbackBaseUrl: "http://127.0.0.1:40000",
    dataDir: "/data/bb",
  });
  expect(createStatus(bb)()).toMatchObject({ instanceId: null, url: null, home: null });
});
