import { useState } from "react";
import type { ReactElement } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { QueryClientProvider } from "@tanstack/react-query";
import { FilesSection } from "./files-section.tsx";
import { queryClient } from "./query.ts";
import { TasksSection } from "./tasks-section.tsx";

const SECTIONS = [
  { id: "files", label: "Files" },
  { id: "workflows", label: "Workflows" },
  { id: "tasks", label: "Tasks" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const SECTION_TAB_CLASS =
  "inline-flex items-center rounded-md px-2 py-1 text-xs max-md:pointer-coarse:h-9 max-md:pointer-coarse:px-3";

const STORAGE_KEY = "dotfiles:sidebar-section";

function storedSection(): SectionId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return SECTIONS.find((section) => section.id === stored)?.id ?? "files";
  } catch {
    return "files";
  }
}

function storeSection(id: SectionId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage can be unavailable; the choice then lasts only for this mount.
  }
}

/** The Dotfiles page's left sidebar: Files, Workflows, and Tasks behind one switcher. */
export function DotfilesSidebar(props: PluginNavPanelProps): ReactElement {
  const [section, setSection] = useState<SectionId>(storedSection);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex h-full min-h-0 flex-col">
        <nav
          aria-label="Dotfiles sections"
          className="sticky top-0 z-10 flex shrink-0 flex-wrap gap-1 border-b border-border bg-sidebar p-2"
        >
          {SECTIONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={section === id}
              className={
                section === id
                  ? `${SECTION_TAB_CLASS} bg-sidebar-accent font-medium text-foreground`
                  : `${SECTION_TAB_CLASS} text-muted-foreground hover:text-foreground`
              }
              onClick={() => {
                setSection(id);
                storeSection(id);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 flex-1 flex-col">
          {section === "tasks" ? (
            <TasksSection />
          ) : (
            <FilesSection {...props} workflows={section === "workflows"} />
          )}
        </div>
      </div>
    </QueryClientProvider>
  );
}
