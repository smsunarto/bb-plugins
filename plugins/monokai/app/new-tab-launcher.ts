/**
 * The right panel's new tab, under every theme: the search stays at the top,
 * and the Actions sit centred in the panel below it as shadcn outline buttons.
 * The `bb-dom-styles` content script appends these rules.
 *
 * bb's DOM (private contract; recheck after bb upgrades):
 * [data-panel-new-tab-page] > div            the launcher column
 *   > div                                    search (absent without file search)
 *   > [data-testid="new-tab-actions"] > section
 *       > div                                "Actions" header (hidden)
 *       > div                                the list
 *           > div                            a row, or with 2+ actions a
 *               > div                        sortable wrapper around the row
 *                   > button[data-panel-new-tab-item] > span (icon), span (label)
 *                   > button[aria-roledescription="sortable"] (hidden)
 *   > div                                    Recent (hidden), or search results
 *
 * bb renders the Actions only while the query is empty, so the sibling after
 * them is always Recent; search results follow the search directly. Hiding the
 * reorder handle removes drag-to-reorder; a stored order still applies.
 */
export const NEW_TAB_LAUNCHER_CSS = `
[data-panel-new-tab-page] > div {
  flex: 1 0 auto;
  width: 100%;
  max-width: 34rem;
  margin-inline: auto;
  /* Optical centre: the space reserved below lifts the Actions above the
   * panel's geometric middle, less on short panels. */
  padding-bottom: min(12vh, 8rem);
}
[data-panel-new-tab-page] [data-testid="new-tab-actions"] {
  margin-block: auto;
}
[data-testid="new-tab-actions"] + div,
[data-testid="new-tab-actions"] > section > div:first-child,
[data-testid="new-tab-actions"] button[aria-roledescription="sortable"] {
  display: none;
}
[data-testid="new-tab-actions"] > section > div:nth-child(2) {
  gap: 0.5rem;
}
/* Each action is a shadcn outline Button (packages/ui/src/controls.css): a
 * hairline --input edge, --radius-md corners, the --control-background fill,
 * --state-hover on hover (bb's row paints it), --text-sm medium. Content stays
 * left-aligned, since rows carry bb's shortcut hint and trailing controls. The
 * edge is an inset outline, not a border: it takes no layout, so the card is
 * exactly the row's height, and it paints over the row's hover fill. */
[data-testid="new-tab-actions"] > section > div:nth-child(2) > div {
  outline: var(--hairline-width, 1px) solid var(--input);
  outline-offset: calc(-1 * var(--hairline-width, 1px));
  border-radius: var(--radius-md, 0.375rem);
  background: var(--control-background, transparent);
}
[data-testid="new-tab-actions"] > section > div:nth-child(2) > div > div {
  border-radius: inherit;
}
/* A 24px button inside the row's 6px padding: the Button's 36px; 44px on a
 * phone. The button's own inline padding brings the row's to the Button's 1rem. */
[data-testid="new-tab-actions"] button[data-panel-new-tab-item] {
  min-height: 1.5rem;
  gap: 0.5rem;
  padding-inline: 0.5rem;
}
@media (width < 48rem) and (pointer: coarse) {
  [data-testid="new-tab-actions"] button[data-panel-new-tab-item] {
    min-height: 2rem;
  }
}
[data-testid="new-tab-actions"] button[data-panel-new-tab-item] > span:first-child {
  color: var(--foreground);
}
/* line-height 1 centres the cap height in the row for Inter and SF Pro; bb's
 * 16px line box left labels 1.5px high. The padding, cancelled by the margin,
 * keeps descenders clear of the label's truncation clip. */
[data-testid="new-tab-actions"] button[data-panel-new-tab-item] > span:nth-child(2) {
  margin-block: -0.2em;
  padding-block: 0.2em;
  font-size: var(--text-sm, 0.8125rem);
  font-weight: 500;
  line-height: 1;
}
/* Drop bb's "Start" prefix. The labels are bb's text, so the original is
 * hidden and the short label drawn in its place; the button's title and
 * accessible name keep bb's wording. Keyed on bb's action ids. */
#file-search-result-start-terminal > span:nth-child(2),
button[id="plugin-action:side-chat:side-chat"] > span:nth-child(2) {
  position: relative;
  visibility: hidden;
}
#file-search-result-start-terminal > span:nth-child(2)::after,
button[id="plugin-action:side-chat:side-chat"] > span:nth-child(2)::after {
  position: absolute;
  inset-inline-start: 0;
  visibility: visible;
}
#file-search-result-start-terminal > span:nth-child(2)::after {
  content: "Terminal";
}
button[id="plugin-action:side-chat:side-chat"] > span:nth-child(2)::after {
  content: "Side chat";
}
`;
