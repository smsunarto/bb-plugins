/**
 * Unified frame, hairline, hover lightening, disclosure divider, no-icon-glimmer,
 * and background-agent label/value normalization for every banner card in BB's
 * prompt stack (`[data-promptbox-shell] > div:first-child`).
 *
 * Design:
 * - Tag each top-level prompt-stack banner `<section>` with `data-t3-prompt-stack-card`
 *   by walking only the prompt stack's outer `<div>` wrappers and stopping at the
 *   first `<section>` on every branch. Nested `<section>` elements inside a card
 *   (disclosure bodies, inline `PendingInteractionShell`, queued-message inline
 *   editors) are never tagged, and the outer card never loses its tag when one
 *   opens inside it.
 * - For BB's `ThreadBackgroundCommandsCard` (1-item and 2+-item states across
 *   both BB 0.50.1 and BB main), tag the active-row wash wrapper with
 *   `data-t3-prompt-stack-flat-row`, the primary label span with
 *   `data-t3-prompt-stack-label`, and sibling value spans with
 *   `data-t3-prompt-stack-value` so the card shares the exact same fill,
 *   12px medium foreground label (no shine), and 12px regular muted-foreground
 *   value (no shine) without any `:has()` or bare-`span` CSS selectors.
 * - Every CSS rule anchors on plugin-prefixed `data-t3-prompt-stack-*` attributes,
 *   `[data-prompt-stack-peek]`, or core's stable toggle button IDs with zero
 *   `:has()`, zero Tailwind utility classes, and zero bare-`span` selectors.
 * - Banner icons never glimmer, shimmer, shine, or pulse in any state.
 * - Every interactive banner row lightens on hover via one shared token;
 *   non-interactive rows stay flat.
 *
 * Depends on BB's prompt-stack DOM: `[data-promptbox-shell] > div:first-child`
 * holding top-level `<section>` cards directly, inside `[data-bb-plugin-root]`,
 * or inside workflow/peek wrapper `<div>`s, with collapsible disclosure bodies
 * rendered as `section[aria-hidden="true|false"]`.
 */
const STYLE_MARK = "data-t3-prompt-stack-banner-style";
export const CARD_ATTR = "data-t3-prompt-stack-card";
export const FLAT_ROW_ATTR = "data-t3-prompt-stack-flat-row";
export const LABEL_ATTR = "data-t3-prompt-stack-label";
export const VALUE_ATTR = "data-t3-prompt-stack-value";

const ALL_MARK_ATTRS = [CARD_ATTR, FLAT_ROW_ATTR, LABEL_ATTR, VALUE_ATTR] as const;

const SHELL = "[data-promptbox-shell]";
const CARD = `[${CARD_ATTR}]`;
const FLAT_ROW = `[${FLAT_ROW_ATTR}]`;
const LABEL = `[${LABEL_ATTR}]`;
const VALUE = `[${VALUE_ATTR}]`;
const PEEK_LAYER = "[data-promptbox-shell] > div:first-child [data-prompt-stack-peek]";
const BG_ACTIVITY_LABEL_RE = /background (?:agent|command|activit)/i;

