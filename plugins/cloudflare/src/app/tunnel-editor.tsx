import { useEffect, useState, useSyncExternalStore } from "react";
import type { OriginView, TunnelTarget, TunnelWriteResult } from "../shared/schema.ts";
import {
  TUNNEL_EDITOR as text,
  tunnelConfigVersionLabel,
  tunnelRouteActionLabel,
  tunnelRouteLabel,
} from "./labels.ts";
import { TunnelConnectors } from "./tunnel-connectors.tsx";
import { routesDirty, tunnelDrafts } from "./tunnel-drafts.ts";
import type { RouteRow, TunnelClient, TunnelDraft } from "./tunnel-drafts.ts";
import { Badge, KeyValue, Label, Mono, Notice } from "./ui.tsx";

function Origin({ origin }: { origin: OriginView }) {
  return origin.kind === "plain" ? <Mono>{origin.service}</Mono> : <span>{origin.label}</span>;
}
function SaveResult({ result }: { result?: TunnelWriteResult }) {
  return result && result.kind !== "unconfirmed" ? (
    <Notice error={result.kind !== "confirmed"}>{result.message}</Notice>
  ) : null;
}

function RouteFields({
  row,
  baseline,
  index,
  onChange,
}: {
  row: RouteRow;
  baseline: NonNullable<TunnelDraft["routes"]>["baseline"];
  index: number;
  onChange: (row: RouteRow) => void;
}) {
  const draft = row.draft;
  const original =
    draft.kind === "existing"
      ? baseline.rules.find((rule) => rule.originalIndex === draft.originalIndex)!
      : undefined;
  const value =
    draft.kind === "new"
      ? draft
      : {
          hostname: draft.patch.hostname ?? original!.hostname,
          path: draft.patch.path === undefined ? original!.path : draft.patch.path,
          service:
            draft.patch.service ??
            (original!.origin.kind === "plain" ? original!.origin.service : ""),
        };
  function change(field: "hostname" | "path" | "service", input: string) {
    const next = field === "path" ? input || null : input;
    if (draft.kind === "new") {
      onChange({ ...row, draft: { ...draft, [field]: next } });
      return;
    }
    const patch = { ...draft.patch };
    const initial =
      field === "service"
        ? original!.origin.kind === "plain"
          ? original!.origin.service
          : ""
        : original![field];
    if (next === initial) delete patch[field];
    else if (field === "path") patch.path = next;
    else patch[field] = input;
    onChange({ ...row, draft: { ...draft, patch } });
  }
  return (
    <div className="cf-form-grid cf-route-fields">
      <label>
        {text.hostname}
        <input
          aria-label={`${tunnelRouteLabel(index)} ${text.hostname}`}
          value={value.hostname}
          required
          maxLength={253}
          placeholder={text.hostnamePlaceholder}
          onChange={(event) => change("hostname", event.target.value)}
        />
      </label>
      <label>
        {text.path}
        <input
          aria-label={`${tunnelRouteLabel(index)} ${text.path}`}
          value={value.path ?? ""}
          maxLength={2048}
          placeholder={text.pathPlaceholder}
          onChange={(event) => change("path", event.target.value)}
        />
      </label>
      <label className="cf-span">
        {text.origin}
        <input
          aria-label={`${tunnelRouteLabel(index)} ${text.origin}`}
          value={value.service}
          required={original?.origin.kind !== "private"}
          maxLength={4096}
          placeholder={text.originPlaceholder}
          onChange={(event) => change("service", event.target.value)}
        />
        {original?.origin.kind === "private" && (
          <span className="cf-help">
            {original.origin.label} {text.privateOrigin}
          </span>
        )}
      </label>
    </div>
  );
}

