import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { StatusGlyph } from "@/components/inbox/status-glyph";
import { ProviderGlyph, type ProviderGlyphInfo } from "@/components/inbox/provider-glyph";
import { threadDisplayTitle } from "@/lib/inbox";
import { isThreadWorking } from "@/lib/lifecycle";

/**
 * Whether a crewmate has earned a row of its own.
 *
 * Working or holding a question earns one. Everything else is finished as far
 * as this list is concerned, whatever the thread went on to become, and lives
 * behind the count on its parent's card until the user asks for it.
 */
export function isCrewmateLive(crewmate: PluginSidebarThread): boolean {
  return crewmate.hasPendingInteraction || isThreadWorking(crewmate);
}

/** Split crewmates into the ones that draw a row and the ones that fold away. */
export function splitCrewmates(crewmates: readonly PluginSidebarThread[]): {
  live: PluginSidebarThread[];
  finished: PluginSidebarThread[];
} {
  const live: PluginSidebarThread[] = [];
  const finished: PluginSidebarThread[] = [];
  for (const crewmate of crewmates) (isCrewmateLive(crewmate) ? live : finished).push(crewmate);
  return { live, finished };
}

/**
 * One crewmate, as a thin indented row under its parent's card.
 *
 * These are bb CHILD THREADS, flattened to one indent level however deep the
 * spawning went: the sidebar is narrow, and a third level leaves nothing for
 * the title. Depth is the one thing this view gives up.
 *
 * The row carries only what the parent's card does not already say. The
 * project and the agent are repeated ONLY when the crewmate ran somewhere
 * other than where its parent did, which is the case where the parent's own
 * meta line would quietly mislead.
 */
export function CrewmateRow({
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
  const elsewhere = crewmate.projectId !== parent.projectId;
  const otherAgent = crewmate.providerId !== parent.providerId;

  return (
    <div className="flex items-stretch pl-3.5 pr-2.5">
      {/* The indent, drawn as a rule rather than as empty space: indentation
          alone at this scale reads as a slightly narrower row rather than as
          belonging to something. The rule is what makes it a branch. */}
      <span aria-hidden className="mr-1.5 w-px shrink-0 bg-border" />
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
    </div>
  );
}
