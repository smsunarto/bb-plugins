import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { runMenuBar } from "../src/server/lib/menu-bar.ts";

test.skipIf(process.platform !== "darwin")(
  "native service stops when the source RPC never resolves",
  async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const abort = new AbortController();
    const original = process.env.BB_USAGE_BAR_ANY_INSTANCE;
    process.env.BB_USAGE_BAR_ANY_INSTANCE = "1";
    const { bb, harness } = createFakePluginHost({
      pluginId: "usage-bar",
      sdk: {
        plugins: {
          experimental_discoverRpc: () => {
            markStarted();
            return new Promise(() => {});
          },
        },
      },
    });
    const running = runMenuBar(bb, abort.signal).then(() => "stopped");
    try {
      await started;
      abort.abort();
      expect(await running).toBe("stopped");
    } finally {
      abort.abort();
      await harness.lifecycle.dispose();
      if (original === undefined) delete process.env.BB_USAGE_BAR_ANY_INSTANCE;
      else process.env.BB_USAGE_BAR_ANY_INSTANCE = original;
    }
  },
  15_000,
);
