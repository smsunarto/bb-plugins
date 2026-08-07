import "./app.css";
import { definePluginApp, useBbNavigate } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { useCoreStatus } from "@/components/use-core-status";
import { HomePage } from "@/components/pages/home";
import { OAuthPage } from "@/components/pages/oauth";
import { ProvidersPage } from "@/components/pages/providers";
import { UsagePage } from "@/components/pages/usage";
import { AgentsPage } from "@/components/pages/agents";

const PAGES: { key: string; label: string; component: () => React.JSX.Element }[] = [
  { key: "", label: "Home", component: HomePage },
  { key: "oauth", label: "OAuth", component: OAuthPage },
  { key: "providers", label: "Providers", component: ProvidersPage },
  { key: "usage", label: "Usage", component: UsagePage },
  { key: "agents", label: "Agents", component: AgentsPage },
];

function AgentProxyPanel({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const { status } = useCoreStatus();
  const activeKey = subPath.split("/")[0] ?? "";
  const active = PAGES.find((page) => page.key === activeKey) ?? PAGES[0]!;
  const ActiveComponent = active.component;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-48 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border p-3">
          {status ? (
            <StatusBadge state={status.state} />
          ) : (
            <span className="text-sm text-muted-foreground">…</span>
          )}
          <div className="mt-0.5 text-xs text-muted-foreground">port {status?.port ?? "…"}</div>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {PAGES.map((page) => (
            <button
              key={page.key}
              type="button"
              className={cn(
                "block w-full rounded-md px-2 py-1.5 text-left text-sm",
                page.key === active.key
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              onClick={() => navigate.toPluginPanel("agent-proxy", { subPath: page.key })}
            >
              {page.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-5">
          <ActiveComponent />
        </div>
      </main>
    </div>
  );
}

function HomepageCard() {
  const navigate = useBbNavigate();
  const { status, rpc, refresh } = useCoreStatus();

  const toggle = async () => {
    if (!status) return;
    try {
      await rpc.call(status.state === "running" || status.state === "starting" ? "stop" : "start");
      await refresh();
    } catch (cause) {
      toast.error(String(cause instanceof Error ? cause.message : cause));
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      <div className="min-w-0 flex-1">
        {status ? <StatusBadge state={status.state} /> : <span className="text-sm text-muted-foreground">…</span>}
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {status
            ? status.state === "not-installed"
              ? "CLIProxyAPI core is not installed yet"
              : `${status.endpoints.openai} · v${status.installedVersion ?? "?"}`
            : ""}
        </div>
      </div>
      {status && status.state !== "not-installed" ? (
        <Button size="sm" variant="outline" onClick={() => void toggle()}>
          {status.state === "running" || status.state === "starting" ? "Stop" : "Start"}
        </Button>
      ) : null}
      <Button size="sm" onClick={() => navigate.toPluginPanel("agent-proxy", { subPath: "" })}>
        Open
      </Button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "agent-proxy",
    title: "Agent Proxy",
    icon: "Server",
    path: "agent-proxy",
    component: AgentProxyPanel,
  });
  app.slots.homepageSection({
    id: "agent-proxy-status",
    title: "Agent Proxy",
    component: HomepageCard,
  });
});
