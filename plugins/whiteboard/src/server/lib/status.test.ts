import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import { createStatus } from "./status.ts";

test("status names this bb plugin, in upstream Desktop's key order", () => {
  const { bb } = createFakePluginHost({
    pluginId: "whiteboard",
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
  expect(status).toEqual({
    key: "stable",
    channel: "bb-plugin",
    checkout: null,
    appVersion: "0.1.0",
    cliVersion: null,
    instanceId: "http://127.0.0.1:40000",
    url: null,
    home: "/data/bb",
  });
});

test("server fields that are not bound yet read as null", () => {
  const { bb } = createFakePluginHost({ pluginId: "whiteboard" });
  const unbound = Object.create(bb) as typeof bb;
  Object.defineProperty(unbound, "server", {
    value: {
      get loopbackBaseUrl(): string {
        throw new Error("not bound");
      },
      get experimental_dataDir(): string {
        throw new Error("not bound");
      },
    },
  });
  expect(createStatus(unbound)()).toMatchObject({ instanceId: null, home: null });
});
