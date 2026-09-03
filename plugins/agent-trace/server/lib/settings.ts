import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { AGENT_TRACE_SETTINGS } from "../../shared/settings.ts";

function createSettings(bb: BbPluginApi) {
  return bb.settings.define(AGENT_TRACE_SETTINGS);
}

type AgentTraceSettingsHandle = ReturnType<typeof createSettings>;

const handles = new WeakMap<BbPluginApi, AgentTraceSettingsHandle>();

export function agentTraceSettings(bb: BbPluginApi) {
  const existing = handles.get(bb);
  if (existing !== undefined) return existing;
  const created = createSettings(bb);
  handles.set(bb, created);
  return created;
}
