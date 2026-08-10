import "./app.css";
import { definePluginApp, useBbNavigate } from "@bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { CORE_STATE_STYLES } from "@/components/status-badge";
import { mountSidebarNavStatus } from "@/components/sidebar-nav-status";
import { useCoreStatus } from "@/components/use-core-status";
import { HomePage } from "@/components/pages/home";
import { OAuthPage } from "@/components/pages/oauth";
import { ProvidersPage } from "@/components/pages/providers";
import { UsagePage } from "@/components/pages/usage";
import { AgentsPage } from "@/components/pages/agents";
import { AdvancedPage } from "@/components/pages/advanced";
import type { CoreStatus } from "./server";

/** The sidebar row's label. The content script finds the row by this text. */
const NAV_TITLE = "Agent Proxy";

const PAGES: { key: string; label: string; component: () => React.JSX.Element }[] = [
  { key: "", label: "Home", component: HomePage },
  { key: "oauth", label: "OAuth", component: OAuthPage },
  { key: "providers", label: "Providers", component: ProvidersPage },
  { key: "usage", label: "Usage", component: UsagePage },
  { key: "agents", label: "Agents", component: AgentsPage },
  { key: "advanced", label: "Advanced", component: AdvancedPage },
];

/** One muted line: colored dot, state, and port. The full controls live on Home. */
function SidebarIndicator({ status }: { status: CoreStatus | null }) {
  const style = status ? CORE_STATE_STYLES[status.state] : null;
  const text = !style
    ? "…"
    : status && status.state !== "not-installed"
      ? `${style.label} · :${status.port}`
      : style.label;

  return (
    <div
      className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground"
      title={style ? `CLIProxyAPI core — ${text}` : "CLIProxyAPI core — loading"}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", style?.dot ?? "bg-muted-foreground/40")} />
      <span className="truncate">{text}</span>
    </div>
  );
}

function AgentProxyPanel({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const { status } = useCoreStatus();
  const activeKey = subPath.split("/")[0] ?? "";
  const active = PAGES.find((page) => page.key === activeKey) ?? PAGES[0]!;
  const ActiveComponent = active.component;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-48 shrink-0 flex-col border-r border-border">
        <SidebarIndicator status={status} />
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

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "agent-proxy",
    title: NAV_TITLE,
    icon: "Server",
    path: "agent-proxy",
    component: AgentProxyPanel,
  });
  app.contentScripts.register({
    id: "sidebar-nav-status",
    mount: ({ signal }) => mountSidebarNavStatus({ title: NAV_TITLE, signal }),
  });
});
