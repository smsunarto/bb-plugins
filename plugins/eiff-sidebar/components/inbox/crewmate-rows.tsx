import { useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { StatusGlyph } from "@/components/inbox/status-glyph";
import { ProviderGlyph, type ProviderGlyphInfo } from "@/components/inbox/provider-glyph";
import { threadDisplayTitle } from "@/lib/inbox";
import { isThreadWorking } from "@/lib/lifecycle";

/**
 * A parent's crewmates, as thin indented rows under its card.
 *
 * These are bb CHILD THREADS, flattened to one indent level however deep the
 * spawning went: the sidebar is narrow, and a third level leaves nothing for
 * the title. Depth is the one thing this view gives up. Everything else about
 * a crewmate is here, and the family it belongs to reads as one block.
 *
 * A row is one line and carries only what the parent's card does not already
 * say. The project and the agent are repeated ONLY when the crewmate ran
 * somewhere other than where its parent did, which is the case where the
 * parent's own meta line would quietly mislead.
 *
 * Finished crewmates fold into a counted line. A thread that spawns eight
 * helpers should not cost eight rows for the rest of the day, and the ones
 * still running or holding a question are exactly the ones worth the space.
 */
export function CrewmateRows({
  parent,
  crewmates,
  activeThreadId,
  showProviderIcon,
  providerInfoById,
  projectNameById,
  onNavigate,
}: {
  parent: PluginSidebarThread;
  crewmates: readonly PluginSidebarThread[];
  activeThreadId: string | null;
  showProviderIcon: boolean;
  providerInfoById: ReadonlyMap<string, ProviderGlyphInfo>;
  projectNameById: ReadonlyMap<string, string>;
  onNavigate: () => void;
}) {
  const [showFinished, setShowFinished] = useState(false);

  if (crewmates.length === 0) return null;

  // Working or holding a question earns a row. Everything else is finished as
  // far as this list is concerned, whatever the thread went on to become.
  const live: PluginSidebarThread[] = [];
  const finished: PluginSidebarThread[] = [];
  for (const crewmate of crewmates) {
    const isLive = crewmate.hasPendingInteraction || isThreadWorking(crewmate);
    (isLive ? live : finished).push(crewmate);
  }

  const row = (crewmate: PluginSidebarThread) => (
    <CrewmateRow
      key={crewmate.id}
      crewmate={crewmate}
      parent={parent}
      isActive={crewmate.id === activeThreadId}
      showProviderIcon={showProviderIcon}
      provider={providerInfoById.get(crewmate.providerId)}
      projectName={projectNameById.get(crewmate.projectId) ?? null}
      onNavigate={onNavigate}
    />
  );

  return (
    <>
      {live.map(row)}
      {finished.length > 0 ? (
        <li className="list-none">
          <IndentRail>
            <button
              type="button"
              aria-expanded={showFinished}
              onClick={() => setShowFinished((open) => !open)}
              className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-2xs text-muted-foreground/70 hover:bg-sidebar-accent/60 hover:text-muted-foreground"
            >
              <Icon
                name={showFinished ? "ChevronDown" : "ChevronRight"}
                aria-hidden
                className="size-3 shrink-0"
              />
              <span className="truncate">
                {finished.length} finished
              </span>
            </button>
          </IndentRail>
        </li>
      ) : null}
      {showFinished ? finished.map(row) : null}
    </>
  );
}

function CrewmateRow({
  crewmate,
  parent,
  isActive,
  showProviderIcon,
  provider,
  projectName,
  onNavigate,
}: {
  crewmate: PluginSidebarThread;
  parent: PluginSidebarThread;
  isActive: boolean;
  showProviderIcon: boolean;
  provider?: ProviderGlyphInfo;
  projectName: string | null;
  onNavigate: () => void;
}) {
  const actions = useSidebarThreadActions();
  // Only what the parent's card does not already say.
  const elsewhere = crewmate.projectId !== parent.projectId;
  const otherAgent = crewmate.providerId !== parent.providerId;

  return (
    <li className="list-none">
      <IndentRail>
        <button
          type="button"
          // The card above owns the thread shortcut target for this family, so
          // these rows deliberately carry neither shortcut attribute: nine
          // keyboard shortcuts landing on a crewmate instead of its parent is
          // worse than not reaching crewmates by keyboard at all.
          onClick={(event) => {
            actions.open(crewmate.id, { split: event.metaKey || event.ctrlKey });
            onNavigate();
          }}
          className={cn(
            "flex h-5 min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
          )}
        >
          <span
            className={cn(
              "min-w-0 truncate text-xs",
              isActive ? "text-sidebar-accent-foreground" : "text-muted-foreground",
              crewmate.isUnread && "font-medium text-sidebar-foreground",
            )}
          >
            {threadDisplayTitle(crewmate)}
          </span>
          {elsewhere && projectName ? (
            <span className="shrink-0 truncate rounded bg-muted px-1 text-2xs text-muted-foreground/70">
              {projectName}
            </span>
          ) : null}
          {/* The glyph column, last, so every row in a family lines up on the
              right whatever it carries. */}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {showProviderIcon && otherAgent ? (
              <ProviderGlyph providerId={crewmate.providerId} provider={provider} />
            ) : null}
            <StatusGlyph
              indicator={crewmate.indicator}
              label={crewmate.indicatorLabel}
              className="size-3"
            />
          </span>
        </button>
      </IndentRail>
    </li>
  );
}

/**
 * The indent, drawn as a rule rather than as empty space.
 *
 * A family can sit next to another card of the same width, and indentation
 * alone at this scale reads as a slightly narrower row rather than as
 * belonging to something. The rule is what makes it a branch.
 */
function IndentRail({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-stretch pl-3.5 pr-2.5">
      <span aria-hidden className="mr-1.5 w-px shrink-0 bg-border" />
      {children}
    </div>
  );
}
