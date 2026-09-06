import { useState } from "react";
import type { FormEvent } from "react";
import { createSchema, quickCreateSchema, specSchema } from "../shared/schema.ts";
import type {
  CreateShare,
  Overview,
  QuickCreate,
  QuickList,
  QuickShare,
  Share,
  Spec,
} from "../shared/schema.ts";
import { identityProviderLabel, quickTone, shareTone, titleCase } from "./labels.ts";
import { Badge, CopyButton, KeyValue, Mono, Notice } from "./ui.tsx";

type SpecDraft = { port: string; emails: string; identityProviderId: string };

function draftFrom(spec: Spec): SpecDraft {
  return {
    port: String(spec.port),
    emails: spec.allowedEmails.join("\n"),
    identityProviderId: spec.identityProviderId,
  };
}

function parseSpec(spec: SpecDraft) {
  return {
    port: Number(spec.port),
    allowedEmails: spec.emails.split(/[\s,;]+/).filter(Boolean),
    identityProviderId: spec.identityProviderId,
  };
}

function SpecFields({
  overview,
  spec,
  onChange,
  prefix,
}: {
  overview: Overview;
  spec: SpecDraft;
  onChange: (next: SpecDraft) => void;
  prefix: string;
}) {
  const providers = overview.identityProviders.items;
  const unknownCurrent =
    spec.identityProviderId &&
    !providers.some((provider) => provider.id === spec.identityProviderId);
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
          {unknownCurrent && (
            <option value={spec.identityProviderId}>{spec.identityProviderId} (current)</option>
          )}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {identityProviderLabel(provider)}
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

export const EMPTY_CREATE: CreateShare = {
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

export function newShareLabel(open: boolean, pending: CreateShare | null) {
  if (open) return "Hide form";
  return pending ? "Resume request" : "New share";
}

export function CreateForm({
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
  const [spec, setSpec] = useState(draftFrom(initial.spec));
  const [error, setError] = useState("");
  const ready =
    overview.setup.configured &&
    overview.hosts.items.some((host) => host.online) &&
    overview.zones.items.length > 0 &&
    overview.identityProviders.items.length > 0;
  const zoneName = overview.zones.items.find((zone) => zone.id === zoneId)?.name;
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
          <h3>New development share</h3>
          <p>Publish one localhost app behind Cloudflare Access.</p>
        </div>
        <button
          type="button"
          className="cf-ghost"
          onClick={onClose}
          disabled={busy}
          aria-label="Close share form"
        >
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
            placeholder={`preview.${zoneName ?? "example.com"}`}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <span className="cf-help">
            Use an unused hostname in the selected zone. The host, zone and hostname are fixed after
            creation.
          </span>
        </label>
        <SpecFields overview={overview} spec={spec} onChange={setSpec} prefix="cf-create" />
      </fieldset>
      <div className="cf-row cf-wrap cf-form-footer">
        <p className="cf-help">
          Run your app and install cloudflared on the selected host before creating a share.
        </p>
        <button className="cf-primary" type="submit" disabled={busy || (!pending && !ready)}>
          {createButtonLabel(busy, pending)}
        </button>
      </div>
    </form>
  );
}

function ShareActions({
  share,
  busy,
  editing,
  onAction,
  onEdit,
  onResume,
  onRemove,
}: {
  share: Share;
  busy: boolean;
  editing: boolean;
  onAction: (action: "start" | "stop" | "remove") => void;
  onEdit: () => void;
  onResume: () => void;
  onRemove: () => void;
}) {
  if (share.desiredState === "removed") {
    return (
      <button
        className="cf-danger"
        type="button"
        disabled={busy}
        onClick={() => onAction("remove")}
      >
        Retry removal
      </button>
    );
  }
  return (
    <>
      {share.state === "running" && (
        <a
          className="cf-button"
          href={`https://${share.hostname}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${share.hostname}`}
        >
          Open ↗
        </a>
      )}
      {!share.appliedSpec && (
        <button type="button" disabled={busy} onClick={onResume}>
          Resume setup
        </button>
      )}
      <button type="button" disabled={busy} onClick={onEdit} aria-pressed={editing}>
        Edit
      </button>
      {share.appliedSpec && share.state !== "running" && (
        <button type="button" disabled={busy} onClick={() => onAction("start")}>
          Start
        </button>
      )}
      {share.state !== "stopped" && (
        <button type="button" disabled={busy} onClick={() => onAction("stop")}>
          Stop
        </button>
      )}
      <button className="cf-danger" type="button" disabled={busy} onClick={onRemove}>
        Remove
      </button>
    </>
  );
}

export function ShareCard({
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
  const [spec, setSpec] = useState(draftFrom(share.desiredSpec));
  const [error, setError] = useState("");
  const host = overview.hosts.items.find((item) => item.id === share.hostId);
  const running = share.state === "running";
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
  function toggleEdit() {
    setSpec(draftFrom(share.desiredSpec));
    setEditRevision(share.revision);
    setEditing(!editing);
  }
  return (
    <article className="cf-card" data-share-id={share.id} aria-label={`Share ${share.hostname}`}>
      <div className="cf-row">
        <div>
          <h3 className="cf-hostname">
            {running ? (
              <a href={`https://${share.hostname}`} target="_blank" rel="noreferrer">
                {share.hostname}
              </a>
            ) : (
              share.hostname
            )}
          </h3>
          <p className="cf-meta">
            {host?.name ?? share.hostId} · localhost:{share.desiredSpec.port}
            {host && !host.online ? " · Host offline" : ""}
          </p>
        </div>
        <Badge tone={shareTone(share.state)} dot>
          {titleCase(share.state)}
        </Badge>
      </div>
      <ul className="cf-chips" aria-label="Allowed email addresses">
        {share.desiredSpec.allowedEmails.map((email) => (
          <li key={email}>{email}</li>
        ))}
      </ul>
      {share.state === "starting" && (
        <p className="cf-meta">Waiting for Cloudflare to observe a healthy connector.</p>
      )}
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
          <p className="cf-help">Access changes may require users to sign in again.</p>
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
      <div className="cf-row cf-wrap cf-card-footer">
        <details className="cf-resources">
          <summary>Resource details</summary>
          <dl className="cf-kv">
            <KeyValue label="Share">
              <Mono>{share.id}</Mono>
            </KeyValue>
            {Object.entries(share.resources).map(([key, value]) => (
              <KeyValue key={key} label={titleCase(key.replace("Id", ""))}>
                <Mono>{value}</Mono>
              </KeyValue>
            ))}
            <KeyValue label="Revision">{share.revision}</KeyValue>
          </dl>
        </details>
        <div className="cf-actions">
          <ShareActions
            share={share}
            busy={busy}
            editing={editing}
            onAction={(action) => onAction(action, share)}
            onEdit={toggleEdit}
            onResume={() => onResume(share)}
            onRemove={() => setConfirmRemove(!confirmRemove)}
          />
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

type QuickHost = QuickList["hosts"]["items"][number];

export function QuickCreateForm({
  hosts,
  busy,
  onSubmit,
  onClose,
}: {
  hosts: QuickHost[];
  busy: boolean;
  onSubmit: (input: QuickCreate) => Promise<void>;
  onClose: () => void;
}) {
  const online = hosts.filter((host) => host.online);
  const [hostId, setHostId] = useState(online.length === 1 ? (online[0]?.id ?? "") : "");
  const [port, setPort] = useState("3000");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = quickCreateSchema.safeParse({
      hostId: hostId || undefined,
      port: Number(port),
      label: label.trim() || undefined,
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Check the share details.");
      return;
    }
    setError("");
    void onSubmit(result.data);
  }
  return (
    <form className="cf-card cf-create" onSubmit={submit} aria-label="Create quick share">
      <div className="cf-row">
        <div>
          <h3>New quick share</h3>
          <p>
            Publish one local port on a temporary trycloudflare.com URL. No account setup needed.
          </p>
        </div>
        <button
          type="button"
          className="cf-ghost"
          onClick={onClose}
          disabled={busy}
          aria-label="Close quick share form"
        >
          Close
        </button>
      </div>
      {online.length === 0 && <Notice error>Bring a BB host online to start a quick share.</Notice>}
      {error && <Notice error>{error}</Notice>}
      <fieldset className="cf-form-grid" disabled={busy}>
        <label htmlFor="cf-quick-host">
          BB host
          <select
            id="cf-quick-host"
            name="hostId"
            value={hostId}
            onChange={(event) => setHostId(event.target.value)}
            required
          >
            <option value="">Choose an online host</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id} disabled={!host.online}>
                {host.name}
                {host.online ? "" : " · Offline"}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="cf-quick-port">
          Local port
          <input
            id="cf-quick-port"
            name="port"
            type="number"
            min="1"
            max="65535"
            required
            value={port}
            onChange={(event) => setPort(event.target.value)}
            placeholder="3000"
          />
        </label>
        <label className="cf-span" htmlFor="cf-quick-label">
          Label
          <input
            id="cf-quick-label"
            name="label"
            maxLength={80}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Storybook"
          />
          <span className="cf-help">Optional. Shown in the share list instead of the port.</span>
        </label>
      </fieldset>
      <div className="cf-row cf-wrap cf-form-footer">
        <p className="cf-help">
          Anyone with the URL can reach the port while the share runs. cloudflared must be installed
          on the host.
        </p>
        <button className="cf-primary" type="submit" disabled={busy || online.length === 0}>
          {busy ? "Starting…" : "Start quick share"}
        </button>
      </div>
    </form>
  );
}

export function QuickShareCard({
  share,
  hosts,
  busy,
  onAction,
}: {
  share: QuickShare;
  hosts: QuickHost[];
  busy: boolean;
  onAction: (action: "start" | "stop" | "remove", share: QuickShare) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const host = hosts.find((item) => item.id === share.hostId);
  const online = host?.online ?? false;
  return (
    <article
      className="cf-card"
      data-quick-share-id={share.id}
      aria-label={`Quick share ${share.label}`}
    >
      <div className="cf-row">
        <div>
          <h3>{share.label}</h3>
          <p className="cf-meta">
            {host?.name ?? share.hostId} · localhost:{share.port}
            {host && !online ? " · Host offline" : ""} · Quick Tunnel
          </p>
        </div>
        <Badge tone={quickTone(share.state)} dot>
          {titleCase(share.state)}
        </Badge>
      </div>
      {share.url ? (
        <div className="cf-url-row">
          <a className="cf-hostname" href={share.url} target="_blank" rel="noreferrer">
            {share.url}
          </a>
          <div className="cf-actions">
            <a
              className="cf-button cf-small"
              href={share.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${share.label}`}
            >
              Open ↗
            </a>
            <CopyButton value={share.url} label="Copy URL" />
          </div>
        </div>
      ) : (
        <p className="cf-meta">
          {share.state === "error"
            ? "The tunnel is not running."
            : "Stopped. Starting again assigns a new URL."}
        </p>
      )}
      {share.lastError && <Notice error>{share.lastError}</Notice>}
      <div className="cf-row cf-wrap cf-card-footer">
        <p className="cf-help">
          Public and unauthenticated while running. The URL changes on every start.
        </p>
        <div className="cf-actions">
          {share.state === "running" ? (
            <button type="button" disabled={busy} onClick={() => onAction("stop", share)}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !online}
              onClick={() => onAction("start", share)}
              title={online ? undefined : "The host is offline."}
            >
              Start
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
        </div>
      </div>
      {confirmRemove && (
        <div className="cf-remove-confirm">
          <p>Remove this quick share? Its tunnel stops and the URL stops resolving.</p>
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
