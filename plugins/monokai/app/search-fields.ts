/**
 * bb's search fields drawn as the shadcn Input from @bb-plugins/ui
 * (packages/ui/src/controls.css): 36px, a hairline --input edge, --radius-md
 * corners, the theme's --control-background fill (shadcn's dark bg-input/30),
 * --text-sm, 10px inline padding, and Vega's keyboard focus: a 3px band of --ring
 * at half strength inside the --input edge, drawn inset like every Monokai focus
 * ring so an overflow-hidden ancestor cannot clip it.
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
 *   field. The selector-cost test allows this child-only :has() on labels:
 *   it avoids a page observer and only rechecks labels with a direct input.
 *
 * The rules reach plugin roots too, since bb's own pickers (its shared model
 * picker, the branch picker, built-in plugins) render inside them. A plugin
 * field drawn its own way opts out by marker: t3-composer's model search
 * (`data-t3-model-search`) keeps its underline row.
 */
/** Fields that already look as they should: the repo's Input, t3's model search. */
const OWN_FIELD = "[data-bb-control], [data-t3-model-search]";
/** bb's search input, not a field with its own look or a cmdk input. */
const BB_SEARCH_INPUT = `input[aria-label^="Search"]:not(${OWN_FIELD}, [cmdk-input])`;
const LABEL_FIELD = `label:has(> input[aria-label^="Search"]:not(${OWN_FIELD}))`;
const CMDK_FIELD = "[cmdk-input-wrapper]";
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
  box-shadow: inset 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}
${CMDK_FIELD} {
  margin: 0.5rem 0.5rem 0.25rem;
  padding-inline: 0.625rem;
}
${list([LABEL_FIELD, PALETTE_FIELD])} {
  padding-inline: 0.625rem;
}
[data-palette-input-band] {
  border-bottom-color: transparent;
  padding-block: 0.5rem;
}
/* At least as specific as the field rules, and later, so the bare inner inputs win. */
${list([
  `${CMDK_FIELD} > input`,
  `${LABEL_FIELD} > ${BB_SEARCH_INPUT}`,
  `${LABEL_FIELD} > ${BB_SEARCH_INPUT}:focus-visible`,
  `${PALETTE_FIELD} input:not(${OWN_FIELD}, [cmdk-input])`,
  `${PALETTE_FIELD} input:not(${OWN_FIELD}, [cmdk-input]):focus-visible`,
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
