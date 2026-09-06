# Smooth Thread Switch

Keeps the outgoing conversation visible while bb restores the next thread's
scroll position and lays out its rows. Then it swaps directly to the settled
view, without a fade or overlapping text.

## Layout stability

A new conversation stays invisible until its scroll position, viewport height,
and rendered row rectangles have stopped changing for 84ms. Checking row
rectangles catches width changes and internal reflows even when the total
scroll height remains unchanged. Measuring elapsed time makes this interval
independent of the display refresh rate.

84ms is the selected quiet interval, down from 120ms. Browser measurements
covered 390px mobile and 1728px desktop, including main-thread contention.
Shorter 34ms and 67ms candidates passed trace replays but exposed later layout
changes in live checks. The live workload included an active thread, so those
changes can also include new output. Final verification separately checks
non-streaming threads. This is a tested compromise, not a proven universal
minimum or a guarantee against arbitrary asynchronous content.

The hold lasts at most 800ms so a continuously streaming thread or a view
restored to the very top remains usable. Content arriving after that deadline
can still move. This plugin masks initial layout adjustments. It does not
change bb's scroll restoration or reserve space for future asynchronous embeds.

## Lifecycle

The content script tracks bb's `data-timeline-row-list="top-level"` elements.
When bb detaches an outgoing scroll area, the script retains it as an inert,
aria-hidden overlay at its previous position. It strips row, footer, and ID
attributes so bb cannot mistake it for live content, and blanks iframes to
avoid reloading their documents.

The incoming list keeps its normal layout and scroll observers while hidden.
Once stable, it becomes visible and the overlay is removed in the same frame.
The behavior is the same with reduced motion enabled because it has no fade.

An overlay without a replacement expires after 800ms. All overlays expire
within 1.2 seconds. Navigating away from threads removes them immediately.
Reloading or disabling the plugin removes all holds, overlays, and observers.
Already visible streaming rows are left alone.

The plugin has no settings or CLI commands.
