import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { NEATLOGS_SETTINGS, parseNeatlogsSettings } from "./settings.ts";
import { TracePump } from "./trace-pump.ts";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define(NEATLOGS_SETTINGS);
  let config = parseNeatlogsSettings(await settings.get());
  if (config === null) {
    bb.status.needsConfiguration(
      "Set the Neatlogs project API key: bb plugin config neatlogs set apiKey <key>.",
    );
  }

  const pump = new TracePump({ bb, getConfig: () => config });
  settings.onChange((next) => {
    config = parseNeatlogsSettings(next);
    pump.configurationChanged();
  });
  bb.background.service("trace-pump", { start: (signal) => pump.run(signal) });
}
