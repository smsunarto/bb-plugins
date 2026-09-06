import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { createSchema, specSchema } from "../shared/schema.ts";
import type { CreateShare, Overview, Share, Spec } from "../shared/schema.ts";
import { rpc } from "./rpc.ts";
import "./cloudflare.css";

const TABS = [
  {
    path: "",
    label: "Shares",
    title: "Development shares",
    description: "Each share pairs a host app with an email allowlist.",
  },
  {
    path: "tunnels",
    label: "Tunnels",
    title: "Account tunnels",
    description:
      "Read-only inventory. Share controls manage only resources created by this plugin.",
  },
  {
    path: "access",
    label: "Access",
    title: "Access applications",
    description:
      "Read-only account inventory. Application configuration does not verify that login succeeds.",
  },
] as const;

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={`cf-notice${error ? " cf-error" : ""}`} role={error ? "alert" : "status"}>
      {children}
    </div>
  );
}

function Badge({ children, good = false }: { children: ReactNode; good?: boolean }) {
  return <span className={`cf-badge${good ? " cf-good" : ""}`}>{children}</span>;
}

function SettingsLink() {
  return (
    <a className="cf-button" href="/settings/plugins/cloudflare">
      Open settings
    </a>
  );
}

function connectionLabel(oauth: Overview["setup"]["oauth"], hasErrors: boolean) {
  if (!oauth.configured) return "Setup required";
  if (!oauth.connected) return "Not connected";
  return hasErrors ? "Partial access" : "Connected with OAuth";
}

function ConnectionSkeleton() {
  return (
    <section className="cf-card cf-connection" aria-hidden="true">
      <div className="cf-row">
        <div>
          <h2>
            <span className="cf-skeleton-text">Account connected</span>
          </h2>
          <p>
            <span className="cf-mono cf-skeleton-text">{"0".repeat(32)}</span>
          </p>
        </div>
        <span className="cf-badge cf-good cf-skeleton-text">Connected with OAuth</span>
      </div>
      <div className="cf-row cf-wrap">
        <p>
          <span className="cf-skeleton-text">Disconnecting leaves existing shares running.</span>
        </p>
        <div className="cf-actions">
          <button type="button" className="cf-skeleton-text" disabled>
            Disconnect
          </button>
        </div>
      </div>
    </section>
  );
}

function ContentSkeleton({ shares }: { shares: boolean }) {
  return (
    <div className="cf-empty" aria-hidden="true">
      {shares ? (
        <>
          <h3>
            <span className="cf-skeleton-text">No development shares yet</span>
          </h3>
          <p>
            <span className="cf-skeleton-text">
              Choose a host and hostname to share your first local app.
            </span>
          </p>
        </>
      ) : (
        <span className="cf-skeleton-text">Loading account inventory</span>
      )}
    </div>
  );
}

