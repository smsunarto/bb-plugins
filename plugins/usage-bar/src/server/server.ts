import { makePluginRuntime } from "@bb-plugins/effect-bridge";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Layer } from "effect";
import type { AntigravityReader } from "./lib/antigravity.ts";
import { menuBar } from "./lib/menu-bar.ts";

/** Tests replace the Antigravity reader, which would otherwise run the machine's `agy`. */
export function usageBarPlugin(options: { readAntigravity?: AntigravityReader } = {}) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const runtime = await makePluginRuntime(bb, Layer.empty);
    bb.background.service("menu-bar", {
      start: runtime.service(menuBar(bb, options.readAntigravity)),
    });
  };
}

export default usageBarPlugin();
