import { definePlugin } from "@bb-kit/core/plugin";
import { overview } from "./rpc/overview.ts";
import { status } from "./rpc/status.ts";
import { scan } from "./rpc/scan.ts";
import { configureSources } from "./rpc/configure-sources.ts";
import { sessions } from "./rpc/sessions.ts";
import { events } from "./rpc/events.ts";
import { event } from "./rpc/event.ts";
import { raw } from "./rpc/raw.ts";

export default definePlugin({
  pluginId: "traces",
  rpc: { overview, status, scan, configureSources, sessions, events, event, raw },
});
