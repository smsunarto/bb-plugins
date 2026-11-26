import type { LimitWindow } from "./contracts.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { AntigravityHostBridge } from "./antigravity-login.js";
import type { AntigravityUsageProbe } from "./antigravity-host-contract.js";

export function limitWindowsFromAntigravityProbe(
  probe: AntigravityUsageProbe,
  observedAt: number,
): LimitWindow[] {
  return probe.windows.map((window) => ({
    slot: window.slot,
    windowMinutes: window.windowMinutes,
    utilization: window.utilization,
    resetAt: window.resetAt,
    status: window.utilization >= 1 ? "rejected" : "allowed",
    observedAt,
    source: "usage",
  }));
}

export function createAntigravityAdapter(options: {
  bridge: AntigravityHostBridge | null;
}): ProviderAdapter {
  return {
    provider: "antigravity",
    upstreamName: "Antigravity",
    parseRequest() {
      return {
        family: "other",
        affinityId: null,
        parentAffinityId: null,
        forAccount: () => new Uint8Array(),
      };
    },
    upstreamUrl() {
      throw new Error("Antigravity uses isolated native agy profiles, not HTTP proxying.");
    },
    requestHeaders() {
      return new Headers();
    },
    quotaFromHeaders(_accountId, _headers, previous) {
      return previous;
    },
    isQuotaRejection() {
      return false;
    },
    async refreshSecret(context) {
      return { secret: context.secret, refreshed: false };
    },
    async refreshUsage(context) {
      if (options.bridge === null) return;
      const hostId = context.account.antigravityHostId;
      const profileId = context.account.antigravityProfileId;
      if (!hostId || !profileId) return;
      const now = context.now();
      const prior = context.quotas.get(context.account.id);
      let probe: AntigravityUsageProbe;
      try {
        probe = await options.bridge.probeUsage(hostId, { profileId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.quotas.put({
          ...prior,
          error: `Host unreachable while refreshing Antigravity usage: ${message}`,
        });
        return;
      }
      if (probe.status === "ok") {
        context.quotas.put({
          ...prior,
          limitWindows: limitWindowsFromAntigravityProbe(probe, now),
          observedAt: now,
          error: null,
        });
        return;
      }
      if (probe.status === "no_quota") {
        context.quotas.put({
          ...prior,
          limitWindows: [],
          observedAt: now,
          error: null,
        });
        return;
      }
      context.quotas.put({
        ...prior,
        error: probe.message ?? "Antigravity usage refresh failed.",
      });
    },
    errorResponse(status, message, headers) {
      return Response.json({ error: { message } }, { status, headers });
    },
  };
}
