import { CatalogPage } from "../catalog/app/editor.tsx";
import { CatalogTab } from "../catalog/app/sidebar.tsx";
import type { CatalogListing } from "../catalog/contract.ts";
import { DocumentsPage, DocumentsTab } from "../documents/app.tsx";
import type { DocumentMetadata } from "../documents/model.ts";
import { definePluginApp, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ExperimentalPageTitle, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PromptEditorPage, PluginsTab } from "../prompts/app/app.tsx";
import { queryClient as promptsQueryClient } from "../prompts/app/query.ts";
import type { Plugin } from "../prompts/shared/schema.ts";
import type { RulesState } from "../shared/rules.ts";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useIsCompactViewport } from "../../components/ui/hooks/use-compact-viewport.tsx";
import {
  crumbRoute,
  locate,
  pageTrail,
  promptSubPath,
  SECTIONS,
  type Crumb,
  type Section,
} from "./nav.ts";
import { queryClient } from "./query.ts";
import { queryKey } from "./rpc.ts";
import { parseRulesRoute, RulesPage } from "./rules.tsx";

function AgentInstructionsPage({ subPath }: PluginNavPanelProps) {
  const compact = useIsCompactViewport();
  const { section, item } = locate(subPath);
  // A phone keeps the sidebar in a closed drawer, so an editor's root shows its list here.
  if (compact && !item) return <PhoneHome subPath={subPath} section={section} />;
  // bb's title bar truncates a long trail on a phone, so an open item gets its own back bar.
  // The tree is the same at every width, so rotating a phone keeps the open editor mounted.
  return (
    // A phone scrolls the whole page here, since bb's pane clips, so the back bar stays
    // stuck above an editor that grows with its text.
    <div
      className={`flex h-full min-h-0 min-w-0 flex-col ${compact ? "overflow-y-auto overscroll-contain" : ""}`}
    >
      {compact && <PhoneBar subPath={subPath} />}
      <div className={`flex min-w-0 flex-col ${compact ? "flex-none" : "min-h-0 flex-1"}`}>
        <EditorPage subPath={subPath} section={section} />
      </div>
    </div>
  );
}

function EditorPage({ subPath, section }: { subPath: string; section: Section }) {
  const prompts = promptSubPath(subPath);
  const rules = parseRulesRoute(subPath);
  // Global is the default editor: the bare panel path and old links open it.
  return rules !== null ? (
    <RulesPage selected={rules.rule} />
  ) : section === "projects" ? (
    <DocumentsPage subPath={subPath} />
  ) : prompts !== null ? (
    <PromptEditorPage subPath={prompts} />
  ) : (
    <CatalogPage subPath={subPath} />
  );
}

/** A phone's back bar: up one level. bb's title bar already names the open item. */
function PhoneBar({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const trail = useTrail(subPath);
  // Back lands on the nearest list. A rule's parent, the rules page, is another editor.
  const parent = trail.findLast(
    (crumb) => crumb.subPath !== undefined && !locate(crumb.subPath).item,
  );
  return (
    <nav
      aria-label="Instruction location"
      className="sticky top-0 z-10 flex min-w-0 shrink-0 items-center gap-1 border-b border-border bg-background px-2 py-1"
    >
      {parent && (
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0"
          aria-label={`Back to ${parent.label}`}
          onClick={() => navigate.toPluginPanel("instructions", { subPath: parent.subPath })}
        >
          <Icon name="ChevronLeft" className="size-4" aria-hidden />
          <span className="truncate">{parent.label}</span>
        </Button>
      )}
    </nav>
  );
}

/** A phone's editor root: the switcher, then the list the desktop sidebar shows. */
function PhoneHome({ subPath, section }: { subPath: string; section: Section }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain [--ai-surface:var(--background)]">
      <EditorSwitcher section={section} className="bg-background" />
      <SectionList subPath={subPath} section={section} home />
    </div>
  );
}