function SetupCard({
  overview,
  busy,
  connecting,
  onConnect,
  onDisconnect,
}: {
  overview: Overview;
  busy: boolean;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const setup = overview.setup;
  const oauth = setup.oauth;
  const hasErrors = [
    overview.zones,
    overview.identityProviders,
    overview.tunnels,
    overview.apps,
    overview.policies,
  ].some((section) => section.error);
  return (
    <section className="cf-card cf-connection" aria-label="Account connection">
      <div className="cf-row">
        <div>
          <h2>
            {!oauth.connected
              ? "Connect your Cloudflare account"
              : hasErrors
                ? "Account needs attention"
                : "Account connected"}
          </h2>
          <p>
            {!oauth.configured ? (
              "Add your account and OAuth client in plugin settings to get started."
            ) : !oauth.connected ? (
              "Sign in with Cloudflare to manage your tunnels and protected shares."
            ) : (
              <span className="cf-mono">{setup.accountId}</span>
            )}
          </p>
        </div>
        <Badge good={setup.configured && !hasErrors}>{connectionLabel(oauth, hasErrors)}</Badge>
      </div>
      {!oauth.configured && oauth.missing.length > 0 && (
        <p>Complete setup: {oauth.missing.join(", ")}.</p>
      )}
      {oauth.error && <Notice error>{oauth.error}</Notice>}
      {hasErrors && (
        <p>
          Some account sections could not be read. Review the errors below and check the access
          granted to this connection.
        </p>
      )}
      <div className="cf-row cf-wrap">
        <p>
          {oauth.connected
            ? "Disconnecting leaves existing shares running."
            : "Cloudflare will ask you to approve access to Tunnel, Access and DNS."}
        </p>
        <div className="cf-actions">
          {!oauth.configured && <SettingsLink />}
          {oauth.configured && !oauth.connected && (
            <button className="cf-primary" type="button" disabled={busy} onClick={onConnect}>
              {connecting ? "Connecting…" : "Connect with Cloudflare"}
            </button>
          )}
          {oauth.connected && (
            <button type="button" disabled={busy} onClick={onDisconnect}>
              Disconnect
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function SpecFields({
  overview,
  spec,
  onChange,
  prefix,
}: {
  overview: Overview;
  spec: { port: string; emails: string; identityProviderId: string };
  onChange: (next: typeof spec) => void;
  prefix: string;
}) {
  return (
    <>
      <label htmlFor={`${prefix}-port`}>
        Local port
        <input
          id={`${prefix}-port`}
          name="port"
          type="number"
          min="1"
          max="65535"
          required
          value={spec.port}
          onChange={(event) => onChange({ ...spec, port: event.target.value })}
          placeholder="3000"
        />
      </label>
      <label htmlFor={`${prefix}-idp`}>
        Identity provider
        <select
          id={`${prefix}-idp`}
          name="identityProviderId"
          required
          value={spec.identityProviderId}
          onChange={(event) => onChange({ ...spec, identityProviderId: event.target.value })}
        >
          <option value="">Choose an identity provider</option>
          {spec.identityProviderId &&
            !overview.identityProviders.items.some(
              (provider) => provider.id === spec.identityProviderId,
            ) && (
              <option value={spec.identityProviderId}>{spec.identityProviderId} (current)</option>
            )}
          {overview.identityProviders.items.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} · {provider.type}
            </option>
          ))}
        </select>
      </label>
      <label className="cf-span" htmlFor={`${prefix}-emails`}>
        Allowed email addresses
        <textarea
          id={`${prefix}-emails`}
          name="allowedEmails"
          required
          rows={3}
          value={spec.emails}
          onChange={(event) => onChange({ ...spec, emails: event.target.value })}
          placeholder="you@example.com"
        />
        <span className="cf-help">
          Separate addresses with commas or new lines. Only these addresses may sign in.
        </span>
      </label>
    </>
  );
}

function parseSpec(spec: { port: string; emails: string; identityProviderId: string }) {
  return {
    port: Number(spec.port),
    allowedEmails: spec.emails.split(/[\s,;]+/).filter(Boolean),
    identityProviderId: spec.identityProviderId,
  };
}

const EMPTY_CREATE: CreateShare = {
  id: "",
  hostId: "",
  zoneId: "",
  hostname: "",
  spec: { port: 3000, allowedEmails: [], identityProviderId: "" },
};

function createButtonLabel(busy: boolean, pending: CreateShare | null) {
  if (busy) return "Creating…";
  return pending ? "Retry same request" : "Create protected share";
}

function newShareLabel(open: boolean, pending: CreateShare | null) {
  if (open) return "Hide form";
  return pending ? "Resume request" : "New share";
}

function CreateForm({
  overview,
  pending,
  busy,
  onSubmit,
  onClose,
}: {
  overview: Overview;
  pending: CreateShare | null;
  busy: boolean;
  onSubmit: (input: CreateShare) => Promise<void>;
  onClose: () => void;
}) {
  const initial = pending ?? EMPTY_CREATE;
  const [hostId, setHostId] = useState(initial.hostId);
  const [zoneId, setZoneId] = useState(initial.zoneId);
  const [hostname, setHostname] = useState(initial.hostname);
  const [spec, setSpec] = useState({
    port: String(initial.spec.port),
    emails: initial.spec.allowedEmails.join("\n"),
    identityProviderId: initial.spec.identityProviderId,
  });
  const [error, setError] = useState("");
  const ready =
    overview.setup.configured &&
    overview.hosts.items.some((host) => host.online) &&
    overview.zones.items.length > 0 &&
    overview.identityProviders.items.length > 0;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      void onSubmit(pending);
      return;
    }
    const result = createSchema.safeParse({
      id: crypto.randomUUID(),
      hostId,
      zoneId,
      hostname: hostname.trim(),
      spec: parseSpec(spec),
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Check the share details.");
      return;
    }
    setError("");
    void onSubmit(result.data);
  }
  return (
    <form className="cf-card cf-create" onSubmit={submit} aria-label="Create development share">
      <div className="cf-row">
        <div>
          <h2>New development share</h2>
          <p>Publish one localhost app behind Cloudflare Access.</p>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close share form">
          Close
        </button>
      </div>
      {pending && (
        <Notice>
          This request is saved for retry. Its host, hostname and access rules stay the same until
          setup completes.
        </Notice>
      )}
      {!ready && (
        <Notice error>
          To create a share, connect an account with an accessible zone and identity provider, and
          bring a BB host online.
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
      <fieldset className="cf-form-grid" disabled={busy || !!pending}>
        <label htmlFor="cf-host">
          BB host
          <select
            id="cf-host"
            name="hostId"
            value={hostId}
            onChange={(event) => setHostId(event.target.value)}
            required
          >
            <option value="">Choose an online host</option>
            {overview.hosts.items.map((host) => (
              <option key={host.id} value={host.id} disabled={!host.online}>
                {host.name}
                {host.online ? "" : " · Offline"}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="cf-zone">
          Zone
          <select
            id="cf-zone"
            name="zoneId"
            value={zoneId}
            onChange={(event) => setZoneId(event.target.value)}
            required
          >
            <option value="">Choose a zone</option>
            {overview.zones.items.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {zone.name}
              </option>
            ))}
          </select>
        </label>
        <label className="cf-span" htmlFor="cf-hostname">
          Public hostname
          <input
            id="cf-hostname"
            name="hostname"
            required
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder={
              zoneId
                ? `preview.${overview.zones.items.find((zone) => zone.id === zoneId)?.name ?? "example.com"}`
                : "preview.example.com"
            }
            autoCapitalize="none"
            autoCorrect="off"
          />
          <span className="cf-help">
            Use an unused hostname in the selected zone. The host, zone and hostname are fixed after
            creation.
          </span>
        </label>
        <SpecFields overview={overview} spec={spec} onChange={setSpec} prefix="cf-create" />
      </fieldset>
      <div className="cf-row cf-wrap">
        <p>Run your app and install cloudflared on the selected host before creating a share.</p>
        <button className="cf-primary" type="submit" disabled={busy || (!pending && !ready)}>
          {createButtonLabel(busy, pending)}
        </button>
      </div>
    </form>
  );
}

function ShareCard({
  share,
  overview,
  busy,
  onAction,
  onUpdate,
  onResume,
}: {
  share: Share;
  overview: Overview;
  busy: boolean;
  onAction: (action: "start" | "stop" | "remove", share: Share) => void;
  onUpdate: (share: Share, spec: Spec) => Promise<boolean>;
  onResume: (share: Share) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editRevision, setEditRevision] = useState(share.revision);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [spec, setSpec] = useState({
    port: String(share.desiredSpec.port),
    emails: share.desiredSpec.allowedEmails.join("\n"),
    identityProviderId: share.desiredSpec.identityProviderId,
  });
  const [error, setError] = useState("");
  const host = overview.hosts.items.find((item) => item.id === share.hostId);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = specSchema.safeParse(parseSpec(spec));
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the access rules.");
      return;
    }
    setError("");
    if (await onUpdate({ ...share, revision: editRevision }, parsed.data)) setEditing(false);
  }
  return (
    <article className="cf-card" data-share-id={share.id} aria-label={`Share ${share.hostname}`}>
      <div className="cf-row">
        <div>
          <h3 className="cf-hostname">
            {share.state === "running" ? (
              <a href={`https://${share.hostname}`} target="_blank" rel="noreferrer">
                {share.hostname} ↗
              </a>
            ) : (
              share.hostname
            )}
          </h3>
          <p>
            {host?.name ?? share.hostId} · localhost:{share.desiredSpec.port}
            {host && !host.online ? " · Host offline" : ""}
          </p>
        </div>
        <Badge good={share.state === "running"}>{share.state}</Badge>
      </div>
      <p className="cf-email-list">{share.desiredSpec.allowedEmails.join(", ")}</p>
      {share.state === "starting" && <p>Waiting for Cloudflare to observe a healthy connector.</p>}
      {share.lastError && <Notice error>{share.lastError}</Notice>}
      {share.pendingOperation && (
        <Notice error>
          Unconfirmed {share.pendingOperation} operation. Inspect the saved resources before
          retrying.
        </Notice>
      )}
      {editing && share.desiredState !== "removed" && (
        <form
          onSubmit={(event) => void save(event)}
          className="cf-edit"
          aria-label={`Edit ${share.hostname}`}
        >
          <fieldset className="cf-form-grid" disabled={busy}>
            <SpecFields
              overview={overview}
              spec={spec}
              onChange={setSpec}
              prefix={`cf-edit-${share.id}`}
            />
          </fieldset>
          <p>Access changes may require users to sign in again.</p>
          {error && <Notice error>{error}</Notice>}
          <div className="cf-actions">
            <button className="cf-primary" type="submit" disabled={busy}>
              Save changes
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <div className="cf-row cf-wrap">
        <details className="cf-resources">
          <summary>Resource details</summary>
          <dl>
            <dt>Share</dt>
            <dd>{share.id}</dd>
            {Object.entries(share.resources).map(([key, value]) => (
              <div key={key}>
                <dt>{key.replace("Id", "")}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            <dt>Revision</dt>
            <dd>{share.revision}</dd>
          </dl>
        </details>
        <div className="cf-actions">
          {share.desiredState === "removed" ? (
            <button
              className="cf-danger"
              type="button"
              disabled={busy}
              onClick={() => onAction("remove", share)}
            >
              Retry removal
            </button>
          ) : (
            <>
              {!share.appliedSpec && (
                <button type="button" disabled={busy} onClick={() => onResume(share)}>
                  Resume setup
                </button>
              )}
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSpec({
                      port: String(share.desiredSpec.port),
                      emails: share.desiredSpec.allowedEmails.join("\n"),
                      identityProviderId: share.desiredSpec.identityProviderId,
                    });
                    setEditRevision(share.revision);
                    setEditing(!editing);
                  }}
                >
                  Edit
                </button>
                {share.appliedSpec && share.state !== "running" && (
                  <button type="button" disabled={busy} onClick={() => onAction("start", share)}>
                    Start
                  </button>
                )}
              </>
              {share.state !== "stopped" && (
                <button type="button" disabled={busy} onClick={() => onAction("stop", share)}>
                  Stop
                </button>
              )}
              <button
                className="cf-danger"
                type="button"
                disabled={busy}
                onClick={() => setConfirmRemove(!confirmRemove)}
              >
                Remove
              </button>
            </>
          )}
        </div>
      </div>
      {confirmRemove && share.desiredState !== "removed" && (
        <div className="cf-remove-confirm">
          <p>Remove this share and its owned tunnel, DNS record and Access resources?</p>
          <div className="cf-actions">
            <button
              type="button"
              className="cf-danger"
              disabled={busy}
              onClick={() => onAction("remove", share)}
            >
              Confirm removal
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function Tunnels({ overview }: { overview: Overview }) {
  return (
    <section aria-label="Tunnel inventory">
      {overview.tunnels.error && <Notice error>{overview.tunnels.error}</Notice>}
      {overview.tunnels.items.length === 0 && !overview.tunnels.error && (
        <div className="cf-empty">No tunnels found in this account.</div>
      )}
      <div className="cf-stack">
        {overview.tunnels.items.map((tunnel) => (
          <article className="cf-card" key={tunnel.id}>
            <div className="cf-row">
              <div>
                <h3>{tunnel.name}</h3>
                <p className="cf-mono">{tunnel.id}</p>
              </div>
              <Badge good={tunnel.status === "healthy"}>{tunnel.status}</Badge>
            </div>
            <p>
              {!tunnel.connectionError && (
                <>
                  {tunnel.connections} connection{tunnel.connections === 1 ? "" : "s"} ·{" "}
                </>
              )}
              {tunnel.configSource} configuration
            </p>
            {tunnel.connectionError && (
              <Notice error>Connection count unavailable. {tunnel.connectionError}</Notice>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function Access({ overview }: { overview: Overview }) {
  return (
    <section aria-label="Access inventory">
      {overview.apps.error && <Notice error>{overview.apps.error}</Notice>}
      {!overview.apps.items.length && !overview.apps.error && (
        <div className="cf-empty">No Access applications found.</div>
      )}
      <div className="cf-stack">
        {overview.apps.items.map((app) => (
          <article className="cf-card" key={app.id}>
            <div className="cf-row">
              <div>
                <h3>{app.name}</h3>
                <p className="cf-hostname">{app.domain}</p>
              </div>
              <Badge>{app.type}</Badge>
            </div>
            <p>
              {app.policyIds.length} associated {app.policyIds.length === 1 ? "policy" : "policies"}
            </p>
            <details>
              <summary>Application details</summary>
              <p className="cf-mono">{app.id}</p>
              {app.policyIds.map((id) => (
                <p className="cf-mono" key={id}>
                  {id}
                </p>
              ))}
            </details>
          </article>
        ))}
      </div>
      <div className="cf-section-heading">
        <h2>Reusable policies</h2>
      </div>
      {overview.policies.error && <Notice error>{overview.policies.error}</Notice>}
      {!overview.policies.items.length && !overview.policies.error && (
        <div className="cf-empty">No reusable policies found.</div>
      )}
      <div className="cf-stack">
        {overview.policies.items.map((policy) => (
          <article className="cf-card" key={policy.id}>
            <div className="cf-row">
              <h3>{policy.name}</h3>
              <Badge>{policy.decision}</Badge>
            </div>
            <p className="cf-email-list">
              {policy.allowedEmails.length
                ? policy.allowedEmails.join(", ")
                : "No explicit email addresses in this policy."}
            </p>
            <p className="cf-mono">{policy.id}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Inventory({
  overview,
  path,
  loading,
}: {
  overview?: Overview;
  path: string;
  loading: boolean;
}) {
  if (!overview) return loading ? <ContentSkeleton shares={false} /> : null;
  if (!overview.setup.configured) return <Notice>Connect your account to load inventory.</Notice>;
  return path === "tunnels" ? <Tunnels overview={overview} /> : <Access overview={overview} />;
}

function CloudflareHeader({
  fetching,
  busy,
  onRefresh,
}: {
  fetching: boolean;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="cf-row cf-header">
      <div>
        <div className="cf-eyebrow">CLOUDFLARE</div>
        <h1>Development access</h1>
        <p>Your local apps, shared through your own account.</p>
      </div>
      <button className="cf-refresh" type="button" disabled={fetching || busy} onClick={onRefresh}>
        {fetching ? "Refreshing…" : "Refresh"}
      </button>
    </header>
  );
}

function CloudflarePanel({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const client = rpc.useClient();
  const overview = rpc.overview.useQuery({ refetchInterval: 20_000, retry: false });
  const [newOpen, setNewOpen] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<CreateShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const mutationLock = useRef(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const active = TABS.find((tab) => tab.path === subPath.split("/")[0]) ?? TABS[0];
  async function mutate(
    operation: () => Promise<{ ok: boolean; message: string }>,
  ): Promise<boolean> {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await operation();
      setNotice({ message: result.message, error: !result.ok });
      await overview.refetch();
      return result.ok;
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : "The request failed. Refresh the account and try again.",
        error: true,
      });
      await overview.refetch();
      return false;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  async function connect() {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setBusy(true);
    setConnecting(true);
    setNotice(null);
    try {
      const result = await client.oauthConnect();
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : "Cloudflare sign-in could not start.",
        error: true,
      });
    } finally {
      mutationLock.current = false;
      setBusy(false);
      setConnecting(false);
    }
  }
  async function create(input: CreateShare) {
    setPendingCreate(input);
    await mutate(async () => {
      const result = await client.create(input);
      setPendingCreate(null);
      setNewOpen(false);
      return result;
    });
  }
  const data = overview.data;
  return (
    <main className="cf-panel" aria-busy={overview.isPending}>
      <div className="cf-content">
        <CloudflareHeader
          fetching={overview.isFetching}
          busy={busy}
          onRefresh={() => void overview.refetch()}
        />
        {overview.isPending && <output className="cf-sr-only">Loading Cloudflare account…</output>}
        {overview.error && (
          <Notice error>
            Unable to load Cloudflare. {overview.error.message} <SettingsLink />
          </Notice>
        )}
        {overview.isPending && <ConnectionSkeleton />}
        {data && (
          <SetupCard
            overview={data}
            busy={busy}
            connecting={connecting}
            onConnect={() => void connect()}
            onDisconnect={() => void mutate(() => client.oauthDisconnect())}
          />
        )}
        <nav className="cf-tabs" aria-label="Cloudflare sections">
          {TABS.map((tab) => (
            <button
              key={tab.path}
              type="button"
              aria-current={active.path === tab.path ? "page" : undefined}
              onClick={() => navigate.toPluginPanel("cloudflare", { subPath: tab.path })}
            >
              {tab.label}
              <span className={data ? undefined : "cf-count-loading"} aria-hidden={!data}>
                {data
                  ? tab.path === ""
                    ? data.shares.filter((share) => share.state !== "removed").length
                    : tab.path === "tunnels"
                      ? data.tunnels.items.length
                      : data.apps.items.length
                  : "0"}
              </span>
            </button>
          ))}
        </nav>
        {notice && <Notice error={notice.error}>{notice.message}</Notice>}
        <div className="cf-row cf-section-heading">
          <div>
            <h2>{active.title}</h2>
            <p>{active.description}</p>
          </div>
          {active.path === "" && (
            <button
              className="cf-primary"
              type="button"
              disabled={!data?.setup.configured || busy}
              onClick={() => setNewOpen(!newOpen)}
            >
              {newShareLabel(newOpen, pendingCreate)}
            </button>
          )}
        </div>
        {active.path === "" && (
          <section aria-label="Development shares">
            {overview.isPending && <ContentSkeleton shares />}
            {data && (
              <>
                {[
                  ["Hosts", data.hosts],
                  ["Zones", data.zones],
                  ["Identity providers", data.identityProviders],
                ].map(([name, section]) =>
                  typeof section !== "string" && section?.error ? (
                    <Notice error key={String(name)}>
                      {String(name)} could not be loaded. {section.error}
                    </Notice>
                  ) : null,
                )}
                {newOpen && (
                  <CreateForm
                    key={pendingCreate?.id ?? "new"}
                    overview={data}
                    pending={pendingCreate}
                    busy={busy}
                    onSubmit={create}
                    onClose={() => setNewOpen(false)}
                  />
                )}
                {!data.shares.some((share) => share.state !== "removed") && !newOpen && (
                  <div className="cf-empty">
                    <h3>No development shares yet</h3>
                    <p>
                      {data.setup.configured
                        ? "Choose a host and hostname to share your first local app."
                        : "Connect your account above to create a protected share."}
                    </p>
                  </div>
                )}
                <div className="cf-stack">
                  {data.shares
                    .filter((share) => share.state !== "removed")
                    .map((share) => (
                      <ShareCard
                        key={share.id}
                        share={share}
                        overview={data}
                        busy={busy || !data.setup.configured}
                        onAction={(action, target) => {
                          void mutate(async () => {
                            const result = await client[action]({
                              id: target.id,
                              expectedRevision: target.revision,
                            });
                            if (
                              action === "remove" &&
                              result.ok &&
                              pendingCreate?.id === target.id
                            ) {
                              setPendingCreate(null);
                              setNewOpen(false);
                            }
                            return result;
                          });
                        }}
                        onUpdate={(target, spec) =>
                          mutate(() =>
                            client.update({
                              id: target.id,
                              expectedRevision: target.revision,
                              spec,
                            }),
                          )
                        }
                        onResume={(target) => {
                          setNewOpen(true);
                          void create({
                            id: target.id,
                            hostId: target.hostId,
                            zoneId: target.zoneId,
                            hostname: target.hostname,
                            spec: target.desiredSpec,
                          });
                        }}
                      />
                    ))}
                </div>
              </>
            )}
            <p className="cf-footnote">
              Access login is not verified. Open a running share and complete sign-in to check
              access.
            </p>
          </section>
        )}
        {active.path !== "" && (
          <Inventory overview={data} path={active.path} loading={overview.isPending} />
        )}
      </div>
    </main>
  );
}

function CloudflareApp({ subPath }: { subPath: string }) {
  return (
    <PluginQueryBoundary>
      <CloudflarePanel subPath={subPath} />
    </PluginQueryBoundary>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "cloudflare",
    title: "Cloudflare",
    icon: "Cloud",
    path: "cloudflare",
    component: CloudflareApp,
  });
});
