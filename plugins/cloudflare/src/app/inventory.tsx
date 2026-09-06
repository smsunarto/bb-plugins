import { useState } from "react";
import type { Overview } from "../shared/schema.ts";

type DnsRecord = Overview["dnsRecords"]["items"][number];
type Tunnel = Overview["tunnels"]["items"][number];

function CopyButton({ value, label }: { value: string; label: string }) {
  const [result, setResult] = useState<{ value: string; failed: boolean } | null>(null);
  const copied = result?.value === value && !result.failed;
  const failed = result?.value === value && result.failed;
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setResult({ value, failed: false });
    } catch {
      setResult({ value, failed: true });
    }
  }
  return (
    <div className="cf-copy">
      <button type="button" onClick={() => void copy()} aria-label={`${label}: ${value}`}>
        {copied ? "Copied" : label}
      </button>
      {copied && <output className="cf-sr-only">Copied to clipboard.</output>}
      {failed && (
        <p className="cf-copy-error" role="alert">
          Copy failed. Select and copy the value.
        </p>
      )}
    </div>
  );
}

const HOSTNAME_SOURCES = {
  dns: "DNS record",
  ingress: "Tunnel ingress",
  "dns+ingress": "DNS record and tunnel ingress",
} as const;

export function TunnelLinks({ tunnel }: { tunnel: Tunnel }) {
  return (
    <div className="cf-tunnel-links">
      <h3>Public hostnames</h3>
      {tunnel.hostnameError && (
        <div className="cf-notice cf-error" role="alert">
          Hostname inventory is incomplete. {tunnel.hostnameError}
        </div>
      )}
      {tunnel.publicHostnames.length === 0 && <p>No public hostnames were found.</p>}
      <ul className="cf-hostname-list">
        {tunnel.publicHostnames.map((hostname) => (
          <li className="cf-row cf-wrap" key={hostname.hostname}>
            <div>
              <p className="cf-hostname">
                {hostname.url ? (
                  <a href={hostname.url} target="_blank" rel="noreferrer">
                    {hostname.hostname}
                  </a>
                ) : (
                  hostname.hostname
                )}
              </p>
              <p className="cf-help">{HOSTNAME_SOURCES[hostname.source]}</p>
            </div>
            {hostname.url && (
              <div className="cf-actions">
                <a
                  className="cf-button"
                  href={hostname.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${hostname.hostname}`}
                >
                  Open
                </a>
                <CopyButton value={hostname.url} label="Copy URL" />
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="cf-routing-target">
        <h3>DNS routing target</h3>
        <div className="cf-row cf-wrap">
          <code className="cf-mono">{tunnel.dnsTarget}</code>
          <CopyButton value={tunnel.dnsTarget} label="Copy target" />
        </div>
        <p className="cf-help">Use as a CNAME target. This is not a website URL.</p>
      </div>
    </div>
  );
}

function DnsRecordCard({ record, tunnel }: { record: DnsRecord; tunnel?: Tunnel }) {
  return (
    <article className="cf-card cf-dns-record">
      <div className="cf-row cf-wrap">
        <div>
          <h3 className="cf-hostname">{record.name}</h3>
          <p>{record.zoneName}</p>
        </div>
        <div className="cf-actions">
          <span className="cf-badge">{record.type}</span>
          {record.proxied !== undefined && (
            <span className="cf-badge">{record.proxied ? "Proxied" : "DNS only"}</span>
          )}
        </div>
      </div>
      <dl className="cf-dns-value">
        <dt>Content</dt>
        <dd>
          <code>{record.content || "Empty"}</code>
        </dd>
      </dl>
      {record.tunnelId && (
        <p>
          Tunnel: <strong>{tunnel?.name ?? record.tunnelId}</strong>
        </p>
      )}
      <details className="cf-dns-details">
        <summary>Record details</summary>
        <dl className="cf-resources">
          <dt>Record ID</dt>
          <dd>{record.id}</dd>
          <dt>Zone ID</dt>
          <dd>{record.zoneId}</dd>
          {record.ttl !== undefined && (
            <>
              <dt>TTL</dt>
              <dd>{record.ttl === 1 ? "Automatic" : `${record.ttl} seconds`}</dd>
            </>
          )}
          {record.tunnelId && (
            <>
              <dt>Tunnel ID</dt>
              <dd>{record.tunnelId}</dd>
            </>
          )}
        </dl>
      </details>
    </article>
  );
}

function dnsEmptyMessage(records: DnsRecord[], error?: string) {
  if (records.length > 0) return "No DNS records match these filters.";
  return error ? "No DNS records could be loaded." : "No DNS records found in this account.";
}

export function DnsInventory({ overview }: { overview: Overview }) {
  const [search, setSearch] = useState("");
  const [zoneId, setZoneId] = useState("");
  const records = overview.dnsRecords.items;
  const query = search.trim().toLowerCase();
  const zones = new Map(overview.zones.items.map((zone) => [zone.id, zone.name]));
  for (const record of records) zones.set(record.zoneId, record.zoneName);
  const matches = records.filter(
    (record) =>
      (!zoneId || record.zoneId === zoneId) &&
      [record.name, record.type, record.content].some((value) =>
        value.toLowerCase().includes(query),
      ),
  );
  const tunnels = new Map(overview.tunnels.items.map((tunnel) => [tunnel.id, tunnel]));
  return (
    <section aria-label="DNS inventory">
      {overview.dnsRecords.error && (
        <div className="cf-notice cf-error" role="alert">
          {overview.dnsRecords.error}
        </div>
      )}
      <div className="cf-dns-filters">
        <label htmlFor="cf-dns-search">
          Search records
          <input
            id="cf-dns-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, type or content"
          />
        </label>
        <label htmlFor="cf-dns-zone">
          Zone
          <select
            id="cf-dns-zone"
            value={zoneId}
            onChange={(event) => setZoneId(event.target.value)}
          >
            <option value="">All zones</option>
            {[...zones]
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="cf-row cf-dns-results">
        <output>
          {matches.length} of {records.length} loaded records
        </output>
        <button
          type="button"
          disabled={!search && !zoneId}
          onClick={() => {
            setSearch("");
            setZoneId("");
          }}
        >
          Clear filters
        </button>
      </div>
      {matches.length === 0 && (
        <div className="cf-empty">{dnsEmptyMessage(records, overview.dnsRecords.error)}</div>
      )}
      <div className="cf-stack">
        {matches.map((record) => (
          <DnsRecordCard
            key={`${record.zoneId}:${record.id}`}
            record={record}
            tunnel={record.tunnelId ? tunnels.get(record.tunnelId) : undefined}
          />
        ))}
      </div>
    </section>
  );
}