function RoutesForm({ draft, client }: { draft: TunnelDraft; client: TunnelClient }) {
  const { target, routes, detail } = draft;
  if (!detail) return null;
  const current = detail.routes;
  if (!routes)
    return (
      <section className="cf-subsection" aria-label={text.routes}>
        <Label>{text.routes}</Label>
        {current.kind === "readonly" && <p>{text.readonly[current.reason]}</p>}
        {current.kind !== "editable" && (
          <Notice error={current.kind === "unavailable"}>{current.message}</Notice>
        )}
      </section>
    );
  const { baseline, rows } = routes;
  const writable =
    detail.owner.kind === "account" &&
    current.kind === "editable" &&
    detail.writeState.kind === "ready";
  function update(next: RouteRow[]) {
    tunnelDrafts.editRoutes(target, next);
  }
  function move(index: number, offset: number) {
    const next = [...rows];
    const row = next.splice(index, 1)[0]!;
    next.splice(index + offset, 0, row);
    update(next);
  }
  return (
    <form
      className="cf-subsection"
      aria-label={text.routes}
      onSubmit={(event) => {
        event.preventDefault();
        void tunnelDrafts.save(target, client, "routes");
      }}
    >
      <div className="cf-row cf-wrap">
        <Label>{text.routes}</Label>
        {baseline.version !== undefined && (
          <span className="cf-meta">{tunnelConfigVersionLabel(baseline.version)}</span>
        )}
      </div>
      <p className="cf-help">{text.routeOrder}</p>
      {baseline.advanced && <p className="cf-help">{text.rootAdvanced}</p>}
      {current.kind !== "editable" && <Notice error>{current.message}</Notice>}
      <fieldset className="cf-route-list" disabled={Boolean(draft.activity) || !writable}>
        {rows.length === 0 && <p>{text.emptyRoutes}</p>}
        {rows.map((row, index) => {
          const route = row.draft;
          const advanced =
            route.kind === "existing" &&
            baseline.rules.find((rule) => rule.originalIndex === route.originalIndex)?.advanced;
          return (
            <div className="cf-route" key={row.key}>
              <div className="cf-row cf-wrap">
                <div className="cf-actions">
                  <h4>{tunnelRouteLabel(index)}</h4>
                  {advanced && <Badge>{text.advanced}</Badge>}
                </div>
                <div className="cf-actions">
                  <button
                    type="button"
                    className="cf-small"
                    disabled={index === 0}
                    aria-label={tunnelRouteActionLabel(text.up, index)}
                    onClick={() => move(index, -1)}
                  >
                    {text.up}
                  </button>
                  <button
                    type="button"
                    className="cf-small"
                    disabled={index === rows.length - 1}
                    aria-label={tunnelRouteActionLabel(text.down, index)}
                    onClick={() => move(index, 1)}
                  >
                    {text.down}
                  </button>
                  <button
                    type="button"
                    className="cf-small cf-danger"
                    aria-label={tunnelRouteActionLabel(text.remove, index)}
                    onClick={() => update(rows.filter((item) => item.key !== row.key))}
                  >
                    {text.remove}
                  </button>
                </div>
              </div>
              <RouteFields
                row={row}
                baseline={baseline}
                index={index}
                onChange={(next) =>
                  update(rows.map((item) => (item.key === row.key ? next : item)))
                }
              />
            </div>
          );
        })}
        <button
          type="button"
          onClick={() =>
            update([
              ...rows,
              {
                key: crypto.randomUUID(),
                draft: { kind: "new", hostname: "", path: null, service: "" },
              },
            ])
          }
        >
          {text.addRoute}
        </button>
      </fieldset>
      <div className="cf-route cf-fallback">
        <div className="cf-row cf-wrap">
          <Label>{text.fallback}</Label>
          {baseline.fallbackAdvanced && <Badge>{text.advanced}</Badge>}
        </div>
        <Origin origin={baseline.fallback} />
        <p className="cf-help">{text.fallbackHelp}</p>
      </div>
      <p className="cf-help">{text.publicWarning}</p>
      <p className="cf-help">{text.conflictWarning}</p>
      <div className="cf-actions cf-tunnel-save">
        <button
          className="cf-primary"
          disabled={
            !writable || Boolean(draft.activity) || draft.reloadRequired || !routesDirty(routes)
          }
          type="submit"
        >
          {draft.activity === "routes" ? text.savingRoutes : text.saveRoutes}
        </button>
      </div>
      <SaveResult result={draft.results.routes} />
    </form>
  );
}

