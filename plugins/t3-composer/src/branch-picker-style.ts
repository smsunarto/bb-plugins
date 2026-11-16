/**
 * BB's branch picker, styled like this plugin's machine selector: the desktop popover like
 * the machine menu that app.css restyles, the phone sheet like the machine sheet. The
 * picker belongs to BB's environment plugins and writes their provider inputs, which a
 * plugin cannot set, so this restyles BB's DOM rather than replacing the picker.
 *
 * The popover's card repeats app.css's machine-menu card, with the theme's hairline width.
 *
 * One marked `<style>`, plus a tag on the chosen row: BB shows which row is chosen only by its
 * check icon's opacity, which CSS cannot select without naming a Tailwind class. A
 * childList-only observer on `<body>` finds the pickers BB portals there; each open picker
 * gets its own observer, which retags its rows in the next frame after a change.
 *
 * It depends on BB's branch picker DOM: the environment plugin's overlay (`data-bb-plugin`,
 * `role="dialog"`, and `data-persistent-drawer-content` for the phone sheet) as a child of
 * `<body>` or of its Radix popper wrapper there, its rows (`data-branch-picker-row`,
 * `data-highlighted`, a `svg[data-icon="Check"]` that is transparent unless chosen), and the
 * headings, divider, note and search field that sit beside the rows.
 */
const MARK = "data-t3-branch-picker-style";
/** On the row whose check shows. */
const CHOSEN = "data-t3-branch-chosen";
const ROW = "[data-branch-picker-row]";

const PICKER = `:is([data-bb-plugin="environment-project-checkout"], [data-bb-plugin="environment-git-worktree"])[data-bb-portaled-overlay][role="dialog"]`;
const MENU = `[data-radix-popper-content-wrapper] > ${PICKER}`;
const SHEET = `${PICKER}[data-persistent-drawer-content]`;
/** The scrolling list that holds the headings, rows, divider and note. */
const LIST = "div:has(> [data-branch-picker-row])";
const SURFACE = "color-mix(in srgb, var(--foreground) 9%, var(--background))";
const HAIRLINE = "color-mix(in srgb, var(--foreground) 8%, transparent)";

export const BRANCH_PICKER_CSS = `
${MENU} {
  overflow: hidden;
  border: var(--hairline-width, 1px) solid color-mix(in srgb, var(--foreground) 12%, transparent);
  border-radius: 12px;
  background: ${SURFACE};
  box-shadow: 0 8px 24px color-mix(in srgb, var(--foreground) 10%, transparent);
  font-size: 13px;
}
.dark ${MENU} {
  box-shadow: none;
}
${MENU} ${LIST} {
  padding: 4px;
}
${MENU} ${LIST} > div {
  height: auto;
  margin-inline: 0;
  padding: 4px 8px;
  background: ${SURFACE};
  color: color-mix(in srgb, var(--foreground) 50%, transparent);
  font-size: 12px;
  font-weight: 400;
}
${MENU} [data-branch-picker-row] {
  min-height: 28px;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 10px;
  font-size: 13px;
}
${MENU} [data-branch-picker-row] > svg {
  width: 16px;
  height: 16px;
}
${MENU} ${LIST} > p {
  padding: 4px 8px 8px;
  font-size: 12px;
}
${MENU} [data-branch-picker-row][data-highlighted] {
  background: ${HAIRLINE};
}
${MENU} ${LIST} > div:empty {
  height: 1px;
  margin: 4px 8px;
  padding: 0;
  background: ${HAIRLINE};
}
${MENU} input {
  font-size: 13px;
}

${SHEET} ${LIST} {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 8px 12px;
}
${SHEET} ${LIST} > div {
  height: auto;
  padding: 8px 12px 4px;
  background: var(--popover);
  font-size: 14px;
  font-weight: 500;
}
${SHEET} ${LIST} > div:empty {
  height: 1px;
  margin: 4px 0;
  padding: 0;
  background: ${HAIRLINE};
}
${SHEET} ${LIST} > div:first-child {
  padding: 0 12px 8px;
  color: var(--foreground);
  font-size: 16px;
  font-weight: 600;
}
${SHEET} ${LIST}:not(:first-child) > div:first-child {
  padding-top: 8px;
}
${SHEET} [data-branch-picker-row] {
  min-height: 56px;
  gap: 12px;
  padding: 8px 12px 8px 16px;
  border-radius: 8px;
  font-size: 16px;
}
/* Like the machine sheet, only the chosen row is tinted, not BB's keyboard highlight. */
${SHEET} [data-branch-picker-row][data-highlighted] {
  background: transparent;
}
${SHEET} [data-branch-picker-row][${CHOSEN}] {
  background: color-mix(in srgb, var(--foreground) 6%, transparent);
}
${SHEET} [data-branch-picker-row]:active {
  background: color-mix(in srgb, var(--foreground) 9%, transparent);
}
${SHEET} [data-branch-picker-row] > svg {
  width: 20px;
  height: 20px;
}
${SHEET} [data-branch-picker-row] > svg:first-child {
  margin: 0 4px;
}
${SHEET} ${LIST} > p {
  padding: 8px 12px;
  font-size: 14px;
}
`;

