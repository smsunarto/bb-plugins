import type { PluginSidebarThread, PluginSidebarThreadShortcut } from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { StatusGlyph, hasStatusGlyph } from "./status-glyph";
import { relativeTimeLabel } from "../../lib/relative-time";
import { useMinuteClock } from "../../hooks/use-minute-clock";

/**
 * The row's trailing slot: one fixed width, right-aligned, on every row.
 *
 * Fixed rather than intrinsic because the age label's width follows its text —
 * "now" is wider than "7m" — and an intrinsic slot drags whatever sits beside
 * it back and forth, so no two rows agree on a column. The width holds the
 * widest label this sidebar can produce ("now", "59m", "52w").
 */
export const STATUS_SLOT_CLASS = "flex w-7 shrink-0 items-center justify-end";

/**
 * The box every trailing glyph sits in, whatever its artwork measures.
 *
 * The status glyph, the provider glyph and a shelf's chevron all end a line at
 * the same inset, but they are drawn at different sizes. A shared box centres
 * each one on the same vertical axis, so right-aligning the boxes lines the
 * icons up instead of leaving them one or two pixels apart.
 */
export const TRAILING_GLYPH_BOX_CLASS = "flex size-3.5 shrink-0 items-center justify-center";

/**
 * Status OR age, never both: the glyph already implies the row is current, and
 * the age only earns its place once the thread has nothing to say.
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
  if (shortcut) return <ShortcutPill shortcut={shortcut} />;
  if (drawsStatusGlyph(thread)) {
    return <StatusGlyph indicator={thread.indicator} label={thread.indicatorLabel} />;
  }
  if (isUnread) return <StatusGlyph indicator="unread-success" label="Unread response" />;
  return <AgeLabel at={thread.latestAttentionAt} isCompactViewport={isCompactViewport} />;
}

/** The thread's own status glyph outranks the unread dot in the slot. */
function drawsStatusGlyph(thread: PluginSidebarThread): boolean {
  return thread.indicator !== "unread-success" && hasStatusGlyph(thread.indicator);
}

/**
 * The ids a row's link names as its description, so a screen reader hears the
 * row's status, age or wake time after its title, and "Unread response" once.
 * Where the slot draws the unread dot, the row's unread note stands in for it:
 * the note says the same, or says the unread work sits in collapsed subthreads.
 */
export function rowDescribedBy(
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
  if (!isUnread) return statusId;
  const slotDrawsDot = shortcut === null && !drawsStatusGlyph(thread);
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
