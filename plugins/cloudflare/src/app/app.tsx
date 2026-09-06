import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { QueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  CreateShare,
  Overview,
  QuickCreate,
  QuickList,
  QuickShare,
  Share,
  Spec,
} from "../shared/schema.ts";
import { rpc } from "./rpc.ts";
import { tunnelDrafts } from "./tunnel-drafts.ts";
import { Access, DnsInventory, Tunnels } from "./inventory.tsx";
import { CreateForm, QuickCreateForm, QuickShareCard, ShareCard } from "./shares.tsx";
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
// Exported so tests can reset the cache between cases.
export const queryClient = new QueryClient();

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
function protectedShareLabel(open: boolean, pending: CreateShare | null) {
  if (open) return "Hide protected form";
  return pending ? "Resume protected request" : "Protected share…";
}
type Client = ReturnType<typeof rpc.useClient>;
type MutationResult = { ok: boolean; message: string };

function useShareController(client: Client, refetch: () => Promise<unknown>) {
  const [newOpen, setNewOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<CreateShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const mutationLock = useRef(false);
  function fail(error: unknown, fallback: string) {
    setNotice({ message: error instanceof Error ? error.message : fallback, error: true });
  }
  // Resolves with the server result, or null when the call was skipped or threw.
  async function mutate(operation: () => Promise<MutationResult>): Promise<MutationResult | null> {
    if (mutationLock.current) return null;
    mutationLock.current = true;
    setBusy(true);
    setNotice(null);
    let result: MutationResult | null = null;
    try {
      result = await operation();
      setNotice({ message: result.message, error: !result.ok });
    } catch (error) {
      fail(error, "The request failed. Refresh the account and try again.");
    } finally {
      await refetch();
      mutationLock.current = false;
      setBusy(false);
    }
    return result;
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
    const result = await mutate(() => client.create(input));
    if (!result) return;
    setPendingCreate(null);
    setNewOpen(false);
  }
  async function onAction(action: ShareAction, target: Share) {
    const result = await mutate(() =>
      client[action]({ id: target.id, expectedRevision: target.revision }),
    );
    if (action === "remove" && result?.ok && pendingCreate?.id === target.id) {
      setPendingCreate(null);
      setNewOpen(false);
    }
  }
  async function quickCreate(input: QuickCreate) {
    const result = await mutate(() => client.quickCreate(input));
    if (result?.ok) setQuickOpen(false);
  }
  function quickAction(action: ShareAction, share: QuickShare) {
    void mutate(() => {
      if (action === "start") return client.quickStart({ id: share.id });
      if (action === "stop") return client.quickStop({ id: share.id });
      return client.quickRemove({ id: share.id });
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
    quickOpen,
    setQuickOpen,
    quickCreate,
    quickAction,
    pendingCreate,
    busy,
    connecting,
    notice,
    connect: () => void connect(),
    disconnect: () => void mutate(() => client.oauthDisconnect()),
    create,
    onAction,
    onResume,
    onUpdate: async (target: Share, spec: Spec) =>
      (
        await mutate(() =>
          client.update({ id: target.id, expectedRevision: target.revision, spec }),
        )
      )?.ok ?? false,
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

function QuickShareList({ quick, shares }: { quick: QuickList; shares: ShareController }) {
  return (
    <div className="cf-stack">
      {quick.shares.map((share) => (
        <QuickShareCard
          key={share.id}
          share={share}
          hosts={quick.hosts.items}
          busy={shares.busy}
          onAction={shares.quickAction}
        />
      ))}
    </div>
  );
}

function ShareForms({
  data,
  quick,
  shares,
}: {
  data?: Overview;
  quick?: QuickList;
  shares: ShareController;
}) {
  return (
    <>
      {shares.quickOpen && quick && (
        <QuickCreateForm
          hosts={quick.hosts.items}
          busy={shares.busy}
          onSubmit={shares.quickCreate}
          onClose={() => shares.setQuickOpen(false)}
        />
      )}
      {shares.newOpen && data && (
        <CreateForm
          key={shares.pendingCreate?.id ?? "new"}
          overview={data}
          pending={shares.pendingCreate}
          busy={shares.busy}
          onSubmit={shares.create}
          onClose={() => shares.setNewOpen(false)}
        />
      )}
    </>
  );
}

function ProtectedShares({ data, shares }: { data: Overview; shares: ShareController }) {
  return (
    <>
      <div className="cf-section-heading cf-section-gap">
        <h3>Protected shares</h3>
      </div>
      <ShareList data={data} shares={shares} />
    </>
  );
}

function SharesSection({
  data,
  quick,
  loading,
  shares,
  actions,
}: {
  data?: Overview;
  quick?: QuickList;
  loading: boolean;
  shares: ShareController;
  actions: ReactNode;
}) {
  const hasQuick = Boolean(quick?.shares.length);
  const hasProtected = data?.shares.some((share) => share.state !== "removed") ?? false;
  const formOpen = shares.quickOpen || shares.newOpen;
  const empty = Boolean(quick) && !hasQuick && !hasProtected && !formOpen;
  return (
    <section aria-label="Development shares">
      {loading && !quick && <ContentSkeleton />}
      {quick?.hosts.error && <Notice error>Hosts could not be loaded. {quick.hosts.error}</Notice>}
      {data && <SectionErrors overview={data} />}
      <ShareForms data={data} quick={quick} shares={shares} />
      {empty && (
        <EmptyState title="No development shares yet" action={actions}>
          Publish a local port from an enrolled host on a temporary trycloudflare.com URL. Protected
          shares with an email allowlist need a connected account.
        </EmptyState>
      )}
      {quick && hasQuick && <QuickShareList quick={quick} shares={shares} />}
      {data && hasProtected && <ProtectedShares data={data} shares={shares} />}
      <p className="cf-footnote">
        Quick shares are public while they run. For protected shares, Running means the tunnel is
        healthy and the connector is up; open one signed out to confirm Access works.
      </p>
    </section>
  );
}

function Tabs({
  active,
  data,
  count,
  onSelect,
}: {
  active: TabPath;
  data?: Overview;
  count: (path: TabPath) => number;
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
            {count(tab.path)}
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
  const quick = rpc.quickList.useQuery({ refetchInterval: 10_000, retry: false, staleTime: 5_000 });
  const shares = useShareController(client, () =>
    Promise.all([overview.refetch(), quick.refetch()]),
  );
  const active = activeTab(subPath);
  const data = overview.data;
  const accountId = data?.setup.accountId;
  const clientId = data?.setup.oauth.clientId;
  const connected = data?.setup.oauth.connected;
  useLayoutEffect(() => {
    if (connected === undefined) return;
    tunnelDrafts.bind(connected && accountId && clientId ? { accountId, clientId } : null);
  }, [accountId, clientId, connected]);
  const quickCount = quick.data?.shares.length ?? 0;
  const hasShares =
    quickCount > 0 || (data?.shares.some((share) => share.state !== "removed") ?? false);
  const shareActions = (
    <div className="cf-actions">
      {data?.setup.configured && (
        <button
          type="button"
          disabled={shares.busy}
          onClick={() => shares.setNewOpen(!shares.newOpen)}
        >
          {protectedShareLabel(shares.newOpen, shares.pendingCreate)}
        </button>
      )}
      <button
        className="cf-primary"
        type="button"
        disabled={shares.busy || !quick.data}
        onClick={() => shares.setQuickOpen(!shares.quickOpen)}
      >
        {shares.quickOpen ? "Hide form" : "New share"}
      </button>
    </div>
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
          count={(path) => tabCount(data, path) + (path === "" ? quickCount : 0)}
          onSelect={(path) => navigate.toPluginPanel("cloudflare", { subPath: path })}
        />
        {quick.error && (
          <Notice error>Quick shares could not be loaded. {quick.error.message}</Notice>
        )}
        {shares.notice && <Notice error={shares.notice.error}>{shares.notice.message}</Notice>}
        <div className="cf-row cf-section-heading">
          <div>
            <h2 className="cf-sr-only">{active.title}</h2>
            <p>{active.description}</p>
          </div>
          {active.path === "" && hasShares && shareActions}
        </div>
        {active.path === "" ? (
          <SharesSection
            data={data}
            quick={quick.data}
            loading={overview.isPending || quick.isPending}
            shares={shares}
            actions={shareActions}
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
