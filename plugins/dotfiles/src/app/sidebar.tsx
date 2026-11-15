import { useState } from "react";
import type { ReactElement } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { QueryClientProvider } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FilesSection } from "./files-section.tsx";
import { queryClient } from "./query.ts";
import { TasksSection } from "./tasks-section.tsx";

const SECTIONS = [
  { id: "files", label: "Files" },
  { id: "workflows", label: "Workflows" },
  { id: "tasks", label: "Tasks" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

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
      <TooltipProvider delayDuration={200}>
        <Tabs
          value={section}
          onValueChange={(value) => {
            const id = SECTIONS.find((candidate) => candidate.id === value)?.id;
            if (id === undefined) return;
            setSection(id);
            storeSection(id);
          }}
          className="flex h-full min-h-0 flex-col"
        >
          <div className="sticky top-0 z-10 shrink-0 border-b border-border bg-sidebar p-2">
            <TabsList aria-label="Dotfiles sections" className="h-auto max-w-full flex-wrap">
              {SECTIONS.map(({ id, label }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="px-2 py-1 text-xs max-md:pointer-coarse:h-9 max-md:pointer-coarse:px-3"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value={section} className="mt-0 flex min-h-0 flex-1 flex-col">
            {section === "tasks" ? (
              <TasksSection />
            ) : (
              <FilesSection {...props} workflows={section === "workflows"} />
            )}
          </TabsContent>
        </Tabs>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