export const PROMPT_STACK_BANNER_CSS = `
/* One shared lightening hover token for every interactive prompt-stack banner
   row: in dark themes (bb Monokai dark, default dark), --state-hover lightens
   the --surface-raised-solid card; in light theme, raising to --background
   (#fff over #f9f9f9) with a subtle edge lift reads clearly lighter than rest. */
:root {
  --prompt-banner-hover-bg: var(--background);
  --prompt-banner-hover-shadow: inset 0 0 0 var(--t3-composer-ring-width)
    color-mix(in oklab, var(--foreground) 12%, transparent);
}

.dark {
  --prompt-banner-hover-bg: var(--state-hover);
  --prompt-banner-hover-shadow: none;
}

/* One frame and one-device-pixel hairline for every prompt-stack card, painted
   above full-width headers and opaque expanded bodies so nothing washes it out. */
${CARD} {
  position: relative;
  overflow: hidden;
  border-width: 0;
  min-height: 32px !important;
}

${CARD}::after,
${PEEK_LAYER}::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 var(--t3-composer-ring-width) var(--t3-composer-hairline);
  pointer-events: none;
}

${PEEK_LAYER} {
  border-width: 0;
}

/* Prompt-stack banner icons never glimmer, shimmer, shine, or pulse in any state.
   Text running treatments (.animate-shine on spans) are left untouched except on
   explicitly normalized label/value tokens below. */
${CARD} .animate-shine-icon,
${CARD} .animate-pulse,
${CARD} svg:not(.animate-spin) {
  -webkit-mask-image: none !important;
  mask-image: none !important;
  animation: none !important;
  will-change: auto !important;
}

/* Clear active-row wash/ring on non-interactive background-activity rows and on
   core's stable disclosure toggle button IDs so every card shares one fill at
   rest while keeping hover and focus-visible rings on interactive buttons. */
${CARD} ${FLAT_ROW} {
  background-color: transparent !important;
  box-shadow: none !important;
}

${CARD} #thread-prompt-banner-child-threads-toggle:not(:hover):not(:focus-visible),
${CARD} #thread-todo-card-toggle:not(:hover):not(:focus-visible),
${CARD} #thread-background-commands-card-toggle:not(:hover):not(:focus-visible) {
  box-shadow: none;
}

${CARD} #thread-prompt-banner-child-threads-toggle:not(:hover),
${CARD} #thread-todo-card-toggle:not(:hover),
${CARD} #thread-background-commands-card-toggle:not(:hover) {
  background-color: transparent;
}

/* Normalized background-agent label (12px medium foreground, no shine) and
   value (12px regular muted-foreground, no shine). Scoped under ${CARD} so
   specificity beats single-class core utilities regardless of sheet order. */
${CARD} ${LABEL} {
  font-size: 12px;
  font-weight: 500;
  color: var(--foreground);
  -webkit-text-fill-color: var(--foreground);
  -webkit-mask-image: none !important;
  mask-image: none !important;
  animation: none !important;
  will-change: auto !important;
}

${CARD} ${VALUE} {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted-foreground);
  -webkit-text-fill-color: var(--muted-foreground);
  -webkit-mask-image: none !important;
  mask-image: none !important;
  animation: none !important;
  will-change: auto !important;
}

/* Every interactive prompt-stack banner row lightens on hover via one shared
   token, gated to hover-capable pointers; non-interactive rows stay flat. */
@media (hover: hover) {
  ${CARD} button[aria-expanded]:not([aria-haspopup]):hover,
  ${CARD} #thread-prompt-banner-child-threads-toggle:hover {
    background-color: var(--prompt-banner-hover-bg);
    box-shadow: var(--prompt-banner-hover-shadow);
  }
}

/* Disclosure bodies (both direct core children and plugin-wrapped segments such
   as bb--git/changed-files and rpiv-todo): drop reserved 1px border-top while
   collapsed, and draw a matching one-device-pixel hairline when expanded. */
${CARD} section[aria-hidden="true"] {
  border-top-width: 0;
}

${CARD} section[aria-hidden="false"] {
  position: relative;
  border-top-width: 0;
}

${CARD} section[aria-hidden="false"]::before {
  content: "";
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: var(--t3-composer-ring-width);
  background: var(--t3-composer-hairline);
  pointer-events: none;
}
`;

function isBackgroundActivityCard(card: Element): boolean {
  if (card.querySelector("#thread-background-commands-card-toggle") !== null) return true;
  const label = card.getAttribute("aria-label") ?? "";
  return BG_ACTIVITY_LABEL_RE.test(label);
}

/** Collects elements to tag on `ThreadBackgroundCommandsCard` (1-item & 2+-item,
 *  BB 0.50.1 & BB main) so it shares the flat surface and label/value grammar. */
function collectBackgroundActivityMarks(
  card: Element,
  flatRows: Set<Element>,
  labels: Set<Element>,
  values: Set<Element>,
): void {
  const outerRow = card.firstElementChild;
  if (outerRow === null || outerRow.tagName !== "DIV") return;
  flatRows.add(outerRow);

  const toggle = outerRow.querySelector("#thread-background-commands-card-toggle");
  const header = toggle ?? outerRow.firstElementChild;
  if (header === null) return;
  if (toggle === null && header.tagName === "DIV") {
    flatRows.add(header);
  }

  // Summary container is the first <span> child of the header row (after the icon).
  let summary: Element | null = null;
  for (let child = header.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.tagName === "SPAN") {
      summary = child;
      break;
    }
  }
  if (summary === null) return;

  const parts: Element[] = [];
  for (let child = summary.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.tagName === "SPAN") parts.push(child);
  }
  if (parts.length === 0) {
    labels.add(summary);
    return;
  }
  labels.add(parts[0]!);
  for (let i = 1; i < parts.length; i++) {
    values.add(parts[i]!);
  }
}

