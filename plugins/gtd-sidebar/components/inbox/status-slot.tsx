import {
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  useSidebarThreadRowStatus,
  type PluginSidebarThread,
  type PluginSidebarThreadRowStatus,
  type PluginSidebarThreadShortcut,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { relativeTimeLabel } from "../../lib/relative-time";
import { useMinuteClock } from "../../hooks/use-minute-clock";

/**
 * The row's trailing slot: fixed width and right-aligned by default.
 *
 * Fixed rather than intrinsic because the age label's width follows its text —
 * "now" is wider than "7m" — and an intrinsic slot drags whatever sits beside
 * it back and forth, so no two rows agree on a column. The width holds the
 * widest label this sidebar can produce ("now", "59m", "52w"). PR rows
 * override the width to fit the content, keeping the chip 10px from the
 * time or glyph even as that content changes width.
 */
export const STATUS_SLOT_CLASS = "flex w-7 shrink-0 items-center justify-end";

/**
 * The box every trailing glyph sits in, whatever its artwork measures.
 *
 * The status glyph and the provider glyph end a line at
 * the same inset, but they are drawn at different sizes. A shared box centres
 * each one on the same vertical axis, so right-aligning the boxes lines the
 * icons up instead of leaving them one or two pixels apart.
 */
export const TRAILING_GLYPH_BOX_CLASS = "flex size-3.5 shrink-0 items-center justify-center";

/**
 * Status OR age, never both: the glyph already implies the row is current, and
 * the age only earns its place once the thread has nothing to say.
 *
 * The glyph is bb's own, so the two lists in one window share one vocabulary,
 * and a status another plugin sets on the row (drafts, workflows) shows here
 * as it does in bb's list; the glyph applies bb's rule for which of the two
 * wins. `thread.indicator` is already resolved through bb's precedence, so
 * this does not re-resolve it.
 */
export function StatusOrTime({
  thread,
  isUnread = thread.isUnread,
  shortcut = null,
  isCompactViewport = false,
}: {
  thread: PluginSidebarThread;
  /** Includes unread descendants while the family is collapsed. */
  isUnread?: boolean;
  /** bb's jump key for this row while the command modifier is held. */
  shortcut?: PluginSidebarThreadShortcut | null;
  /** A phone, where the age has to read at arm's length. */
  isCompactViewport?: boolean;
}) {
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  if (shortcut) return <ShortcutPill shortcut={shortcut} />;
  if (drawsStatusGlyph(thread, rowStatus)) {
    return <ThreadStatusGlyph indicator={thread.indicator} rowStatus={rowStatus} size="compact" />;
  }
  if (isUnread) return <ThreadStatusGlyph indicator="unread-success" size="compact" />;
  return <AgeLabel at={thread.latestAttentionAt} isCompactViewport={isCompactViewport} />;
}

/**
 * Whether a glyph other than the unread dot speaks for the row. The dot alone
 * leaves the slot to the unread rule, so a collapsed family's unread
 * descendants still draw it. "none" is the only kind without a glyph: bb's
 * glyph draws any kind bb reports, including ones newer than this plugin.
 */
function drawsStatusGlyph(
  thread: PluginSidebarThread,
  rowStatus: PluginSidebarThreadRowStatus | null,
): boolean {
  return (
    rowStatus !== null || (thread.indicator !== "none" && thread.indicator !== "unread-success")
  );
}

/**
 * The ids a row's link names as its description, so a screen reader hears the
 * row's status, age or wake time after its title, and "Unread response" once.
 * Where the slot draws the unread dot, the row's unread note stands in for it:
 * the note says the same, or says the unread work sits in collapsed subthreads.
 */
export function useRowDescribedBy(
  statusId: string,
  unreadId: string,
  {
    thread,
    isUnread,
    shortcut,
  }: {
    /** The thread the slot draws: a collapsed family's loudest member. */
    thread: PluginSidebarThread;
    /** Includes unread descendants while the family is collapsed. */
    isUnread: boolean;
    shortcut: PluginSidebarThreadShortcut | null;
  },
): string {
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  if (!isUnread) return statusId;
  const slotDrawsDot = shortcut === null && !drawsStatusGlyph(thread, rowStatus);
  return slotDrawsDot ? unreadId : `${statusId} ${unreadId}`;
}

/**
 * Reads the minute clock itself, so a tick re-renders the ages, not the rows.
 * A phone lifts the age to the readback tier: on a settled row it is the only
 * signal left, and the desktop's ghost tint is too faint to read there.
 */
function AgeLabel({ at, isCompactViewport }: { at: number; isCompactViewport: boolean }) {
  const now = useMinuteClock();
  return (
    <span
      className={cn(
        "tabular-nums text-2xs",
        isCompactViewport ? "text-readback-foreground" : "text-muted-foreground/40",
      )}
    >
      {relativeTimeLabel(at, now)}
    </span>
  );
}

/**
 * The jump key bb assigned to the row, drawn in the trailing slot while the
 * command modifier is held. It takes the status slot rather than adding a
 * column: the key is only there for the moment the user is about to press it,
 * and bb's own row swaps its trailing cell the same way.
 */
export function ShortcutPill({ shortcut }: { shortcut: PluginSidebarThreadShortcut }) {
  return (
    <kbd
      aria-hidden
      className="pointer-events-none inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm bg-sidebar-accent px-1 py-0.5 font-sans text-2xs font-normal leading-none tabular-nums text-muted-foreground"
    >
      {shortcut.label}
    </kbd>
  );
}
