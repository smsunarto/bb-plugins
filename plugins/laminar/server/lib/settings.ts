import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { LAMINAR_SETTINGS } from "../../shared/settings.ts";

function createSettings(bb: BbPluginApi) {
  return bb.settings.define(LAMINAR_SETTINGS);
}

type LaminarSettingsHandle = ReturnType<typeof createSettings>;

const handles = new WeakMap<BbPluginApi, LaminarSettingsHandle>();

export function laminarSettings(bb: BbPluginApi) {
  const existing = handles.get(bb);
  if (existing !== undefined) return existing;
  const created = createSettings(bb);
  handles.set(bb, created);
  return created;
}
