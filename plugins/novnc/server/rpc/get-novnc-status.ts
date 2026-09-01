import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { NOVNC_PORT, novncHostContract } from "../../shared/node/novnc-contract.ts";

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const getNovncStatus = defineQuery({
  input: z.object({ threadId: z.string() }).strict(),
  output: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ready"), url: z.string() }).strict(),
    z
      .object({
        state: z.literal("unavailable"),
        reason: z.enum(["no-host", "tunnel-unavailable", "not-running"]),
        detail: z.string().optional(),
      })
      .strict(),
  ]),
  async execute(ctx, { threadId }) {
    const thread = await ctx.bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) {
      return { state: "unavailable" as const, reason: "no-host" as const };
    }
    const environment = await ctx.bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (!environment.hostId) {
      return { state: "unavailable" as const, reason: "no-host" as const };
    }
    let tunnel: { label: string; baseDomain: string };
    try {
      // declareSharedPorts replaces this plugin's whole port set for the host,
      // so redeclaring [6080] on every call stays idempotent.
      ctx.bb.hosts.declareSharedPorts(environment.hostId, [NOVNC_PORT]);
      tunnel = await ctx.bb.hosts.ensureSharedPortTunnel(environment.hostId);
    } catch (error) {
      return {
        state: "unavailable" as const,
        reason: "tunnel-unavailable" as const,
        detail: detailOf(error),
      };
    }
    // Reachability is probed from the host itself: the gate tunnel
    // authenticates before routing, so a server-side GET through it
    // answers 401 for every port whether or not NoVNC listens.
    try {
      const client = ctx.bb.hosts.experimental_client({ contract: novncHostContract });
      const probe = await client.call("checkNovnc", {}, { hostId: environment.hostId });
      if (!probe.running) {
        return {
          state: "unavailable" as const,
          reason: "not-running" as const,
          detail: probe.detail,
        };
      }
    } catch (error) {
      return {
        state: "unavailable" as const,
        reason: "not-running" as const,
        detail: detailOf(error),
      };
    }
    return {
      state: "ready" as const,
      url: `https://${tunnel.label}--${NOVNC_PORT}.${tunnel.baseDomain}/vnc.html?resize=remote`,
    };
  },
});

export type NovncStatus = z.infer<(typeof getNovncStatus)["output"]>;
