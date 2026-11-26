/**
 * Removes bb's framed main-frame border under every palette, so desktop framed
 * windows stay borderless in default dark and light themes as well as bb
 * Monokai. The `bb-dom-styles` content script appends this rule.
 *
 * bb's DOM (private contract; recheck after bb upgrades):
 * - [data-framed] [data-sidebar="inset-edge"]: pointer-events-none border
 *   overlay rendered by SidebarInset (`apps/app/src/components/ui/sidebar.tsx`).
 */
export const FRAME_BORDER_CSS = `
[data-framed] [data-sidebar="inset-edge"] {
  display: none;
}
`;
