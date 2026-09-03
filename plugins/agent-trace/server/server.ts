import { definePlugin } from "@bb-kit/core/plugin";
import { parseAgentTraceSettings, type AgentTraceConfig } from "../shared/settings.ts";
import { backfill } from "./command/backfill.ts";
import { createRemoteSessionResponse } from "./remote-session.ts";
import { agentTraceSettings } from "./lib/settings.ts";
import { TracePump } from "./trace-pump.ts";

export default definePlugin({
  pluginId: "agent-trace",
  command: { backfill },
  rpc: {},
  async setup(bb) {
    const settings = agentTraceSettings(bb);
    let parsed = parseAgentTraceSettings(await settings.get());
    let config: AgentTraceConfig | null = parsed.ok ? parsed.value : null;
    if (!parsed.ok) bb.status.needsConfiguration(parsed.message);

    const pump = new TracePump({ bb, getConfig: () => config });
    bb.http.route(
      "POST",
      "/remote-session",
      (context) =>
        createRemoteSessionResponse(bb, {
          forwardedHost: context.req.header("x-forwarded-host"),
          gateAuth: context.req.header("x-bb-gate-auth"),
          host: context.req.header("host"),
          requestUrl: context.req.url,
        }),
      { auth: "local" },
    );
    settings.onChange((next) => {
      parsed = parseAgentTraceSettings(next);
      config = parsed.ok ? parsed.value : null;
      if (!parsed.ok) bb.status.needsConfiguration(parsed.message);
      pump.configurationChanged();
    });

    bb.background.service("trace-pump", {
      start: (signal) => pump.run(signal),
    });
  },
});
