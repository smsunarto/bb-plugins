/**
 * bb's search fields drawn as the shadcn Input from @bb-plugins/ui
 * (packages/ui/src/controls.css): 36px, a hairline --input edge, --radius-md
 * corners, the theme's --control-background fill (shadcn's dark bg-input/30),
 * --text-sm, and a 1px --ring on keyboard focus.
 * Phones get 44px, the repo's touch minimum, and 16px text so iOS does not
 * zoom. Applies under every palette, from the `bb-dom-styles` content script.
 *
 * bb's DOM (private contract; recheck after bb upgrades):
 * - input[aria-label^="Search"]: bb's Input in the New tab, settings, thread
 *   storage, and model picker. The repo's own Input carries data-bb-control and
 *   already looks like this, so it is skipped.
 * - [cmdk-input-wrapper]: the picker search row (Command). shadcn draws it as
 *   a bottom-bordered row; here the row becomes the field, inset in its popover,
 *   and the cmdk input inside stays bare.
 * - [data-palette-input-frame]: the command palette and thread search. The
 *   frame becomes the field; its input stays bare.
 * - label > input[aria-label^="Search"]: a search row that wraps its icon and
 *   input in a label, such as Settings' sidebar search. The label becomes the
 *   field (a child-only :has(), checked against the label alone).
 *
 * Plugin DOM, inside any `[data-bb-plugin]` root or portal, is left alone:
 * plugins draw their own search fields, such as t3-composer's model search.
 */
const NOT_PLUGIN = "[data-bb-plugin] *";
/** bb's search input, not the repo's Input, a cmdk input, or plugin DOM. */
const BB_SEARCH_INPUT = `input[aria-label^="Search"]:not([data-bb-control], [cmdk-input], ${NOT_PLUGIN})`;
const LABEL_FIELD = `label:has(> input[aria-label^="Search"]:not([data-bb-control])):not(${NOT_PLUGIN})`;
const CMDK_FIELD = `[cmdk-input-wrapper]:not(${NOT_PLUGIN})`;
const PALETTE_FIELD = "[data-palette-input-frame]";
const FIELDS = [BB_SEARCH_INPUT, LABEL_FIELD, CMDK_FIELD, PALETTE_FIELD];
const list = (selectors: string[]) => selectors.join(",\n");

export const SEARCH_FIELDS_CSS = `
${list(FIELDS)} {
  height: 2.25rem;
  border: var(--hairline-width, 1px) solid var(--input);
  border-radius: var(--radius-md, 0.375rem);
  background: var(--control-background, transparent);
  font-size: var(--text-sm, 0.8125rem);
}
${list([
  `${BB_SEARCH_INPUT}:focus-visible`,
  `${LABEL_FIELD}:focus-within`,
  `${CMDK_FIELD}:focus-within`,
  `${PALETTE_FIELD}:focus-within`,
])} {
  outline: none;
  box-shadow: 0 0 0 1px var(--ring);
}
${CMDK_FIELD} {
  margin: 0.5rem 0.5rem 0.25rem;
  padding-inline: 0.75rem;
}
${list([LABEL_FIELD, PALETTE_FIELD])} {
  padding-inline: 0.75rem;
}
[data-palette-input-band] {
  border-bottom-color: transparent;
  padding-block: 0.5rem;
}
/* More specific than the field rules, so the bare inner inputs win. */
${list([
  `${CMDK_FIELD} > input`,
  `${LABEL_FIELD} > ${BB_SEARCH_INPUT}`,
  `${LABEL_FIELD} > ${BB_SEARCH_INPUT}:focus-visible`,
  `${PALETTE_FIELD} input:not([data-bb-control], [cmdk-input])`,
  `${PALETTE_FIELD} input:not([data-bb-control], [cmdk-input]):focus-visible`,
  `${PALETTE_FIELD} input[cmdk-input]`,
])} {
  height: 100%;
  padding-block: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  font-size: inherit;
}
@media (width < 48rem) and (pointer: coarse) {
  ${list(FIELDS)} {
    height: 2.75rem;
    font-size: var(--text-base, 1rem);
  }
}
`;
