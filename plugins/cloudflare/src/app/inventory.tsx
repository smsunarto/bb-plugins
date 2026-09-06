import { useState } from "react";
import type { Overview } from "../shared/schema.ts";
import {
  HOSTNAME_SOURCES,
  configSourceLabel,
  dnsEmptyMessage,
  dnsTypes,
  filterDnsRecords,
  plural,
  titleCase,
  ttlLabel,
  tunnelTone,
} from "./labels.ts";
import type { DnsRecord, Tunnel } from "./labels.ts";
import { Badge, CopyButton, EmptyState, KeyValue, Label, Mono, Notice } from "./ui.tsx";

export function TunnelLinks({ tunnel }: { tunnel: Tunnel }) {
  return (
    <>
      <div className="cf-subsection">
        <Label>Public hostnames</Label>
        {tunnel.hostnameError && (
          <Notice error>Hostname inventory is incomplete. {tunnel.hostnameError}</Notice>
        )}
        {tunnel.publicHostnames.length === 0 ? (
          <p className="cf-meta">No public hostnames were found.</p>
        ) : (
          <ul className="cf-list">
            {tunnel.publicHostnames.map((hostname) => (
              <li className="cf-list-row" key={hostname.hostname}>
                <div className="cf-list-main">
                  <span className="cf-hostname">
                    {hostname.url ? (
                      <a href={hostname.url} target="_blank" rel="noreferrer">
                        {hostname.hostname}
                      </a>
                    ) : (
                      hostname.hostname
                    )}
                  </span>
                  <span className="cf-help">{HOSTNAME_SOURCES[hostname.source]}</span>
                </div>
                {hostname.url && (
                  <div className="cf-actions">
                    <a
                      className="cf-button cf-small"
                      href={hostname.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${hostname.hostname}`}
                    >
                      Open ↗
                    </a>
                    <CopyButton value={hostname.url} label="Copy URL" />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="cf-subsection">
        <Label>CNAME target</Label>
        <div className="cf-list-row">
          <Mono>{tunnel.dnsTarget}</Mono>
          <CopyButton value={tunnel.dnsTarget} label="Copy target" />
        </div>
        <p className="cf-help">
          Point a CNAME record at this target to route a hostname through the tunnel. It is not a
          website URL.
        </p>
      </div>
    </>
  );
}

function TunnelCard({ tunnel }: { tunnel: Tunnel }) {
  return (
    <article className="cf-card" aria-label={`Tunnel ${tunnel.name}`}>
      <div className="cf-row">
        <div>
          <h3>{tunnel.name}</h3>
          <p className="cf-meta">
            {!tunnel.connectionError && <>{plural(tunnel.connections, "connection")} · </>}
            {configSourceLabel(tunnel.configSource)} · <Mono>{tunnel.id}</Mono>
          </p>
        </div>
        <Badge tone={tunnelTone(tunnel.status)} dot>
          {titleCase(tunnel.status)}
        </Badge>
      </div>
      {tunnel.connectionError && (
        <Notice error>Connection count unavailable. {tunnel.connectionError}</Notice>
      )}
      <TunnelLinks tunnel={tunnel} />
    </article>
  );
}

export function Tunnels({ overview }: { overview: Overview }) {
  const { items, error } = overview.tunnels;
  return (
    <section aria-label="Tunnel inventory">
      {error && <Notice error>{error}</Notice>}
      {items.length === 0 && !error && (
        <EmptyState title="No tunnels in this account">
          Named tunnels appear here once cloudflared registers them with Cloudflare.
        </EmptyState>
      )}
      <div className="cf-stack">
        {items.map((tunnel) => (
          <TunnelCard key={tunnel.id} tunnel={tunnel} />
        ))}
      </div>
      <p className="cf-footnote">
        Temporary trycloudflare.com Quick Tunnels are not listed by the account API, and this plugin
        does not start them.
      </p>
    </section>
  );
}

function AccessApps({ overview }: { overview: Overview }) {
  const { items, error } = overview.apps;
  return (
    <>
      {error && <Notice error>{error}</Notice>}
      {items.length === 0 && !error && (
        <EmptyState title="No Access applications">
          Applications protected by Cloudflare Access appear here.
        </EmptyState>
      )}
      {items.length > 0 && (
        <div className="cf-list-card">
          {items.map((app) => (
            <details className="cf-list-item" key={app.id}>
              <summary className="cf-list-row" aria-label={`${app.name} details`}>
                <div className="cf-list-main">
                  <span className="cf-title">{app.name}</span>
                  <span className="cf-help cf-hostname">{app.domain}</span>
                </div>
                <div className="cf-actions">
                  <span className="cf-meta">
                    {plural(app.policyIds.length, "policy", "policies")}
                  </span>
                  <Badge>{app.type}</Badge>
                </div>
              </summary>
              <dl className="cf-kv">
                <KeyValue label="Application ID">
                  <Mono>{app.id}</Mono>
                </KeyValue>
                {app.policyIds.map((id) => (
                  <KeyValue key={id} label="Policy">
                    <Mono>{id}</Mono>
                  </KeyValue>
                ))}
              </dl>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

function AccessPolicies({ overview }: { overview: Overview }) {
  const { items, error } = overview.policies;
  return (
    <>
      {error && <Notice error>{error}</Notice>}
      {items.length === 0 && !error && (
        <EmptyState title="No reusable policies">
          Reusable Access policies appear here. Shares create one policy each.
        </EmptyState>
      )}
      {items.length > 0 && (
        <div className="cf-list-card">
          {items.map((policy) => (
            <details className="cf-list-item" key={policy.id}>
              <summary className="cf-list-row" aria-label={`${policy.name} details`}>
                <div className="cf-list-main">
                  <span className="cf-title">{policy.name}</span>
                  <span className="cf-help">
                    {policy.allowedEmails.length
                      ? plural(policy.allowedEmails.length, "email address", "email addresses")
                      : "No explicit email addresses"}
                  </span>
                </div>
                <Badge tone={policy.decision === "allow" ? "good" : "neutral"}>
                  {titleCase(policy.decision)}
                </Badge>
              </summary>
              <dl className="cf-kv">
                <KeyValue label="Policy ID">
                  <Mono>{policy.id}</Mono>
                </KeyValue>
                {policy.allowedEmails.length > 0 && (
                  <KeyValue label="Emails">
                    <ul className="cf-chips">
                      {policy.allowedEmails.map((email) => (
                        <li key={email}>{email}</li>
                      ))}
                    </ul>
                  </KeyValue>
                )}
              </dl>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

export function Access({ overview }: { overview: Overview }) {
  return (
    <section aria-label="Access inventory">
      <AccessApps overview={overview} />
      <div className="cf-section-heading cf-section-gap">
        <h3>Reusable policies</h3>
      </div>
      <AccessPolicies overview={overview} />
    </section>
  );
}

function DnsRow({
  record,
  tunnel,
  open,
  onToggle,
}: {
  record: DnsRecord;
  tunnel?: Tunnel;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="cf-table-row" data-open={open || undefined}>
        <td className="cf-cell-name">
          <span className="cf-hostname">{record.name}</span>
          <span className="cf-help">
            {record.zoneName}
            {tunnel ? ` · via ${tunnel.name}` : ""}
          </span>
        </td>
        <td className="cf-cell-type">
          <Badge>{record.type}</Badge>
        </td>
        <td className="cf-cell-content">
          <code className="cf-mono" title={record.content}>
            {record.content || "Empty"}
          </code>
        </td>
        <td className="cf-cell-proxy">
          {record.proxied !== undefined && (
            <Badge tone={record.proxied ? "accent" : "neutral"}>
              {record.proxied ? "Proxied" : "DNS only"}
            </Badge>
          )}
        </td>
        <td className="cf-cell-ttl">{ttlLabel(record.ttl)}</td>
        <td className="cf-cell-actions">
          <button
            type="button"
            className="cf-small cf-ghost"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} details for ${record.name}`}
            onClick={onToggle}
          >
            {open ? "Hide" : "Details"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="cf-table-details">
          <td colSpan={6}>
            <dl className="cf-kv">
              <KeyValue label="Content">
                <Mono>{record.content || "Empty"}</Mono>
                {record.content && <CopyButton value={record.content} label="Copy" />}
              </KeyValue>
              <KeyValue label="Record ID">
                <Mono>{record.id}</Mono>
              </KeyValue>
              <KeyValue label="Zone ID">
                <Mono>{record.zoneId}</Mono>
              </KeyValue>
              {record.ttl !== undefined && (
                <KeyValue label="TTL">
                  {record.ttl === 1 ? "Automatic" : `${record.ttl} seconds`}
                </KeyValue>
              )}
              {record.tunnelId && (
                <KeyValue label="Tunnel">
                  {tunnel?.name ?? "Unknown tunnel"} · <Mono>{record.tunnelId}</Mono>
                </KeyValue>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function DnsFilters({
  records,
  zones,
  search,
  zoneId,
  type,
  onChange,
}: {
  records: DnsRecord[];
  zones: Map<string, string>;
  search: string;
  zoneId: string;
  type: string;
  onChange: (next: { search?: string; zoneId?: string; type?: string }) => void;
}) {
  return (
    <div className="cf-toolbar">
      <label className="cf-grow" htmlFor="cf-dns-search">
        <span className="cf-sr-only">Search records</span>
        <input
          id="cf-dns-search"
          type="search"
          value={search}
          onChange={(event) => onChange({ search: event.target.value })}
          placeholder="Search name, type or content"
        />
      </label>
      <label htmlFor="cf-dns-type">
        <span className="cf-sr-only">Record type</span>
        <select
          id="cf-dns-type"
          value={type}
          onChange={(event) => onChange({ type: event.target.value })}
        >
          <option value="">All types</option>
          {dnsTypes(records).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="cf-dns-zone">
        <span className="cf-sr-only">Zone</span>
        <select
          id="cf-dns-zone"
          value={zoneId}
          onChange={(event) => onChange({ zoneId: event.target.value })}
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
  );
}

export function DnsInventory({ overview }: { overview: Overview }) {
  const [filters, setFilters] = useState({ search: "", zoneId: "", type: "" });
  const [open, setOpen] = useState<string | null>(null);
  const records = overview.dnsRecords.items;
  const zones = new Map(overview.zones.items.map((zone) => [zone.id, zone.name]));
  for (const record of records) zones.set(record.zoneId, record.zoneName);
  const tunnels = new Map(overview.tunnels.items.map((tunnel) => [tunnel.id, tunnel]));
  const matches = filterDnsRecords(records, {
    query: filters.search,
    zoneId: filters.zoneId,
    type: filters.type,
  });
  const filtered = Boolean(filters.search || filters.zoneId || filters.type);
  return (
    <section aria-label="DNS inventory">
      {overview.dnsRecords.error && <Notice error>{overview.dnsRecords.error}</Notice>}
      <DnsFilters
        records={records}
        zones={zones}
        search={filters.search}
        zoneId={filters.zoneId}
        type={filters.type}
        onChange={(next) => setFilters({ ...filters, ...next })}
      />
      <div className="cf-row cf-results">
        <output>
          {filtered
            ? `${matches.length} of ${plural(records.length, "record")}`
            : plural(records.length, "record")}
        </output>
        {filtered && (
          <button
            type="button"
            className="cf-link"
            onClick={() => setFilters({ search: "", zoneId: "", type: "" })}
          >
            Clear filters
          </button>
        )}
      </div>
      {matches.length === 0 ? (
        <EmptyState>{dnsEmptyMessage(records, overview.dnsRecords.error)}</EmptyState>
      ) : (
        <div className="cf-table-wrap">
          <table className="cf-table">
            <colgroup>
              <col className="cf-col-name" />
              <col className="cf-col-type" />
              <col className="cf-col-content" />
              <col className="cf-col-proxy" />
              <col className="cf-col-ttl" />
              <col className="cf-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Content</th>
                <th scope="col">Proxy</th>
                <th scope="col" className="cf-cell-ttl">
                  TTL
                </th>
                <th scope="col">
                  <span className="cf-sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {matches.map((record) => {
                const key = `${record.zoneId}:${record.id}`;
                return (
                  <DnsRow
                    key={key}
                    record={record}
                    tunnel={record.tunnelId ? tunnels.get(record.tunnelId) : undefined}
                    open={open === key}
                    onToggle={() => setOpen(open === key ? null : key)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
