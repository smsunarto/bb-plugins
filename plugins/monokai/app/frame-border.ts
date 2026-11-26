/**
 * Removes bb's framed main-frame border, title-bar seam, and 1px border
 * reservations under every palette, so desktop framed windows stay borderless
 * with no leftover seam or rim in default dark, default light, and bb Monokai.
 * The `bb-dom-styles` content script appends these rules.
 *
 * bb's DOM (private contract; recheck after bb upgrades):
 * - [data-framed] [data-sidebar="inset-edge"]: pointer-events-none border
 *   overlay rendered by SidebarInset (`apps/app/src/components/ui/sidebar.tsx:60-61, 1752-1761`).
 * - [data-framed] [data-sidebar="inset"]::after: 1px vertical title-bar border
 *   stub rendered while the left sidebar is expanded (`sidebar.tsx:62-63, 1745`).
 * - [data-framed] [data-sidebar="inset"]: reserves 1px (`px-px pb-px`) behind
 *   `inset-edge` over its full-bleed `--background` `::before` (`sidebar.tsx:58-59, 1744`).
 * - [data-framed] [data-sidebar="inset"] aside[data-surface-tone="sidebar"]::before:
 *   starts `1px` below `--bb-window-title-bar-height` for `inset-edge`'s top edge
 *   (`apps/app/src/components/secondary-panel/ThreadSecondaryPanel.tsx:132-133, 968`).
 */
export const FRAME_BORDER_CSS = `
[data-framed] [data-sidebar="inset-edge"],
[data-framed] [data-sidebar="inset"]::after {
  display: none;
}
[data-framed] [data-sidebar="inset"] {
  padding-inline: 0;
  padding-bottom: 0;
}
[data-framed] [data-sidebar="inset"] aside[data-surface-tone="sidebar"]::before {
  top: var(--bb-window-title-bar-height);
}
`;
