import type { Overview, Share } from "../shared/schema.ts";

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";
export type DnsRecord = Overview["dnsRecords"]["items"][number];
export type Tunnel = Overview["tunnels"]["items"][number];

export const TABS = [
  {
    path: "",
    label: "Shares",
    title: "Development shares",
    description: "Each share publishes one local port behind an email allowlist.",
  },
  {
    path: "tunnels",
    label: "Tunnels",
    title: "Account tunnels",
    description:
      "Manage account tunnel names and public routes. Share tunnels stay under share controls.",
  },
  {
    path: "access",
    label: "Access",
    title: "Access applications",
    description: "Read-only inventory. A listed application does not prove that login succeeds.",
  },
  {
    path: "dns",
    label: "DNS",
    title: "DNS records",
    description: "Read-only records across the account's zones, with tunnel associations.",
  },
] as const;
export type TabPath = (typeof TABS)[number]["path"];

export function activeTab(subPath: string) {
  const head = subPath.split("/")[0];
  return TABS.find((tab) => tab.path === head) ?? TABS[0];
}

export function tabCount(overview: Overview | undefined, path: TabPath) {
  if (!overview) return 0;
  if (path === "") return overview.shares.filter((share) => share.state !== "removed").length;
  if (path === "tunnels") return overview.tunnels.items.length;
  if (path === "dns") return overview.dnsRecords.items.length;
  return overview.apps.items.length;
}

export function sectionErrors(overview: Overview) {
  return [
    overview.zones,
    overview.identityProviders,
    overview.tunnels,
    overview.apps,
    overview.policies,
    overview.dnsRecords,
  ].some((section) => section.error);
}

export function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function connectionLabel(oauth: Overview["setup"]["oauth"], hasErrors: boolean) {
  if (!oauth.configured) return "Setup required";
  if (!oauth.connected) return "Not connected";
  return hasErrors ? "Partial access" : "Connected";
}

export function connectionTone(oauth: Overview["setup"]["oauth"], hasErrors: boolean): Tone {
  if (!oauth.configured || !oauth.connected) return "neutral";
  return hasErrors ? "warn" : "good";
}

export function tunnelTone(status: string): Tone {
  if (status === "healthy") return "good";
  if (status === "degraded") return "warn";
  if (status === "down") return "bad";
  return "neutral";
}

export function shareTone(state: Share["state"]): Tone {
  if (state === "running") return "good";
  if (state === "partial") return "bad";
  if (state === "stopped" || state === "removed") return "neutral";
  return "warn";
}

const PROVIDER_TYPES: Record<string, string> = {
  onetimepin: "One-time PIN",
  cloudflare: "Cloudflare",
  google: "Google",
  "google-apps": "Google Workspace",
  github: "GitHub",
  okta: "Okta",
  azureAD: "Microsoft Entra ID",
  saml: "SAML",
  oidc: "OpenID Connect",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  yandex: "Yandex",
  centrify: "Centrify",
  pingone: "PingOne",
  onelogin: "OneLogin",
};

export function identityProviderLabel(provider: { name: string; type: string }) {
  const type = PROVIDER_TYPES[provider.type] ?? provider.type;
  const name = provider.name.trim();
  if (!name) return type;
  return name.toLowerCase() === type.toLowerCase() ? name : `${name} · ${type}`;
}

export function configSourceLabel(source: string) {
  if (source === "cloudflare") return "Remotely managed";
  if (source === "local") return "Locally managed";
  return `${source} configuration`;
}

export const HOSTNAME_SOURCES = {
  dns: "DNS record",
  ingress: "Tunnel ingress only",
  "dns+ingress": "DNS record and tunnel ingress",
} as const;

export function ttlLabel(ttl: number | undefined) {
  if (ttl === undefined) return "";
  return ttl === 1 ? "Auto" : `${ttl}s`;
}

export function dnsTypes(records: DnsRecord[]) {
  return [...new Set(records.map((record) => record.type))].sort();
}

