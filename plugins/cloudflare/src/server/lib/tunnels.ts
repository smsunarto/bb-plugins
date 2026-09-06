import { createHash } from "node:crypto";
import { z } from "zod";
import type { OriginView, RouteDraft, RouteEditor, TunnelTarget } from "../../shared/schema.ts";
import { configSchema, connectorResponseSchema } from "./api.ts";

export class TunnelDraftError extends Error {}

const rawRuleSchema = z
  .object({
    hostname: z.string().optional(),
    path: z.string().optional(),
    service: z.string().min(1),
  })
  .passthrough();
const rawConfigSchema = z
  .object({ ingress: z.array(rawRuleSchema).min(1).max(1001) })
  .passthrough();
export type RawConfiguration = z.infer<typeof configSchema>;
export type EditableConfiguration = z.infer<typeof rawConfigSchema>;
export const canonicalConfiguration = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
export const configurationFingerprint = (value: unknown) =>
  createHash("sha256").update(canonicalConfiguration(value)).digest("hex");
export const sameConfiguration = (a: unknown, b: unknown) =>
  canonicalConfiguration(a) === canonicalConfiguration(b);
export function configurationRevision(raw: RawConfiguration, target: TunnelTarget): string {
  return createHash("sha256")
    .update(
      canonicalConfiguration({
        target: {
          accountId: target.accountId,
          clientId: target.clientId,
          tunnelId: target.tunnelId,
        },
        source: raw.source,
        version: raw.version,
        config: raw.config,
      }),
    )
    .digest("hex");
}
const validHostname = (value: string) =>
  value.length <= 253 &&
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
    value,
  );
const validPath = (value: string) => value.length <= 2048 && !/\p{Cc}/u.test(value);
export function validOrigin(service: string): boolean {
  if (service.length > 4096 || /[\s\\]|\p{Cc}/u.test(service)) return false;
  if (service === "hello_world" || /^http_status:[1-5][0-9]{2}$/.test(service)) return true;
  if (/^unix(?:\+tls)?:\//.test(service)) return !/[?#]/.test(service);
  try {
    const url = new URL(service);
    return (
      ["http:", "https:", "ssh:", "tcp:", "rdp:", "smb:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      (!url.port || (Number(url.port) >= 1 && Number(url.port) <= 65535)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return false;
  }
}
export const originView = (service: string): OriginView =>
  validOrigin(service)
    ? { kind: "plain", service }
    : { kind: "private", label: "Private or unsupported origin. Preserved unless replaced." };
const advancedRule = (rule: Record<string, unknown>) =>
  Object.keys(rule).some((key) => !["hostname", "path", "service"].includes(key));
export function editableConfiguration(raw: RawConfiguration): EditableConfiguration | undefined {
  const parsed = rawConfigSchema.safeParse(raw.config);
  if (!parsed.success) return undefined;
  const rules = parsed.data.ingress;
  const fallback = rules[rules.length - 1]!;
  if (fallback.hostname !== undefined || fallback.path !== undefined) return undefined;
  if (
    rules
      .slice(0, -1)
      .some(
        (rule) =>
          !rule.hostname ||
          !validHostname(rule.hostname) ||
          (rule.path !== undefined && !validPath(rule.path)),
      )
  )
    return undefined;
  return parsed.data;
}
export function inspectConfiguration(raw: RawConfiguration, target: TunnelTarget): RouteEditor {
  if (raw.source !== "cloudflare")
    return {
      kind: "readonly",
      reason: raw.source === "local" ? "local" : "unsupported",
      message: "The configuration is not confirmed as remotely managed by Cloudflare.",
    };
  const config = editableConfiguration(raw);
  if (!config)
    return {
      kind: "readonly",
      reason: "unsupported",
      message:
        "This configuration has unsupported routing rules. Edit it in Cloudflare or the connector configuration.",
    };
  const fallback = config.ingress[config.ingress.length - 1]!;
  return {
    kind: "editable",
    revision: configurationRevision(raw, target),
    ...(raw.version === undefined ? {} : { version: raw.version }),
    advanced: Object.keys(config).some((key) => key !== "ingress"),
    rules: config.ingress.slice(0, -1).map((rule, originalIndex) => ({
      originalIndex,
      hostname: rule.hostname!,
      path: rule.path ?? null,
      origin: originView(rule.service),
      advanced: advancedRule(rule),
    })),
    fallback: originView(fallback.service),
    fallbackAdvanced: advancedRule(fallback),
  };
}
export function applyRouteDraft(
  config: EditableConfiguration,
  draft: RouteDraft[],
): EditableConfiguration {
  const used = new Set<number>();
  const ingress = draft.map((entry) => {
    const patch =
      entry.kind === "new"
        ? { hostname: entry.hostname, path: entry.path, service: entry.service }
        : entry.patch;
    if (patch.hostname !== undefined && !validHostname(patch.hostname))
      throw new TunnelDraftError("Enter a valid public hostname, optionally beginning with *.");
    if (patch.path !== undefined && patch.path !== null && !validPath(patch.path))
      throw new TunnelDraftError("The route path is invalid.");
    if (patch.service !== undefined && !validOrigin(patch.service))
      throw new TunnelDraftError(
        "Enter a supported origin without credentials, query parameters, fragments, or URL paths.",
      );
    let original: z.infer<typeof rawRuleSchema>;
    if (entry.kind === "existing") {
      if (
        !Number.isInteger(entry.originalIndex) ||
        entry.originalIndex < 0 ||
        entry.originalIndex >= config.ingress.length - 1 ||
        used.has(entry.originalIndex)
      )
        throw new TunnelDraftError(
          "A route reference is invalid or repeated. Reload the configuration.",
        );
      used.add(entry.originalIndex);
      original = config.ingress[entry.originalIndex]!;
    } else original = { service: entry.service, hostname: entry.hostname.toLowerCase() };
    const updated = { ...original };
    if (patch.hostname !== undefined) updated.hostname = patch.hostname.toLowerCase();
    if (patch.service !== undefined) updated.service = patch.service;
    if (patch.path === null) delete updated.path;
    else if (patch.path !== undefined) updated.path = patch.path;
    return updated;
  });
  return { ...config, ingress: [...ingress, config.ingress[config.ingress.length - 1]!] };
}

function connectionView(
  connection: NonNullable<z.infer<typeof connectorResponseSchema>["conns"]>[number],
) {
  return {
    ...(connection.id == null ? {} : { id: connection.id }),
    ...(connection.colo_name == null ? {} : { colo: connection.colo_name }),
    ...(connection.opened_at == null ? {} : { openedAt: connection.opened_at }),
    ...(connection.origin_ip == null ? {} : { originIp: connection.origin_ip }),
    ...(connection.client_version == null ? {} : { version: connection.client_version }),
  };
}
export function connectorView(connector: z.infer<typeof connectorResponseSchema>) {
  return {
    ...(connector.id == null ? {} : { id: connector.id }),
    ...(connector.arch == null ? {} : { architecture: connector.arch }),
    ...(connector.version == null ? {} : { version: connector.version }),
    ...(connector.run_at == null ? {} : { startedAt: connector.run_at }),
    ...(connector.config_version == null ? {} : { configVersion: connector.config_version }),
    connections: (connector.conns ?? []).map(connectionView),
  };
}
