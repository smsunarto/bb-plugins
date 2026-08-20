import { useState } from "react";
import {
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { RowContextMenu } from "@/components/inbox/row-context-menu";
import { TitleEditor } from "@/components/inbox/title-editor";
import { ProviderGlyph, type ProviderGlyphInfo } from "@/components/inbox/provider-glyph";
import { STATUS_SLOT_CLASS, StatusOrTime } from "@/components/inbox/status-slot";
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
  showProviderIcon,
  showHost,
  preview,
  finishedCount,
  finishedExpanded,
  onToggleFinished,
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
  /** The `showProviderIcon` setting, on by default. */
  showProviderIcon: boolean;
  /**
   * Whether the host is worth naming. False when every thread on screen runs
   * on the same machine, where the name is the same word on every card and
   * tells the user nothing they cannot already assume.
   */
  showHost: boolean;
  /**
   * The agent's latest message, already stripped to plain prose. Null while it
   * is still being fetched, and for a thread the agent has not spoken in yet.
   */
  preview: string | null;
  /** Crewmates folded away behind the count; 0 draws no control. */
  finishedCount: number;
  finishedExpanded: boolean;
  onToggleFinished: () => void;
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
  // The text the editor opens with, held apart from `isEditing` so a rename
  // the host refuses can reopen on what was typed rather than on the title
  // that is still there.
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const isEditing = draftTitle !== null;

  const startRename = () => setDraftTitle(threadDisplayTitle(thread));

  const commitRename = (nextTitle: string) => {
    setDraftTitle(null);
    const title = nextTitle.trim();
    // An empty field is a cancel, not a request for an empty title, and a
    // rename to the name it already has is a wasted round trip.
    if (!title || title === threadDisplayTitle(thread)) return;
    // bb's own rename, so the change lands on the thread itself and every
    // other surface showing it follows. A refusal reopens the editor holding
    // the text, which is the only signal this row has room to give.
    void actions.rename(thread.id, title).catch(() => setDraftTitle(title));
  };

  const trailing = (
    <>
            {thread.activity.workflows > 0 ? (
        <ActivityCount label="workflows" count={thread.activity.workflows} />
      ) : null}
      {thread.activity.backgroundAgents > 0 ? (
        <ActivityCount label="background agents" count={thread.activity.backgroundAgents} />
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
      {finishedCount > 0 ? (
        <FinishedCrewmates
          count={finishedCount}
          expanded={finishedExpanded}
          onToggle={onToggleFinished}
        />
      ) : null}
      {/* Drawn for every card or for none, never per thread, so the line
          keeps a fixed right edge whichever way the setting is set. */}
      {showProviderIcon ? (
        <ProviderGlyph providerId={thread.providerId} provider={provider} />
      ) : null}
    </>
  );

  return (
    <RowContextMenu thread={thread} onRename={startRename}>
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
            // The anchor is the full-bleed layer over the whole card, so it is
            // what a double-click actually reaches. The first click of the pair
            // has already opened the thread by the time this runs, which is the
            // right outcome anyway: you rename the thread you are now reading.
            onDoubleClick={(event) => {
              event.preventDefault();
              startRename();
            }}
            className={cn(
              "absolute inset-0 rounded-md",
              // Editing hands the row's clicks to the field. Left live, this
              // layer would sit over the input and swallow every one of them.
              isEditing ? "pointer-events-none" : "cursor-pointer",
            )}
          />
          <div className="pointer-events-none relative flex h-5 items-center gap-1.5">
            {isEditing ? (
              <TitleEditor
                initialTitle={draftTitle}
                onCommit={commitRename}
                onCancel={() => setDraftTitle(null)}
              />
            ) : (
              <span
                className={cn(
                  // Keep resting titles on the sidebar's own text ladder. The
                  // active row earns the brighter accent foreground, while weight
                  // alone still carries unread.
                  "min-w-0 flex-1 truncate text-sm",
                  isActive ? "text-sidebar-accent-foreground" : "text-sidebar-foreground",
                  thread.isUnread && "font-medium",
                )}
              >
                {threadDisplayTitle(thread)}
              </span>
            )}
            {/* Status at rest, park actions on hover. Only the status yields,
                so the title never shifts. Editing clears both: the field wants
                the width, and a park button under the pointer is one misclick
                away from filing the thread you were renaming. */}
            {canPark && !isEditing ? (
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
                <ParkButton label="Settle thread" icon="Check" onActivate={onSettle} />
              </span>
            ) : null}
            {isEditing ? null : (
              <span className={cn(STATUS_SLOT_CLASS, canPark && "group-hover/card:hidden")}>
                <StatusOrTime thread={thread} now={now} />
              </span>
            )}
          </div>
          {/* What the agent last said, in place of the metadata that used to
              live here. It is the only line on the card that changes while you
              watch, and it is why this sidebar is worth reading rather than
              scanning. Three lines once the thread is the one you are in, one
              line otherwise.

              A thread with nothing said yet falls back to the old project and
              origin line rather than leaving a blank row. */}
          {preview ? (
            <div className="pointer-events-none relative mt-1 flex items-start gap-1.5 text-2xs text-muted-foreground/70">
              <span
                className={cn(
                  "min-w-0 flex-1 overflow-hidden leading-snug",
                  isActive ? "line-clamp-3" : "line-clamp-1",
                )}
              >
                {preview}
              </span>
              {/* Collapsed, this line is the only one drawn, so it carries the
                  trailing column too. Expanded, the line below takes it back. */}
              {isActive ? null : <span className="flex shrink-0 items-center gap-1.5">{trailing}</span>}
            </div>
          ) : null}
          {/* One step below the title, not half a step: at 10px the size drop
              alone does not carry the hierarchy, so the line also starts at the
              tint the provider glyph already uses. Segments that rank below the
              project dim further from here.

              Now the second-class line: drawn for the thread you are in, where
              there is room to say where the work lives, and for a thread with
              no message yet, where it is all the card has. */}
          <div
            className={cn(
              "pointer-events-none relative mt-1 flex h-4 items-center gap-1.5 text-2xs text-muted-foreground/70",
              preview && !isActive && "hidden",
            )}
          >
            {/* Project and origin share this line now that the title has taken
                the one above. The project holds its full name and the origin
                yields: which repository a thread belongs to outranks which
                branch it sits on, and the branch is the one that grows without
                bound. The wrapper is the flexible cell either way, so a card
                missing both still holds the line's right side still. */}
            <span className="flex min-w-0 flex-1 items-center gap-1">
              {projectName ? <span className="min-w-0 truncate">{projectName}</span> : null}
              {projectName && (thread.environment?.branchName || (showHost && thread.host)) ? (
                <span aria-hidden className="shrink-0 text-muted-foreground/40">
                  ·
                </span>
              ) : null}
              {/* Weighted rather than capped, so the project keeps its full
                  name whenever the line has room for both and only starts
                  truncating once this one has already given up everything. A
                  fixed cap on the project instead truncates it while slack
                  sits unused beside a short branch. Never `flex-1` either: a
                  branch that GREW would take that slack off the project.
                  Overflowing beyond zero is left alone — the project is
                  truncating by then, so this segment has nothing to show.

                  A thread without a worktree still runs somewhere, so the
                  machine takes the branch's place rather than leaving the
                  segment blank. */}
              {thread.environment?.branchName ? (
                <span className="min-w-0 shrink-[9999] truncate font-mono text-muted-foreground/50">
                  {thread.environment.branchName}
                </span>
              ) : showHost && thread.host ? (
                <span className="min-w-0 shrink-[9999] truncate text-muted-foreground/50">
                  {thread.host.name}
                </span>
              ) : null}
            </span>
            {trailing}
          </div>
      </div>
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

/**
 * The crewmates that have finished, as a count on the parent rather than a row
 * of its own.
 *
 * A row per fold cost every family with history a third line, which left the
 * list with no repeating height for the eye to lock onto. Here it costs the
 * width of two characters on a line that already exists.
 */
function FinishedCrewmates({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${count} finished crewmates`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "pointer-events-auto relative flex shrink-0 items-center gap-0.5 rounded px-0.5",
        "text-2xs text-muted-foreground/70 hover:bg-sidebar-accent hover:text-foreground",
      )}
    >
      <Icon
        name={expanded ? "ChevronDown" : "ChevronRight"}
        aria-hidden
        className="size-2.5 shrink-0"
      />
      {count}
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