export function filterDnsRecords(
  records: DnsRecord[],
  filters: { query: string; zoneId: string; type: string },
) {
  const query = filters.query.trim().toLowerCase();
  return records.filter(
    (record) =>
      (!filters.zoneId || record.zoneId === filters.zoneId) &&
      (!filters.type || record.type === filters.type) &&
      (!query ||
        [record.name, record.type, record.content].some((value) =>
          value.toLowerCase().includes(query),
        )),
  );
}

export function dnsEmptyMessage(records: DnsRecord[], error?: string) {
  if (records.length > 0) return "No DNS records match these filters.";
  return error ? "No DNS records could be loaded." : "No DNS records found in this account.";
}

export const TUNNEL_EDITOR = {
  manage: "Manage",
  close: "Close editor",
  title: "Manage tunnel",
  loading: "Loading tunnel details…",
  refreshing: "Refreshing tunnel details…",
  loadFailed:
    "Tunnel details could not be loaded. Your draft has been kept. Try loading the details again.",
  changedTarget: "The account connection changed. Reload tunnel details.",
  lostResponse:
    "The save response was lost. The change may have applied. Refresh status to check the server before another save.",
  savedRefreshFailed:
    "The change was confirmed, but fresh details could not be loaded. Discard and reload before another save.",
  reloadRequired:
    "The server is ready. Review your retained draft, then discard and reload the current configuration before saving again.",
  reload: "Reload details",
  refreshStatus: "Refresh status",
  discard: "Discard and reload",
  accountOwner: "Account tunnel",
  shareOwner: "Development share",
  owner: "Managed by",
  shareReadonly: "This tunnel belongs to a development share. Manage it from the Shares tab.",
  name: "Tunnel name",
  saveName: "Save name",
  savingName: "Saving name…",
  saveRoutes: "Save routes",
  savingRoutes: "Saving routes…",
  routes: "Public routes",
  routeOrder: "Routes match from top to bottom. The first matching route handles the request.",
  publicWarning:
    "Saving changes public ingress for this tunnel. DNS records and Access protection are managed separately.",
  conflictWarning:
    "Changes made in Cloudflare during a save can conflict. Reload before editing elsewhere.",
  advanced: "Advanced settings preserved",
  rootAdvanced: "Tunnel-wide advanced settings are preserved when routes are saved.",
  emptyRoutes: "No named public routes. All requests use the fallback.",
  addRoute: "Add route",
  hostname: "Hostname",
  hostnamePlaceholder: "app.example.com",
  path: "Path (optional)",
  pathPlaceholder: "/api/.*",
  origin: "Origin service",
  originPlaceholder: "http://localhost:3000",
  privateOrigin: "Leave empty to preserve the private origin. Enter a service only to replace it.",
  allPaths: "All paths",
  fallback: "Fallback",
  fallbackHelp:
    "Unmatched requests use this final rule. The fallback is preserved and cannot be edited here.",
  up: "Move up",
  down: "Move down",
  remove: "Remove",
  connectors: "Connectors",
  noConnectors: "No connectors were reported by Cloudflare.",
  connectorId: "Connector ID",
  architecture: "Architecture",
  version: "cloudflared version",
  startedAt: "Started",
  configVersion: "Applied config version",
  connectionId: "Connection ID",
  colo: "Cloudflare location",
  openedAt: "Opened",
  originIp: "Origin IP",
  noConnections: "No connections were reported for this connector.",
  unavailable: "Unavailable",
  observedAt: "Observed",
  configLag:
    "This connector reports an older configuration version. It may still be applying the saved configuration.",
  readonly: {
    local: "Routes are managed on the connector host.",
    unsupported: "This configuration cannot be edited safely here.",
    share: "Routes belong to a development share.",
  },
} as const;
export const tunnelRouteLabel = (index: number) => `Route ${index + 1}`;
export const tunnelRouteActionLabel = (action: string, index: number) =>
  `${action} route ${index + 1}`;
export const tunnelConnectorLabel = (index: number) => `Connector ${index + 1}`;
export const tunnelConnectionLabel = (index: number) => `Connection ${index + 1}`;
export const tunnelConfigVersionLabel = (version: number) => `Configuration version ${version}`;