/** Collects top-level banner card `<section>` elements inside a prompt stack without
 *  descending into any `<section>` (so nested disclosure bodies, inline pending
 *  interactions, and queued-message editors are never treated as cards). */
function collectTopLevelCards(container: Element, out: Set<Element>): void {
  for (let child = container.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.tagName === "SECTION") {
      if (
        child.getAttribute("role") !== "region" &&
        !child.hasAttribute("aria-hidden") &&
        child.getAttribute("data-presentation") !== "inline"
      ) {
        out.add(child);
      }
      continue;
    }
    if (child.tagName === "DIV") {
      collectTopLevelCards(child, out);
    }
  }
}

function syncAttr(root: Element, attr: string, next: Set<Element>): void {
  for (const marked of root.querySelectorAll(`[${attr}]`)) {
    if (!next.has(marked)) marked.removeAttribute(attr);
  }
  for (const el of next) {
    if (!el.hasAttribute(attr)) el.setAttribute(attr, "");
  }
}

function clearAllMarks(root: Element): void {
  for (const attr of ALL_MARK_ATTRS) {
    for (const marked of root.querySelectorAll(`[${attr}]`)) {
      marked.removeAttribute(attr);
    }
  }
}

/** Syncs card and background-activity marks in `stack`, removing stale marks. */
export function syncPromptStackCards(stack: Element): void {
  const cards = new Set<Element>();
  const flatRows = new Set<Element>();
  const labels = new Set<Element>();
  const values = new Set<Element>();

  collectTopLevelCards(stack, cards);
  for (const card of cards) {
    if (isBackgroundActivityCard(card)) {
      collectBackgroundActivityMarks(card, flatRows, labels, values);
    }
  }

  syncAttr(stack, CARD_ATTR, cards);
  syncAttr(stack, FLAT_ROW_ATTR, flatRows);
  syncAttr(stack, LABEL_ATTR, labels);
  syncAttr(stack, VALUE_ATTR, values);
}

function collectShells(node: Node, out: Element[]): void {
  if (!(node instanceof Element)) return;
  if (node.matches(SHELL)) out.push(node);
  if (node.childElementCount > 0) {
    for (const found of node.querySelectorAll(SHELL)) out.push(found);
  }
}

function hasElementMutation(records: readonly MutationRecord[]): boolean {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element) return true;
    }
    for (const node of record.removedNodes) {
      if (node instanceof Element) return true;
    }
  }
  return false;
}

export function mountPromptStackBannerStyle(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};

  const style = document.createElement("style");
  style.setAttribute(STYLE_MARK, "");
  style.textContent = PROMPT_STACK_BANNER_CSS;
  document.head.append(style);

  const watchedStacks = new Map<Element, MutationObserver>();

  const watchShell = (shell: Element) => {
    if (shell.parentElement?.closest("section") !== null) return;
    const stack = shell.firstElementChild;
    if (stack === null || watchedStacks.has(stack)) return;
    syncPromptStackCards(stack);
    const observer = new MutationObserver((records) => {
      if (!hasElementMutation(records)) return;
      syncPromptStackCards(stack);
    });
    observer.observe(stack, { childList: true, subtree: true });
    watchedStacks.set(stack, observer);
  };

  const unwatchShell = (shell: Element) => {
    const stack = shell.firstElementChild;
    if (stack === null) return;
    const observer = watchedStacks.get(stack);
    if (!observer) return;
    observer.disconnect();
    watchedStacks.delete(stack);
    clearAllMarks(stack);
  };

  for (const shell of document.querySelectorAll(SHELL)) watchShell(shell);

  const bodyObserver = new MutationObserver((records) => {
    const added: Element[] = [];
    const removed: Element[] = [];
    for (const record of records) {
      for (const node of record.addedNodes) collectShells(node, added);
      for (const node of record.removedNodes) collectShells(node, removed);
    }
    for (const shell of removed) if (!shell.isConnected) unwatchShell(shell);
    for (const shell of added) if (shell.isConnected) watchShell(shell);
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });

  const dispose = () => {
    signal.removeEventListener("abort", dispose);
    bodyObserver.disconnect();
    for (const [stack, observer] of watchedStacks) {
      observer.disconnect();
      clearAllMarks(stack);
    }
    watchedStacks.clear();
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
