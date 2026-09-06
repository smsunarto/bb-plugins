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
    description: "Read-only inventory. Share controls manage only tunnels created by this plugin.",
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
