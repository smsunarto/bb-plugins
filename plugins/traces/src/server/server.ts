import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { TracesContext } from "./lib/context.ts";
import { overview, overviewContract } from "./rpc/overview.ts";
import { status, statusContract } from "./rpc/status.ts";
import { scan, scanContract } from "./rpc/scan.ts";
import { configureSources, configureSourcesContract } from "./rpc/configure-sources.ts";
import { sessions, sessionsContract } from "./rpc/sessions.ts";
import { events, eventsContract } from "./rpc/events.ts";
import { event, eventContract } from "./rpc/event.ts";
import { raw, rawContract } from "./rpc/raw.ts";

export const contract = defineRpcContract({
  overview: overviewContract,
  status: statusContract,
  scan: scanContract,
  configureSources: configureSourcesContract,
  sessions: sessionsContract,
  events: eventsContract,
  event: eventContract,
  raw: rawContract,
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx: TracesContext = Object.freeze({ bb });
  bb.rpc.register(contract, {
    overview: (input) => overview(ctx, input),
    status: (input) => status(ctx, input),
    scan: (input) => scan(ctx, input),
    configureSources: (input) => configureSources(ctx, input),
    sessions: (input) => sessions(ctx, input),
    events: (input) => events(ctx, input),
    event: (input) => event(ctx, input),
    raw: (input) => raw(ctx, input),
  });
}
