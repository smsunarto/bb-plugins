import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { QueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CreateShare, Overview, Share, Spec } from "../shared/schema.ts";
import { rpc } from "./rpc.ts";
import { tunnelDrafts } from "./tunnel-drafts.ts";
import { Access, DnsInventory, Tunnels } from "./inventory.tsx";
import { CreateForm, ShareCard, newShareLabel } from "./shares.tsx";
import {
  TABS,
  activeTab,
  connectionLabel,
  connectionTone,
  sectionErrors,
  tabCount,
} from "./labels.ts";
import type { TabPath } from "./labels.ts";
import { Badge, CopyButton, EmptyState, Mono, Notice, SettingsLink } from "./ui.tsx";
import "./cloudflare.css";

// bb remounts the panel on every sub-path change. A client owned by the
// boundary would be discarded with it, so each tab switch would reload the
// account and flash skeletons. Sharing one client keeps the overview cached
// across tabs and lets the interval refetch update it in the background.
const queryClient = new QueryClient();

function ConnectionSkeleton() {
  return (
    <section className="cf-card cf-connection" aria-hidden="true">
      <div className="cf-row cf-wrap">
        <div className="cf-connection-summary">
          <span className="cf-badge cf-skeleton-text">Connected</span>
          <span className="cf-mono cf-skeleton-text">{"0".repeat(32)}</span>
        </div>
        <button type="button" className="cf-skeleton-text" disabled>
          Disconnect
        </button>
      </div>
    </section>
  );
}

