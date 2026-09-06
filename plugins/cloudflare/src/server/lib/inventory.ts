import { isIP } from "node:net";
import type { Overview } from "../../shared/schema.ts";
import { CloudflareAPI, CloudflareError, dnsSchema, ingressConfigSchema } from "./api.ts";

type Tunnel = Overview["tunnels"]["items"][number];
type DNSRecord = Overview["dnsRecords"]["items"][number];
type IngressRule = { hostname?: string; service: string };
const READ_CONCURRENCY = 4;
const normalizeName = (value: string) => value.toLowerCase().replace(/\.$/, "");
const readError = (error: unknown) =>
  error instanceof CloudflareError
    ? error.message
    : "Cloudflare inventory could not be read. Check permissions and retry.";

export const tunnelDNSTarget = (id: string) => `${normalizeName(id)}.cfargotunnel.com`;

async function mapReads<T, R>(values: T[], read: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await read(values[index]!);
      }
    }),
  );
  return results;
}

function browserURL(hostname: string): string | undefined {
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    labels.length < 2 ||
    isIP(hostname) ||
    !/[a-z]/.test(labels.at(-1)!) ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return;
  try {
    const url = new URL(`https://${hostname}`);
    return url.hostname === hostname ? url.origin : undefined;
  } catch {
    return;
  }
}

function isHTTPService(service: string): boolean {
  try {
    const url = new URL(service);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function ingressMatches(pattern: string, hostname: string): boolean {
  return (
    pattern === hostname ||
    (pattern.startsWith("*.") &&
      hostname.endsWith(pattern.slice(1)) &&
      hostname.length > pattern.length - 1)
  );
}

function publicHostnames(records: DNSRecord[], ingress: IngressRule[]): Tunnel["publicHostnames"] {
  const hostnames = new Map<string, { dns: boolean; ingress: boolean; browser: boolean }>();
  for (const record of records) {
    const hostname = normalizeName(record.name);
    if (hostname) hostnames.set(hostname, { dns: true, ingress: false, browser: true });
  }
  for (const rule of ingress) {
    if (!rule.hostname) continue;
    const hostname = normalizeName(rule.hostname);
    const browser = isHTTPService(rule.service);
    // A known non-HTTP ingress must not become a browser link merely because DNS exists.
    // Apply wildcard rules to observed DNS names too, while retaining the wildcard as text.
    for (const [existing, entry] of hostnames) {
      if (entry.dns && ingressMatches(hostname, existing)) {
        entry.ingress = true;
        entry.browser &&= browser;
      }
    }
    const current = hostnames.get(hostname);
    if (current) {
      current.ingress = true;
      current.browser &&= browser;
    } else hostnames.set(hostname, { dns: false, ingress: true, browser });
  }
  return [...hostnames]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hostname, entry]) => {
      const url = entry.browser ? browserURL(hostname) : undefined;
      const entryResult: Tunnel["publicHostnames"][number] = {
        hostname,
        source: entry.dns ? (entry.ingress ? "dns+ingress" : "dns") : "ingress",
      };
      if (url) entryResult.url = url;
      return entryResult;
    });
}

async function readDNSRecords(
  api: CloudflareAPI,
  zones: Overview["zones"],
  tunnels: Tunnel[],
): Promise<Overview["dnsRecords"]> {
  const tunnelByTarget = new Map(tunnels.map((tunnel) => [tunnel.dnsTarget, tunnel.id]));
  const zoneResults = await mapReads(zones.items, async (zone) => {
    try {
      const records = await api.list(
        `/zones/${encodeURIComponent(zone.id)}/dns_records`,
        dnsSchema,
      );
      return {
        items: records.map((record): DNSRecord => {
          const tunnelId =
            record.type.toUpperCase() === "CNAME"
              ? tunnelByTarget.get(normalizeName(record.content))
              : undefined;
          const item: DNSRecord = {
            id: record.id,
            zoneId: zone.id,
            zoneName: zone.name,
            name: record.name,
            type: record.type,
            content: record.content,
          };
          if (record.proxied !== undefined) item.proxied = record.proxied;
          if (record.ttl !== undefined) item.ttl = record.ttl;
          if (tunnelId !== undefined) item.tunnelId = tunnelId;
          return item;
        }),
      };
    } catch (error) {
      return { items: [], error: `${zone.name}: ${readError(error)}` };
    }
  });
  const errors = [
    ...(zones.error ? [`Zone discovery: ${zones.error}`] : []),
    ...zoneResults.flatMap((result) => (result.error ? [result.error] : [])),
  ];
  return {
    items: zoneResults.flatMap((result) => result.items),
    ...(errors.length ? { error: `DNS inventory is incomplete. ${errors.join(" ")}` } : {}),
  };
}

export async function readNetworkInventory(
  api: CloudflareAPI,
  accountId: string,
  zones: Overview["zones"],
  tunnels: Tunnel[],
): Promise<{ dnsRecords: Overview["dnsRecords"]; tunnels: Tunnel[] }> {
  // The two bounded pools cap this phase at eight Cloudflare requests in flight.
  const [dnsRecords, tunnelIngress] = await Promise.all([
    readDNSRecords(api, zones, tunnels),
    mapReads(tunnels, async (tunnel) => {
      if (tunnel.configSource !== "cloudflare") return { ingress: [] };
      try {
        const result = await api.request(
          "GET",
          `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}/configurations`,
          ingressConfigSchema,
        );
        return { ingress: result.config?.ingress ?? [] };
      } catch (error) {
        return { ingress: [], error: readError(error) };
      }
    }),
  ]);
  const dnsByTunnel = new Map<string, DNSRecord[]>();
  for (const record of dnsRecords.items) {
    if (!record.tunnelId) continue;
    const records = dnsByTunnel.get(record.tunnelId) ?? [];
    records.push(record);
    dnsByTunnel.set(record.tunnelId, records);
  }
  return {
    dnsRecords,
    tunnels: tunnels.map((tunnel, index) => {
      const read = tunnelIngress[index]!;
      return {
        ...tunnel,
        publicHostnames: publicHostnames(dnsByTunnel.get(tunnel.id) ?? [], read.ingress),
        ...(read.error ? { hostnameError: read.error } : {}),
      };
    }),
  };
}
