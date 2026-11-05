import { CatalogPage } from "../catalog/app/editor.tsx";
import { CatalogTab } from "../catalog/app/sidebar.tsx";
import { DocumentsPage, DocumentsTab } from "../documents/app.tsx";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PromptEditorPage, PluginsTab } from "../prompts/app/app.tsx";
import { useLayoutEffect, useRef } from "react";
import { Button } from "../../components/ui/button.tsx";
import { parseRulesRoute, RulesPage } from "./rules.tsx";

function promptSubPath(subPath: string): string | null {
  return subPath === "prompts" ? "" : subPath.startsWith("prompts/") ? subPath.slice(8) : null;
}

const DOCUMENT_ROUTE = /^projects(?:\/|$)/;

function AgentInstructionsPage({ subPath }: PluginNavPanelProps) {
  const prompts = promptSubPath(subPath);
  const rules = parseRulesRoute(subPath);
  // Global is the default editor: the bare panel path and old links open it.
  return rules !== null ? (
    <RulesPage selected={rules.rule} />
  ) : DOCUMENT_ROUTE.test(subPath) ? (
    <DocumentsPage subPath={subPath} />
  ) : prompts !== null ? (
    <PromptEditorPage subPath={prompts} />
  ) : (
    <CatalogPage subPath={subPath} />
  );
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

/** The page's left sidebar: the editor switcher, then the current editor's file or plugin list. */
function AgentInstructionsSidebar({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const prompts = promptSubPath(subPath);
  const documents = DOCUMENT_ROUTE.test(subPath);
  const catalog = !documents && prompts === null;
  const editors = [
    { label: "Global", active: catalog, subPath: "global" },
    { label: "Projects", active: documents, subPath: "projects" },
    { label: "Plugin prompts", active: prompts !== null, subPath: "prompts" },
  ];
  const navRef = useStickyHeight();
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <nav
        ref={navRef}
        aria-label="Instruction editors"
        className="sticky top-0 z-10 flex shrink-0 flex-wrap gap-1 border-b border-border bg-sidebar p-2"
      >
        {editors.map((editor) => (
          <Button
            key={editor.label}
            variant={editor.active ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={editor.active}
            onClick={() => navigate.toPluginPanel("instructions", { subPath: editor.subPath })}
          >
            {editor.label}
          </Button>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {catalog ? (
          <CatalogTab subPath={subPath} />
        ) : documents ? (
          <DocumentsTab subPath={subPath} />
        ) : (
          <PluginsTab subPath={prompts ?? ""} />
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "agent-instructions",
    title: "Agent instructions",
    icon: "agent-instructions/plugin",
    path: "instructions",
    component: AgentInstructionsPage,
    experimental_sidebar: AgentInstructionsSidebar,
  });
});
