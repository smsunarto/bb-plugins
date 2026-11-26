import { CatalogPage } from "../catalog/app/editor.tsx";
import { CatalogTab } from "../catalog/app/sidebar.tsx";
import type { CatalogListing } from "../catalog/contract.ts";
import { DocumentsPage, DocumentsTab } from "../documents/app.tsx";
import type { DocumentMetadata } from "../documents/model.ts";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalPageTitle, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PromptEditorPage, PluginsTab } from "../prompts/app/app.tsx";
import { queryClient as promptsQueryClient } from "../prompts/app/query.ts";
import type { Plugin } from "../prompts/shared/schema.ts";
import type { RulesState } from "../shared/rules.ts";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useSidebarColumnFill } from "@bb-plugins/ui/sidebar-fill";
import { Button } from "../../components/ui/button.tsx";
import { useIsCompactViewport } from "../../components/ui/hooks/use-compact-viewport.tsx";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx";
import { cn } from "../../lib/utils.ts";
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

/**
 * The page root's height and bottom edge. Under a theme that publishes
 * `--plugin-page-bottom-inset` (bb Monokai on a phone), the page runs under the
 * home indicator and pads its scroll end by it; elsewhere the inset is 0.
 */
const PAGE_BLEED =
  "h-[calc(100%+var(--plugin-page-bottom-inset,0px))] mb-[calc(-1*var(--plugin-page-bottom-inset,0px))] pb-[var(--plugin-page-bottom-inset,0px)]";

const liveUpdateOwners = new Set<symbol>();
let lastCatalogRevision: number | null = null;
let lastRulesRevision: number | null = null;

export function resetSourceLiveUpdatesForTest(): void {
  liveUpdateOwners.clear();
  lastCatalogRevision = null;
  lastRulesRevision = null;
}

/**
 * Refetches catalog, open file, and rules whenever the server folder or a mirror changes.
 * Ref-counted so desktop's mounted page + sidebar share one handler, and filtered by
 * revision so unchanged slices and client-known revisions do not trigger redundant refetches.
 */
function useSourceLiveUpdates() {
  const owner = useRef<symbol | null>(null);
  if (owner.current === null) owner.current = Symbol("sourceChanged");

  useEffect(() => {
    const token = owner.current!;
    liveUpdateOwners.add(token);
    return () => {
      liveUpdateOwners.delete(token);
    };
  }, []);

  useRealtime("sourceChanged", (payload: unknown) => {
    // Only the first active owner handles each realtime event.
    if (liveUpdateOwners.size > 0 && liveUpdateOwners.values().next().value !== owner.current) {
      return;
    }
    const event =
      payload && typeof payload === "object"
        ? (payload as { revision?: unknown; rulesRevision?: unknown })
        : null;
    const rev = typeof event?.revision === "number" ? event.revision : null;
    const rulesRev = typeof event?.rulesRevision === "number" ? event.rulesRevision : null;

    const cachedCatalogRev =
      queryClient.getQueryData<CatalogListing>(queryKey("catalog"))?.revision ?? null;
    const cachedRulesRev =
      queryClient.getQueryData<RulesState>(queryKey("rules"))?.revision ?? null;

    const catalogMoved =
      rev === null ||
      (rev !== lastCatalogRevision && (cachedCatalogRev === null || rev > cachedCatalogRev));
    const rulesMoved =
      rulesRev === null ||
      (rulesRev !== lastRulesRevision && (cachedRulesRev === null || rulesRev > cachedRulesRev));

    if (rev !== null) lastCatalogRevision = rev;
    if (rulesRev !== null) lastRulesRevision = rulesRev;

    if (catalogMoved) {
      void queryClient.invalidateQueries({ queryKey: queryKey("catalog") });
      void queryClient.invalidateQueries({ queryKey: queryKey("catalogFile") });
    }
    if (rulesMoved) {
      void queryClient.invalidateQueries({ queryKey: queryKey("rules") });
    }
  });
}

function AgentInstructionsPage({ subPath }: PluginNavPanelProps) {
  useSourceLiveUpdates();
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
      className={`flex min-h-0 min-w-0 flex-col ${PAGE_BLEED} ${compact ? "overflow-y-auto overscroll-contain" : ""}`}
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
    <div
      className={`flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain [--ai-surface:var(--background)] ${PAGE_BLEED}`}
    >
      <EditorSwitcher section={section} className="bg-background" />
      <SectionList subPath={subPath} section={section} home />
    </div>
  );
}

function SectionList(props: { subPath: string; section: Section; home?: boolean }) {
  const { subPath, section, home } = props;
  if (section === "global") return <CatalogTab subPath={subPath} compactHome={home} />;
  if (section === "prompts") return <PluginsTab subPath={promptSubPath(subPath) ?? ""} />;
  // The page's project pickers sit in the page, so a phone home keeps them above the list.
  return home ? <DocumentsPage subPath={subPath} home /> : <DocumentsTab subPath={subPath} />;
}

/**
 * Publishes the sticky switcher's height as `--ai-nav-height` on its parent, so an
 * editor's own sticky header (the catalog's filter) can sit just below it.
 */
function useStickyHeight() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    // Test DOMs have no ResizeObserver; every browser bb supports does.
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize[0]?.blockSize;
      if (height !== undefined)
        bar.parentElement?.style.setProperty("--ai-nav-height", `${height}px`);
    });
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  return ref;
}

/** The three editors, as a sticky tab switcher above the current editor's list. */
function EditorSwitcher({ section, className }: { section: Section; className: string }) {
  const navigate = useBbNavigate();
  const stickyRef = useStickyHeight();
  const openSection = (target: Section) => {
    const entry = SECTIONS.find((candidate) => candidate.section === target);
    if (entry) navigate.toPluginPanel("instructions", { subPath: entry.subPath });
  };
  return (
    <div
      ref={stickyRef}
      className={cn("sticky top-0 z-10 shrink-0 border-b border-border p-2", className)}
    >
      <Tabs
        value={section}
        activationMode="manual"
        onValueChange={(value) => openSection(value as Section)}
      >
        <TabsList aria-label="Instruction editors" className="h-auto max-w-full flex-wrap">
          {SECTIONS.map((entry) => (
            <TabsTrigger
              key={entry.section}
              value={entry.section}
              className="flex-none px-2 py-1 text-xs max-md:pointer-coarse:min-h-11 max-md:pointer-coarse:px-3"
              onMouseDown={(event) => {
                if (entry.section === section && event.button === 0 && !event.ctrlKey) {
                  openSection(entry.section);
                }
              }}
              onKeyDown={(event) => {
                if (
                  entry.section === section &&
                  event.target === event.currentTarget &&
                  (event.key === " " || event.key === "Enter")
                ) {
                  openSection(entry.section);
                }
              }}
            >
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}

/** The page's left sidebar: the editor switcher, then the current editor's file or plugin list. */
function AgentInstructionsSidebar({ subPath }: PluginNavPanelProps) {
  useSourceLiveUpdates();
  const { section } = locate(subPath);
  const root = useRef<HTMLDivElement>(null);
  // workaround:agent-instructions/sidebar-fill (manual removal; see workarounds.json)
  // Only the projects file tree needs a fixed height; the other lists scroll with the sidebar.
  useSidebarColumnFill(root, section === "projects");
  return (
    <div ref={root} className="flex h-full min-h-0 min-w-0 flex-col">
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
