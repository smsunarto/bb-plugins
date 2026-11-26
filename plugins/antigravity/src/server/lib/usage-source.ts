import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ANTIGRAVITY_PLUGIN_ID, ANTIGRAVITY_PROVIDER_ID } from "../../shared/antigravity.ts";
import {
  usageFetchMethod,
  usageListMethod,
  usageMeasurementSchema,
  usagePlanSchema,
  usageSourceRpcContract,
  usageWindowKindSchema,
  type UsageMeasurement,
  type UsageWindowKind,
} from "./usage-contract.ts";

const CACHE_TTL_MS = 60_000;

const locatorSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const metadataSchema = z.object({
  accountKey: z.string().min(1).nullable().catch(null),
  plan: usagePlanSchema.nullable().catch(null),
});
const windowMetadataSchema = z.object({
  kind: usageWindowKindSchema.optional().catch(undefined),
  model: z.string().nullable().catch(null),
});

function inferWindowKind(label: string): UsageWindowKind {
  const lower = label.toLowerCase();
  if (lower.includes("5-hour") || lower.includes("5h") || lower.includes("session")) {
    return "five-hour";
  }
  if (lower.includes("daily")) {
    return "daily";
  }
  if (lower.includes("weekly")) {
    return "weekly";
  }
  return "custom";
}

function inferWindowModel(label: string): string | null {
  const trimmed = label.trim();
  const match = /^(.+?)\s+(?:5-hour|5h|session|daily|weekly)\b/iu.exec(trimmed);
  return match?.[1]?.trim() || null;
}

export function registerUsageSource(bb: BbPluginApi): void {
  const cache = new Map<string, UsageMeasurement>();
  const pending = new Map<string, { refresh: boolean; promise: Promise<UsageMeasurement> }>();

  const load = async (resourceId: string, refresh: boolean): Promise<UsageMeasurement> => {
    const [hostId, providerId] = locatorSchema.parse(JSON.parse(resourceId));
    const host = await bb.sdk.hosts.get({ hostId }).catch((error: unknown) => {
      if (error instanceof Error && "status" in error && error.status === 404) {
        throw new Error("Usage resource no longer exists.");
      }
      throw error;
    });
    const previous = cache.get(resourceId);
    const unavailable = (message: string) =>
      usageMeasurementSchema.parse({
        accountKey: previous?.accountKey ?? null,
        observedAt: previous?.observedAt ?? null,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message,
        },
      });
    if (host.status === "disconnected") {
      return unavailable("Machine is disconnected.");
    }
    const providers = await bb.sdk.providers.list({ hostId, capability: "usage" });
    if (
      !providers.some(
        (provider) =>
          provider.id === providerId &&
          provider.id === ANTIGRAVITY_PROVIDER_ID &&
          provider.pluginId === ANTIGRAVITY_PLUGIN_ID,
      )
    ) {
      throw new Error("Usage resource no longer exists.");
    }
    if (
      !refresh &&
      previous?.usage.status === "ok" &&
      previous.observedAt !== null &&
      Date.now() - previous.observedAt < CACHE_TTL_MS
    ) {
      return previous;
    }

    try {
      const result = await bb.sdk.system.usageLimits({ hostId, providerId, refresh });
      const usage = result[providerId];
      if (!usage) {
        throw new Error("Provider returned no usage information.");
      }
      const metadata = metadataSchema.parse(usage);
      const value = usageMeasurementSchema.parse({
        accountKey: metadata.accountKey,
        observedAt: usage.status === "ok" ? Date.now() : (previous?.observedAt ?? null),
        usage: {
          accountEmail: null,
          planLabel: null,
          ...usage,
          plan: metadata.plan,
          ...(usage.status === "ok"
            ? {
                windows: usage.windows.map((window, index) => {
                  const windowMeta = windowMetadataSchema.parse(window);
                  return {
                    label: window.label,
                    usedPercent: window.usedPercent,
                    resetsAt: window.resetsAt,
                    kind: windowMeta.kind ?? inferWindowKind(window.label),
                    model: windowMeta.model ?? inferWindowModel(window.label),
                    id: `${index}:${window.label}`,
                    cost: window.cost ?? null,
                  };
                }),
              }
            : {}),
        },
      });
      cache.set(resourceId, value);
      return value;
    } catch {
      return unavailable("Usage could not be collected from this machine.");
    }
  };

  const collect = async (resourceId: string, refresh: boolean): Promise<UsageMeasurement> => {
    const running = pending.get(resourceId);
    if (running) {
      if (!refresh || running.refresh) return running.promise;
      await running.promise.catch(() => undefined);
      return collect(resourceId, refresh);
    }
    const promise = load(resourceId, refresh).finally(() => pending.delete(resourceId));
    pending.set(resourceId, { refresh, promise });
    return promise;
  };

  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const hosts = await bb.sdk.hosts.list();
        const resources = (
          await Promise.all(
            hosts.map(async (host) => {
              const providers = await bb.sdk.providers.list({
                hostId: host.id,
                capability: "usage",
              });
              return providers
                .filter(
                  (provider) =>
                    provider.id === ANTIGRAVITY_PROVIDER_ID &&
                    provider.pluginId === ANTIGRAVITY_PLUGIN_ID,
                )
                .map((provider) => {
                  const id = JSON.stringify([host.id, provider.id]);
                  return {
                    id,
                    accountKey: cache.get(id)?.accountKey ?? null,
                    providerId: provider.id,
                    label: provider.displayName,
                    scope: {
                      kind: "host" as const,
                      hostId: host.id,
                      hostName: host.name,
                    },
                  };
                });
            }),
          )
        ).flat();
        const ids = new Set(resources.map((resource) => resource.id));
        for (const id of cache.keys()) {
          if (!ids.has(id)) cache.delete(id);
        }
        return { resources };
      },
      [usageFetchMethod]: ({ resourceId, refresh }) => collect(resourceId, refresh),
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Host-local Antigravity quota owned by the antigravity provider plugin.",
    },
  );
}