function ContentSkeleton() {
  return (
    <div className="cf-stack" aria-hidden="true">
      {[0, 1].map((index) => (
        <div className="cf-card" key={index}>
          <div className="cf-row">
            <div>
              <h3>
                <span className="cf-skeleton-text">Loading account inventory</span>
              </h3>
              <p>
                <span className="cf-skeleton-text">Waiting for Cloudflare to answer.</span>
              </p>
            </div>
            <span className="cf-badge cf-skeleton-text">Loading</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ConnectionCard({
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
  const hasErrors = sectionErrors(overview);
  if (oauth.connected) {
    return (
      <section className="cf-card cf-connection" aria-label="Account connection">
        <div className="cf-row cf-wrap">
          <div className="cf-connection-summary">
            <Badge tone={connectionTone(oauth, hasErrors)} dot>
              {connectionLabel(oauth, hasErrors)}
            </Badge>
            <span className="cf-meta">
              Account <Mono>{setup.accountId}</Mono>
            </span>
            <CopyButton value={setup.accountId} label="Copy ID" />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onDisconnect}
            title="Existing shares keep running after you disconnect."
          >
            Disconnect
          </button>
        </div>
        {oauth.error && <Notice error>{oauth.error}</Notice>}
        {hasErrors && (
          <Notice error>
            Some account sections could not be read. Review the errors in each tab and check the
            access granted to this connection.
          </Notice>
        )}
      </section>
    );
  }
  return (
    <section className="cf-card cf-connection cf-connect" aria-label="Account connection">
      <div className="cf-row cf-wrap">
        <div>
          <h2>Connect your Cloudflare account</h2>
          <p>
            {oauth.configured
              ? "Sign in with Cloudflare to manage tunnels, Access and protected shares."
              : "Add your account ID and OAuth client in plugin settings to get started."}
          </p>
          {!oauth.configured && oauth.missing.length > 0 && (
            <p className="cf-help">Missing: {oauth.missing.join(", ")}.</p>
          )}
        </div>
        <div className="cf-actions">
          {oauth.configured ? (
            <button className="cf-primary" type="button" disabled={busy} onClick={onConnect}>
              {connecting ? "Connecting…" : "Connect with Cloudflare"}
            </button>
          ) : (
            <SettingsLink />
          )}
        </div>
      </div>
      {oauth.error && <Notice error>{oauth.error}</Notice>}
      {oauth.configured && (
        <p className="cf-help">Cloudflare asks you to approve access to Tunnel, Access and DNS.</p>
      )}
    </section>
  );
}

function SectionErrors({ overview }: { overview: Overview }) {
  const sections: [string, { error?: string }][] = [
    ["Hosts", overview.hosts],
    ["Zones", overview.zones],
    ["Identity providers", overview.identityProviders],
  ];
  return (
    <>
      {sections.map(([name, section]) =>
        section.error ? (
          <Notice error key={name}>
            {name} could not be loaded. {section.error}
          </Notice>
        ) : null,
      )}
    </>
  );
}

function Inventory({
  overview,
  path,
  loading,
  client,
}: {
  client: Client;
  overview?: Overview;
  path: TabPath;
  loading: boolean;
}) {
  if (!overview) return loading ? <ContentSkeleton /> : null;
  if (!overview.setup.configured) {
    return (
      <EmptyState title="Connect your account">
        Tunnel, Access and DNS inventory loads once the account is connected.
      </EmptyState>
    );
  }
  if (path === "dns") return <DnsInventory overview={overview} />;
  return path === "tunnels" ? (
    <Tunnels overview={overview} client={client} />
  ) : (
    <Access overview={overview} />
  );
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
        <h1>Account overview</h1>
        <p>Tunnels, Access and DNS for the connected account, plus protected development shares.</p>
      </div>
      <button className="cf-refresh" type="button" disabled={fetching || busy} onClick={onRefresh}>
        {fetching ? "Refreshing…" : "Refresh"}
      </button>
    </header>
  );
}

type ShareAction = "start" | "stop" | "remove";
type Client = ReturnType<typeof rpc.useClient>;
type MutationResult = { ok: boolean; message: string };

function useShareController(client: Client, refetch: () => Promise<unknown>) {
  const [newOpen, setNewOpen] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<CreateShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const mutationLock = useRef(false);
  function fail(error: unknown, fallback: string) {
    setNotice({ message: error instanceof Error ? error.message : fallback, error: true });
  }
  async function mutate(operation: () => Promise<MutationResult>): Promise<boolean> {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    setBusy(true);
    setNotice(null);
    let ok = false;
    try {
      const result = await operation();
      setNotice({ message: result.message, error: !result.ok });
      ok = result.ok;
    } catch (error) {
      fail(error, "The request failed. Refresh the account and try again.");
    } finally {
      await refetch();
      mutationLock.current = false;
      setBusy(false);
    }
    return ok;
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
      fail(error, "Cloudflare sign-in could not start.");
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
  function onAction(action: ShareAction, target: Share) {
    void mutate(async () => {
      const result = await client[action]({ id: target.id, expectedRevision: target.revision });
      if (action === "remove" && result.ok && pendingCreate?.id === target.id) {
        setPendingCreate(null);
        setNewOpen(false);
      }
      return result;
    });
  }
  function onResume(target: Share) {
    setNewOpen(true);
    void create({
      id: target.id,
      hostId: target.hostId,
      zoneId: target.zoneId,
      hostname: target.hostname,
      spec: target.desiredSpec,
    });
  }
  return {
    newOpen,
    setNewOpen,
    pendingCreate,
    busy,
    connecting,
    notice,
    connect: () => void connect(),
    disconnect: () => void mutate(() => client.oauthDisconnect()),
    create,
    onAction,
    onResume,
    onUpdate: (target: Share, spec: Spec) =>
      mutate(() => client.update({ id: target.id, expectedRevision: target.revision, spec })),
  };
}
type ShareController = ReturnType<typeof useShareController>;

function ShareList({ data, shares }: { data: Overview; shares: ShareController }) {
  return (
    <div className="cf-stack">
      {data.shares
        .filter((share) => share.state !== "removed")
        .map((share) => (
          <ShareCard
            key={share.id}
            share={share}
            overview={data}
            busy={shares.busy || !data.setup.configured}
            onAction={shares.onAction}
            onUpdate={shares.onUpdate}
            onResume={shares.onResume}
          />
        ))}
    </div>
  );
}

function SharesSection({
  data,
  loading,
  shares,
  newShareButton,
}: {
  data?: Overview;
  loading: boolean;
  shares: ShareController;
  newShareButton: ReactNode;
}) {
  const configured = data?.setup.configured ?? false;
  const hasShares = data?.shares.some((share) => share.state !== "removed") ?? false;
  return (
    <section aria-label="Development shares">
      {loading && <ContentSkeleton />}
      {data && (
        <>
          <SectionErrors overview={data} />
          {shares.newOpen && (
            <CreateForm
              key={shares.pendingCreate?.id ?? "new"}
              overview={data}
              pending={shares.pendingCreate}
              busy={shares.busy}
              onSubmit={shares.create}
              onClose={() => shares.setNewOpen(false)}
            />
          )}
          {!hasShares && !shares.newOpen && (
            <EmptyState
              title="No development shares yet"
              action={configured ? newShareButton : undefined}
            >
              {configured
                ? "Share a local port from an enrolled host behind an email allowlist."
                : "Connect your account above to create a protected share."}
            </EmptyState>
          )}
          {hasShares && <ShareList data={data} shares={shares} />}
        </>
      )}
      <p className="cf-footnote">
        Running means the tunnel is healthy and the connector is up. Open a share signed out and
        complete login to confirm Access works.
      </p>
    </section>
  );
}

function Tabs({
  active,
  data,
  onSelect,
}: {
  active: TabPath;
  data?: Overview;
  onSelect: (path: TabPath) => void;
}) {
  return (
    <nav className="cf-tabs" aria-label="Cloudflare sections">
      {TABS.map((tab) => (
        <button
          key={tab.path}
          type="button"
          aria-current={active === tab.path ? "page" : undefined}
          onClick={() => onSelect(tab.path)}
        >
          {tab.label}
          <span className={data ? undefined : "cf-count-loading"} aria-hidden={!data}>
            {tabCount(data, tab.path)}
          </span>
        </button>
      ))}
    </nav>
  );
}

function CloudflarePanel({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const client = rpc.useClient();
  const overview = rpc.overview.useQuery({
    refetchInterval: 20_000,
    retry: false,
    staleTime: 10_000,
  });
  const shares = useShareController(client, () => overview.refetch());
  const active = activeTab(subPath);
  const data = overview.data;
  const accountId = data?.setup.accountId;
  const clientId = data?.setup.oauth.clientId;
  const connected = data?.setup.oauth.connected;
  useLayoutEffect(() => {
    if (connected === undefined) return;
    tunnelDrafts.bind(connected && accountId && clientId ? { accountId, clientId } : null);
  }, [accountId, clientId, connected]);
  const hasShares = data?.shares.some((share) => share.state !== "removed") ?? false;
  const newShareButton = (
    <button
      className="cf-primary"
      type="button"
      disabled={!data?.setup.configured || shares.busy}
      onClick={() => shares.setNewOpen(!shares.newOpen)}
    >
      {newShareLabel(shares.newOpen, shares.pendingCreate)}
    </button>
  );
  return (
    <main className="cf-panel" aria-busy={overview.isPending}>
      <div className="cf-content">
        <CloudflareHeader
          fetching={overview.isFetching}
          busy={shares.busy}
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
          <ConnectionCard
            overview={data}
            busy={shares.busy}
            connecting={shares.connecting}
            onConnect={shares.connect}
            onDisconnect={shares.disconnect}
          />
        )}
        <Tabs
          active={active.path}
          data={data}
          onSelect={(path) => navigate.toPluginPanel("cloudflare", { subPath: path })}
        />
        {shares.notice && <Notice error={shares.notice.error}>{shares.notice.message}</Notice>}
        <div className="cf-row cf-section-heading">
          <div>
            <h2 className="cf-sr-only">{active.title}</h2>
            <p>{active.description}</p>
          </div>
          {active.path === "" && hasShares && newShareButton}
        </div>
        {active.path === "" ? (
          <SharesSection
            data={data}
            loading={overview.isPending}
            shares={shares}
            newShareButton={newShareButton}
          />
        ) : (
          <Inventory
            overview={data}
            path={active.path}
            loading={overview.isPending}
            client={client}
          />
        )}
      </div>
    </main>
  );
}

function CloudflareApp({ subPath }: { subPath: string }) {
  return (
    <PluginQueryBoundary client={queryClient}>
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