function RecoveryForm({
  draft,
  client,
  revision,
}: {
  draft: TunnelDraft;
  client: TunnelClient;
  revision: string;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <details className="cf-subsection">
      <summary>{text.recover}</summary>
      <form
        aria-label={text.recover}
        onSubmit={(event) => {
          event.preventDefault();
          if (!acknowledged) return;
          setAcknowledged(false);
          void tunnelDrafts.recover(draft.target, client, revision, true);
        }}
      >
        <p>{text.recoveryHelp}</p>
        <label className="cf-recovery-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={Boolean(draft.activity)}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          {text.recoveryAcknowledgement}
        </label>
        <div className="cf-actions cf-tunnel-save">
          <button type="submit" disabled={!acknowledged || Boolean(draft.activity)}>
            {draft.activity === "recover" ? text.recovering : text.confirmRecovery}
          </button>
        </div>
      </form>
    </details>
  );
}

function TunnelEditorStatus({ draft, client }: { draft: TunnelDraft; client: TunnelClient }) {
  const { target, detail } = draft;
  const pendingWrite = detail?.writeState.kind === "unconfirmed";
  const recovery =
    detail?.owner.kind === "account" && detail.writeState.kind === "unconfirmed"
      ? detail.writeState.recovery
      : undefined;
  return (
    <>
      <div className="cf-row cf-wrap">
        <h3>{text.title}</h3>
        <button
          type="button"
          disabled={Boolean(draft.activity)}
          onClick={() => void tunnelDrafts.load(target, client, !pendingWrite)}
        >
          {pendingWrite ? text.refreshStatus : detail ? text.discard : text.reload}
        </button>
      </div>
      {draft.activity === "loading" && <output>{detail ? text.refreshing : text.loading}</output>}
      {draft.error && <Notice error>{draft.error}</Notice>}
      {pendingWrite ? (
        <Notice error>
          {detail.writeState.kind === "unconfirmed" && detail.writeState.message}
        </Notice>
      ) : (
        draft.reloadRequired && <Notice error>{text.reloadRequired}</Notice>
      )}
      {recovery && (
        <RecoveryForm
          key={recovery.revision}
          draft={draft}
          client={client}
          revision={recovery.revision}
        />
      )}
      {draft.results.recover && (
        <Notice error={draft.results.recover.kind !== "confirmed"}>
          {draft.results.recover.message}
        </Notice>
      )}
    </>
  );
}

export function TunnelEditor({ target, client }: { target: TunnelTarget; client: TunnelClient }) {
  useSyncExternalStore(tunnelDrafts.subscribe, tunnelDrafts.getSnapshot);
  const { accountId, clientId, tunnelId } = target;
  useEffect(() => {
    const target = { accountId, clientId, tunnelId };
    void tunnelDrafts.load(target, client);
    const interval = setInterval(() => void tunnelDrafts.load(target, client), 20_000);
    return () => clearInterval(interval);
  }, [accountId, clientId, tunnelId, client]);
  const draft = tunnelDrafts.get(target);
  if (!draft) return <output>{text.loading}</output>;
  const { detail, name } = draft;
  return (
    <section className="cf-tunnel-editor cf-subsection" aria-label={text.title}>
      <TunnelEditorStatus draft={draft} client={client} />
      {detail && (
        <>
          <dl className="cf-kv cf-tunnel-owner">
            <KeyValue label={text.owner}>
              {detail.owner.kind === "share" ? text.shareOwner : text.accountOwner}
            </KeyValue>
          </dl>
          {detail.owner.kind === "share" && <Notice>{text.shareReadonly}</Notice>}
          {name && (
            <form
              className="cf-subsection"
              onSubmit={(event) => {
                event.preventDefault();
                void tunnelDrafts.save(target, client, "rename");
              }}
            >
              <label>
                {text.name}
                <input
                  value={name.value}
                  required
                  maxLength={100}
                  disabled={Boolean(draft.activity) || detail.owner.kind !== "account"}
                  onChange={(event) => tunnelDrafts.editName(target, event.target.value)}
                />
              </label>
              <div className="cf-actions cf-tunnel-save">
                <button
                  className="cf-primary"
                  type="submit"
                  disabled={
                    Boolean(draft.activity) ||
                    draft.reloadRequired ||
                    detail.writeState.kind === "unconfirmed" ||
                    detail.owner.kind !== "account" ||
                    !name.value.trim() ||
                    name.value.trim() === name.baseline
                  }
                >
                  {draft.activity === "rename" ? text.savingName : text.saveName}
                </button>
              </div>
              <SaveResult result={draft.results.rename} />
            </form>
          )}
          <RoutesForm draft={draft} client={client} />
          <TunnelConnectors detail={detail} />
        </>
      )}
    </section>
  );
}
