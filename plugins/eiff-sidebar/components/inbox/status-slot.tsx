import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { StatusGlyph, hasStatusGlyph } from "@/components/inbox/status-glyph";
import { relativeTimeLabel } from "@/lib/relative-time";
import { elapsedLabel } from "@/lib/elapsed";
import { isThreadWorking } from "@/lib/lifecycle";

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
 *
 * A thread that is WORKING gets a third thing: a clock counting up from its
 * last change. A spinner says only that something is happening, which the row
 * says already; the count is what separates a step that started a moment ago
 * from one that has been stuck for four minutes. The failure and raised-hand
 * glyphs still win outright, because those need answering whatever the clock
 * reads.
 */
export function StatusOrTime({
  thread,
  now,
}: {
  thread: PluginSidebarThread;
  /** Quantized clock, shared by every row in one render. */
  now: number;
}) {
  // Working beats every glyph that only means "working" — the spinner, the
  // workflow mark, the background-agent mark. It does NOT beat a failure or a
  // raised hand: those need answering whatever the clock reads, and a thread
  // can be blocked on the user while background work is still live.
  if (isThreadWorking(thread) && !thread.hasPendingInteraction && thread.indicator !== "unread-error") {
    return (
      <span
        aria-label={thread.indicatorLabel ?? "Working"}
        className="tabular-nums text-2xs text-accent-foreground/70"
      >
        {elapsedLabel(thread.updatedAt, now)}
      </span>
    );
  }
  if (hasStatusGlyph(thread.indicator)) {
    return <StatusGlyph indicator={thread.indicator} label={thread.indicatorLabel} />;
  }
  return (
    <span className="tabular-nums text-2xs text-muted-foreground">
      {relativeTimeLabel(thread.updatedAt, now)}
    </span>
  );
}
