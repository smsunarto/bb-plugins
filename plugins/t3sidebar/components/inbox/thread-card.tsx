import {
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { RowContextMenu } from "@/components/inbox/row-context-menu";
import {
  ProviderGlyph,
  type ProviderGlyphInfo,
} from "@/components/inbox/provider-glyph";
import {
  STATUS_SLOT_CLASS,
  StatusOrTime,
} from "@/components/inbox/status-slot";
import { threadDisplayTitle } from "@/lib/inbox";
import { resolveSnoozePresets } from "@/lib/lifecycle";

/**
 * One thread as a two-line card: title and status, then project, branch and
 * activity. Status stays in the row while section placement answers the larger
 * question: whether the user or the agent can act next.
 *
 * The row is a positioned container with a full-bleed anchor UNDER the
 * controls, the way bb's own thread row does it: a `<button>` inside an `<a>`
 * is invalid interactive nesting and breaks keyboard behaviour.
 */
export function ThreadCard({
  thread,
  provider,
  projectName,
  isActive,
  canPark,
  onNavigate,
  onSettle,
  onSnooze,
  now,
}: {
  thread: PluginSidebarThread;
  provider?: ProviderGlyphInfo;
  projectName: string | null;
  isActive: boolean;
  /** False while the thread is working or blocked on the user. */
  canPark: boolean;
  onNavigate: () => void;
  onSettle: () => void;
  onSnooze: (snoozedUntil: number) => void;
  /** Quantized clock, so every card in one render agrees on "now". */
  now: number;
}) {
  const actions = useSidebarThreadActions();
  const { splitProps, layout } = useSidebarThreadSplit(thread.id);
  // Opt-in per row: this costs a git-host lookup, and threads sharing a
  // worktree share one.
  const { pullRequest } = useSidebarThreadPullRequest(thread.id);

  return (
    <RowContextMenu thread={thread}>
      <li className="list-none">
        <div
          className={cn(
            "group/card relative rounded-md px-2.5 py-1.5 transition-colors",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            // A thread open in another pane gets a weaker tint than the active
            // row, so the two states stay distinguishable.
            !isActive && layout !== null && "bg-sidebar-accent/30",
          )}
        >
          {/* oxlint-disable-next-line jsx-a11y/anchor-is-valid -- must stay an
              anchor: the shortcut-target contract below and modifier-click
              split-open both depend on it. A button breaks each. */}
          <a
            // Both attributes, or bb's nine thread shortcuts stop finding rows.
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href="#"
            aria-label={threadDisplayTitle(thread)}
            {...splitProps}
            onClick={(event) => {
              event.preventDefault();
              actions.open(thread.id, {
                split: event.metaKey || event.ctrlKey,
              });
              onNavigate();
            }}
            className="absolute inset-0 cursor-pointer rounded-md"
          />
          <div className="pointer-events-none relative flex h-5 items-center gap-1.5">
            <span
              className={cn(
                // Keep resting titles on the sidebar's own text ladder. The
                // active row earns the brighter accent foreground, while weight
                // alone still carries unread.
                "min-w-0 flex-1 truncate text-sm",
                isActive
                  ? "text-sidebar-accent-foreground"
                  : "text-sidebar-foreground",
                thread.isUnread && "font-medium",
              )}
            >
              {threadDisplayTitle(thread)}
            </span>
            {/* Status at rest, park actions on hover. Only the status yields,
                so the title never shifts. */}
            {canPark ? (
              <span className="pointer-events-auto hidden items-center gap-0.5 group-hover/card:flex">
                <ParkButton
                  label="Snooze until tomorrow"
                  icon="Clock"
                  onActivate={() => {
                    // By id, never by index: "This evening" drops out of the
                    // list once 18:00 is under an hour away, so a positional
                    // pick silently becomes "Next week" every afternoon.
                    const presets = resolveSnoozePresets(new Date());
                    const tomorrow = presets.find((p) => p.id === "tomorrow");
                    if (tomorrow) onSnooze(tomorrow.snoozedUntil);
                  }}
                />
                <ParkButton
                  label="Settle thread"
                  icon="Check"
                  onActivate={onSettle}
                />
              </span>
            ) : null}
            <span
              className={cn(
                STATUS_SLOT_CLASS,
                canPark && "group-hover/card:hidden",
              )}
            >
              <StatusOrTime thread={thread} now={now} />
            </span>
          </div>
          {/* One step below the title, not half a step: at 10px the size drop
              alone does not carry the hierarchy, so the whole line also sits at
              the tint the provider glyph already uses. */}
          <div className="pointer-events-none relative mt-1 flex h-4 items-center gap-1.5 text-2xs text-muted-foreground/70">
            {/* Project and origin share this line now that the title has taken
                the one above. Both truncate, so a long branch squeezes the
                project rather than pushing the fixed trailing columns off
                their edge. The wrapper is the flexible cell either way, so a
                card missing both still holds the line's right side still. */}
            <span className="flex min-w-0 flex-1 items-center gap-1">
              {projectName ? (
                <span className="min-w-0 truncate">{projectName}</span>
              ) : null}
              {projectName && (thread.environment?.branchName || thread.host) ? (
                <span aria-hidden className="shrink-0 text-muted-foreground/50">
                  ·
                </span>
              ) : null}
              {/* A thread without a worktree still runs somewhere, so the
                  machine takes the branch's place rather than leaving the
                  segment blank. */}
              {thread.environment?.branchName ? (
                <span className="min-w-0 truncate font-mono">
                  {thread.environment.branchName}
                </span>
              ) : thread.host ? (
                <span className="min-w-0 truncate">{thread.host.name}</span>
              ) : null}
            </span>
            {thread.activity.workflows > 0 ? (
              <ActivityCount
                label="workflows"
                count={thread.activity.workflows}
              />
            ) : null}
            {thread.activity.backgroundAgents > 0 ? (
              <ActivityCount
                label="background agents"
                count={thread.activity.backgroundAgents}
              />
            ) : null}
            {pullRequest ? (
              <a
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
                title={pullRequest.title}
                className={cn(
                  "relative shrink-0 font-mono hover:underline",
                  pullRequest.state === "merged"
                    ? "text-[color:var(--pr-merged)]"
                    : pullRequest.attention === "checks_failed" ||
                        pullRequest.attention === "conflicts"
                      ? "text-destructive-text"
                      : pullRequest.attention === "ready_to_merge"
                        ? "text-success-foreground"
                        : "text-muted-foreground",
                )}
              >
                #{pullRequest.number}
              </a>
            ) : null}
            {/* Always drawn, so the line has a fixed right edge. */}
            <ProviderGlyph providerId={thread.providerId} provider={provider} />
          </div>
        </div>
      </li>
    </RowContextMenu>
  );
}

function ParkButton({
  label,
  icon,
  onActivate,
}: {
  label: string;
  icon: Extract<IconName, "Clock" | "Check">;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      }}
      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

function ActivityCount({ label, count }: { label: string; count: number }) {
  return (
    <span
      aria-label={`${count} ${label}`}
      className="shrink-0 rounded bg-muted px-1 font-mono text-2xs text-muted-foreground/70"
    >
      {count}
    </span>
  );
}
