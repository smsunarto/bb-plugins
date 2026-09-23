import type { PluginSidebarThread, PluginSidebarThreadShortcut } from "@get-bb/plugin-sdk/app";
import { StatusGlyph, hasStatusGlyph } from "./status-glyph";
import { relativeTimeLabel } from "../../lib/relative-time";

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
  now,
  shortcut = null,
}: {
  thread: PluginSidebarThread;
  /** Quantized clock, shared by every row in one render. */
  now: number;
  /** bb's jump key for this row while the command modifier is held. */
  shortcut?: PluginSidebarThreadShortcut | null;
}) {
  if (shortcut) return <ShortcutPill shortcut={shortcut} />;
  if (hasStatusGlyph(thread.indicator)) {
    return <StatusGlyph indicator={thread.indicator} label={thread.indicatorLabel} />;
  }
  if (thread.isUnread) return <StatusGlyph indicator="unread-success" label="Unread response" />;
  return (
    <span className="tabular-nums text-2xs text-muted-foreground/40">
      {relativeTimeLabel(thread.latestAttentionAt, now)}
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
