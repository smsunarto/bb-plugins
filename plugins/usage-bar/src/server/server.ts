import { makePluginRuntime } from "@bb-plugins/effect-bridge";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Layer } from "effect";
import { menuBar } from "./lib/menu-bar.ts";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const runtime = await makePluginRuntime(bb, Layer.empty);
  bb.background.service("menu-bar", { start: runtime.service(menuBar(bb)) });
}