function SectionList(props: { subPath: string; section: Section; home?: boolean }) {
  const { subPath, section, home } = props;
  if (section === "global") return <CatalogTab subPath={subPath} />;
  if (section === "prompts") return <PluginsTab subPath={promptSubPath(subPath) ?? ""} />;
  // The page's project pickers sit in the page, so a phone home keeps them above the list.
  return home ? <DocumentsPage subPath={subPath} home /> : <DocumentsTab subPath={subPath} />;
}

/**
 * Publishes the sticky switcher's height as `--ai-nav-height` on its parent, so an
 * editor's own sticky header (the catalog's filter) can sit just below it.
 */
function useStickyHeight() {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = ref.current;
    // Test DOMs have no ResizeObserver; every browser bb supports does.
    if (!nav || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize[0]?.blockSize;
      if (height !== undefined)
        nav.parentElement?.style.setProperty("--ai-nav-height", `${height}px`);
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);
  return ref;
}

/** The three editors, as a sticky row of buttons above the current editor's list. */
function EditorSwitcher({ section, className }: { section: Section; className: string }) {
  const navigate = useBbNavigate();
  const navRef = useStickyHeight();
  return (
    <nav
      ref={navRef}
      aria-label="Instruction editors"
      className={`sticky top-0 z-10 flex shrink-0 flex-wrap gap-1 border-b border-border p-2 ${className}`}
    >
      {SECTIONS.map((entry) => (
        <Button
          key={entry.label}
          variant={entry.section === section ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={entry.section === section}
          onClick={() => navigate.toPluginPanel("instructions", { subPath: entry.subPath })}
        >
          {entry.label}
        </Button>
      ))}
    </nav>
  );
}

/** The page's left sidebar: the editor switcher, then the current editor's file or plugin list. */
function AgentInstructionsSidebar({ subPath }: PluginNavPanelProps) {
  const { section } = locate(subPath);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <EditorSwitcher section={section} className="bg-sidebar" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SectionList subPath={subPath} section={section} />
      </div>
    </div>
  );
}

/**
 * Data a page already loaded, read from the cache. It adds no query observer, so it never
 * fetches and never replaces the fetcher the page's own query registered.
 */
function useCached<T>(client: QueryClient, key: QueryKey): T | undefined {
  return useSyncExternalStore(
    (notify) => client.getQueryCache().subscribe(notify),
    () => client.getQueryData<T>(key),
  );
}

/** The trail to `subPath`, named from data the page already loaded. */
function useTrail(subPath: string): Crumb[] {
  const catalog = useCached<CatalogListing>(queryClient, queryKey("catalog"));
  const rules = useCached<RulesState>(queryClient, queryKey("rules"));
  const sources = useCached<DocumentMetadata>(queryClient, queryKey("documentSources"));
  const plugins = useCached<{ plugins: Plugin[] }>(promptsQueryClient, queryKey("plugins"));
  return pageTrail(subPath, {
    doc: (id) => catalog?.docs.find((doc) => doc.id === id)?.name,
    rule: (id) => rules?.rules.find((rule) => rule.id === id)?.name,
    project: (id) => sources?.projects.find((project) => project.id === id)?.name,
    plugin: (id) => plugins?.plugins.find((plugin) => plugin.id === id)?.name,
  });
}

/**
 * The title bar's trail: the editor, then the open item, each level linking back up.
 * A phone's bar has room for one name, so it gets only the open item's.
 */
function usePageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle {
  const trail = useTrail(subPath);
  const compact = useIsCompactViewport();
  if (compact) return { title: trail.at(-1)!.label };
  return {
    breadcrumbs: trail.map((crumb) =>
      crumb.subPath === undefined
        ? { label: crumb.label }
        : { label: crumb.label, to: crumbRoute(crumb.subPath) },
    ),
  };
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "agent-instructions",
    title: "Agent instructions",
    icon: "agent-instructions/plugin",
    path: "instructions",
    component: AgentInstructionsPage,
    experimental_sidebar: AgentInstructionsSidebar,
    experimental_usePageTitle: usePageTitle,
  });
});
