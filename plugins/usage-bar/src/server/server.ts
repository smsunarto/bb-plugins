import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { runMenuBar } from "./lib/menu-bar.ts";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.background.service("menu-bar", { start: (signal) => runMenuBar(bb, signal) });
}
