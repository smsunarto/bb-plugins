import { z } from "zod";
import type { MenuAccount, MenuProvider, MenuWindow } from "./pool.ts";
import { timestampSchema } from "./pool.ts";

/**
 * Usage from bb's built-in providers when Account Pooler is not available. They
 * publish the discoverable `provider-usage.v1` contract (bb
 * `plugins/provider-codex/src/usage-contract.ts`): one resource per host, the
 * account signed in to that host's CLI. The menu bar is on this Mac, so only the
 * primary host's resources are shown.
 */

export const USAGE_LIST_METHOD = "provider-usage.v1.listResources";
export const USAGE_FETCH_METHOD = "provider-usage.v1.getResource";

/** Resource `providerId` → menu provider. */
const PROVIDERS: Record<string, MenuProvider["id"]> = {
  codex: "codex",
  claude: "claude",
  "claude-code": "claude",
};

export const resourceListSchema = z.object({
  resources: z.array(
    z.object({
      id: z.string(),
      providerId: z.string(),
      label: z.string(),
      scope: z.union([
        z.object({ kind: z.literal("shared") }),
        z.object({ kind: z.literal("host"), hostId: z.string() }),
      ]),
    }),
  ),
});

const accountFields = {
  accountEmail: z.string().nullish(),
  planLabel: z.string().nullish(),
};

export const measurementSchema = z.object({
  accountKey: z.string().nullable().default(null),
  observedAt: timestampSchema,
  usage: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      ...accountFields,
      windows: z.array(
        z.object({
          kind: z.enum(["five-hour", "daily", "weekly", "custom"]).catch("custom"),
          label: z.string(),
          usedPercent: z.number(),
          resetsAt: z.string().nullable(),
          model: z.string().nullable(),
        }),
      ),
    }),
    z.object({ status: z.literal("not_installed"), ...accountFields }),
    z.object({ status: z.literal("unauthenticated"), ...accountFields }),
    z.object({ status: z.literal("expired"), ...accountFields }),
    z.object({ status: z.literal("error"), ...accountFields, message: z.string() }),
  ]),
});

export type Measurement = z.infer<typeof measurementSchema>;
type Resource = z.infer<typeof resourceListSchema>["resources"][number];
type UsageWindow = Extract<Measurement["usage"], { status: "ok" }>["windows"][number];

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function menuWindow(window: UsageWindow): MenuWindow {
  const resetAt = window.resetsAt === null ? null : Date.parse(window.resetsAt);
  const shared = {
    usedPercent: Math.min(100, Math.max(0, Math.round(window.usedPercent * 100) / 100)),
    resetAt: resetAt !== null && Number.isFinite(resetAt) ? resetAt : null,
  };
  switch (window.kind) {
    case "five-hour":
      return { ...shared, label: "Session", windowMinutes: 300, model: null };
    case "daily":
      return { ...shared, label: "Daily", windowMinutes: 1440, model: null };
    case "weekly":
      return {
        ...shared,
        label: window.model === null ? "Weekly" : `${capitalize(window.model)} weekly`,
        windowMinutes: 10080,
        model: window.model,
      };
    case "custom":
      return { ...shared, label: window.label, windowMinutes: null, model: null };
  }
}

/** One resource's measurement as a menu account, or null when its CLI is not installed. */
export function builtinAccount(
  key: string,
  resource: Resource,
  measurement: Measurement,
  position: number,
): MenuAccount | null {
  const { usage } = measurement;
  if (usage.status === "not_installed") return null;
  const error =
    usage.status === "unauthenticated"
      ? "Not signed in"
      : usage.status === "expired"
        ? "Sign-in expired"
        : usage.status === "error"
          ? "Usage unavailable. Check the provider in bb."
          : null;
  return {
    id: measurement.accountKey ? `${key}:${measurement.accountKey}` : key,
    identity: usage.accountEmail ?? resource.label,
    plan: usage.planLabel ?? null,
    status: error === null ? "ready" : "error",
    current: position === 1,
    lastUsedAt: null,
    observedAt: measurement.observedAt,
    heldUntil: null,
    error,
    inFlight: 0,
    windows: usage.status === "ok" ? usage.windows.map(menuWindow) : [],
  };
}

export function builtinProvider(resource: Resource): MenuProvider["id"] | null {
  return PROVIDERS[resource.providerId] ?? null;
}

export function onHost(resource: Resource, hostId: string | null): boolean {
  return resource.scope.kind === "shared" || resource.scope.hostId === hostId;
}
