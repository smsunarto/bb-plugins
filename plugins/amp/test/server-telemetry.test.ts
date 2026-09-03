import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sentryErrorReporter, type SentryPluginFailure } from "@bb-kit/sentry/node";
import { createAmpPlugin } from "../server.ts";

test("Amp enables scrubbed telemetry through its plugin setting", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "amp" });
  // The default export only reports once `bb plugin build` has written
  // dist/server.meta.json, which a source checkout (and CI) lacks. Inject a
  // reporter so the test covers Amp's own wiring: handing bb to the reporter
  // is what injects the opt-out setting.
  const plugin = createAmpPlugin(sentryErrorReporter({ dsn: "https://key@localhost:1/1" }));

  await plugin(bb);
  expect(harness.inspection.registrations.settingsDescriptors.telemetry).toMatchObject({
    type: "boolean",
    default: true,
  });

  await harness.lifecycle.dispose();
});

test("Amp reports rejected server callbacks and disposes its reporter", async () => {
  const failure = new Error("private server failure");
  const failures: SentryPluginFailure[] = [];
  let disposeCount = 0;
  const plugin = createAmpPlugin(() => ({
    capture(captured) {
      failures.push(captured);
      return undefined;
    },
    async dispose() {
      disposeCount += 1;
    },
  }));
  const { bb, harness } = createFakePluginHost({
    pluginId: "amp",
    sdk: {
      threads: {
        get: async () => {
          throw failure;
        },
      },
    },
  });

  await plugin(bb);
  await expect(harness.behavior.callRpc("getOrbUsage", { threadId: "thread-1" })).rejects.toThrow(
    "private server failure",
  );
  expect(failures).toEqual([{ boundary: "rpc.execute", operation: "getOrbUsage", error: failure }]);

  await harness.lifecycle.dispose();
  expect(disposeCount).toBe(1);
});