/** The picker an element `<body>` gained is, or holds as its popper wrapper's child. */
function pickerIn(node: Node): Element | null {
  if (!(node instanceof Element)) return null;
  return node.matches(PICKER) ? node : node.querySelector(`:scope > ${PICKER}`);
}

function tagChosen(picker: Element) {
  for (const row of picker.querySelectorAll(ROW)) {
    const check = row.querySelector('svg[data-icon="Check"]');
    const view = row.ownerDocument.defaultView;
    const chosen = check !== null && view?.getComputedStyle(check).opacity !== "0";
    if (chosen !== row.hasAttribute(CHOSEN)) row.toggleAttribute(CHOSEN, chosen);
  }
}

/**
 * Adds the stylesheet and tags each branch picker's chosen row until `signal` aborts; the
 * disposer takes both out.
 */
export function mountBranchPickerStyle(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const view = document.defaultView;
  const style = document.createElement("style");
  style.setAttribute(MARK, "");
  style.textContent = BRANCH_PICKER_CSS;
  document.head.append(style);

  const watched = new Map<Element, MutationObserver>();
  const pending = new Set<Element>();
  let frame = 0;
  const flush = () => {
    frame = 0;
    for (const picker of pending) if (picker.isConnected) tagChosen(picker);
    pending.clear();
  };
  const schedule = (picker: Element) => {
    pending.add(picker);
    if (frame === 0) frame = view?.requestAnimationFrame(flush) ?? 0;
  };
  const watch = (picker: Element) => {
    if (watched.has(picker)) return;
    const observer = new MutationObserver(() => schedule(picker));
    observer.observe(picker, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    watched.set(picker, observer);
    schedule(picker);
  };
  const unwatch = (picker: Element) => {
    watched.get(picker)?.disconnect();
    watched.delete(picker);
  };
  const body = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const picker = pickerIn(node);
        if (picker) watch(picker);
      }
      for (const node of record.removedNodes) {
        const picker = pickerIn(node);
        if (picker) unwatch(picker);
      }
    }
  });
  body.observe(document.body, { childList: true });
  for (const picker of document.querySelectorAll(PICKER)) watch(picker);

  const dispose = () => {
    body.disconnect();
    if (frame !== 0) view?.cancelAnimationFrame(frame);
    frame = 0;
    pending.clear();
    for (const [picker, observer] of watched) {
      observer.disconnect();
      for (const row of picker.querySelectorAll(`[${CHOSEN}]`)) row.removeAttribute(CHOSEN);
    }
    watched.clear();
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return () => {
    signal.removeEventListener("abort", dispose);
    dispose();
  };
}
