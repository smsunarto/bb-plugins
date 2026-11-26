/**
 * Unified frame, hairline, hover lightening, disclosure divider, no-icon-glimmer,
 * flat active rows, and label/value normalization for every banner card in BB's
 * prompt stack (`[data-promptbox-shell] > div:first-child`).
 *
 * Design:
 * - Tag each top-level prompt-stack banner `<section>` with `data-t3-prompt-stack-card`
 *   by walking only the prompt stack's outer `<div>` wrappers and stopping at the
 *   first `<section>` on every branch. Nested `<section>` elements inside a card
 *   (disclosure bodies, inline `PendingInteractionShell`, queued-message inline
 *   editors) are never tagged, and the outer card never loses its tag when one
 *   opens inside it.
 * - Tag only top-level banner header disclosure triggers with
 *   `data-t3-prompt-stack-toggle` (excluding nested body buttons such as Captain's
 *   `More`/`Read plan`, `PromptStackCollapseRow`, workflow phase toggles, queued
 *   overflow buttons, and standalone `PendingInteractionShell` buttons). Hover
 *   tokens are scoped onto `[data-t3-prompt-stack-card]` where `app.css` defines
 *   `--t3-composer-ring-width`, use theme tokens with no raw `color-mix`, lighten
 *   interactive headers in every theme, and never override `:focus-visible` rings.
 * - Flatten active-row washes (`bg-background/70`, `ring-1`) on core header row
 *   wrappers (`Plan`/`Goal` `CollapsibleActiveStackCard`, 1-item & 2+-item
 *   `ThreadBackgroundCommandsCard`) via `data-t3-prompt-stack-flat-row`, normalize
 *   single-label header weights (`Active child threads`, `Queue`) and multi-part
 *   background-activity label/value spans via `data-t3-prompt-stack-label` /
 *   `data-t3-prompt-stack-value` without forcing font-size (preserving `text-2xs`
 *   badges), and suppress icon glimmer without clobbering `PluginAssetIcon` masks.
 * - Every CSS rule anchors on plugin-prefixed `data-t3-prompt-stack-*` attributes
 *   or `[data-prompt-stack-peek]` with zero hardcoded core IDs, zero prose
 *   `aria-label` regexes, zero `:has()`, zero Tailwind utility classes, and zero
 *   bare-`span` selectors.
 *
 * Depends on BB's prompt-stack DOM: `[data-promptbox-shell] > div:first-child`
 * holding top-level `<section>` cards directly, inside `[data-bb-plugin-root]`,
 * or inside workflow/peek wrapper `<div>`s, with collapsible disclosure bodies
 * rendered as `section[aria-hidden="true|false"]`.
 */
const STYLE_MARK = "data-t3-prompt-stack-banner-style";
export const CARD_ATTR = "data-t3-prompt-stack-card";
export const TOGGLE_ATTR = "data-t3-prompt-stack-toggle";
export const FLAT_ROW_ATTR = "data-t3-prompt-stack-flat-row";
export const LABEL_ATTR = "data-t3-prompt-stack-label";
export const VALUE_ATTR = "data-t3-prompt-stack-value";

const ALL_MARK_ATTRS = [CARD_ATTR, TOGGLE_ATTR, FLAT_ROW_ATTR, LABEL_ATTR, VALUE_ATTR] as const;

const SHELL = "[data-promptbox-shell]";
const CARD = `[${CARD_ATTR}]`;
const TOGGLE = `[${TOGGLE_ATTR}]`;
const FLAT_ROW = `[${FLAT_ROW_ATTR}]`;
const LABEL = `[${LABEL_ATTR}]`;
const VALUE = `[${VALUE_ATTR}]`;
const PEEK_LAYER = "[data-promptbox-shell] > div:first-child [data-prompt-stack-peek]";
const BODY_SKIP_SELECTOR =
  'section[role="region"], section[aria-hidden], [data-queued-messages-scroll-frame], [role="toolbar"]';

export const PROMPT_STACK_BANNER_CSS = `
/* One frame, one-device-pixel hairline, and one shared lightening hover token
   for every prompt-stack card. Scoped on ${CARD} inside [data-promptbox-shell]
   so --t3-composer-ring-width and --t3-composer-hairline resolve directly from
   app.css, using theme tokens only. */
${CARD} {
  --t3-prompt-banner-hover-bg: var(--background);
  --t3-prompt-banner-hover-shadow: inset 0 0 0 var(--t3-composer-ring-width) var(--border);
  position: relative;
  overflow: hidden;
  border-width: 0;
  min-height: 32px !important;
}

.dark ${CARD} {
  --t3-prompt-banner-hover-bg: var(--state-hover);
  --t3-prompt-banner-hover-shadow: none;
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

/* Prompt-stack banner icons and labels never glimmer, shimmer, shine, or pulse
   in any state. Guard mask clearing against [data-plugin-icon-asset] so
   PluginAssetIcon inline mask-image glyphs stay intact. */
${CARD} .animate-shine:not([data-plugin-icon-asset]),
${CARD} .animate-shine-icon:not([data-plugin-icon-asset]),
${CARD} svg:not(.animate-spin) {
  -webkit-mask-image: none;
  mask-image: none;
  animation: none;
  will-change: auto;
}

${CARD} .animate-pulse {
  animation: none;
  will-change: auto;
}

/* Flatten active-row washes and rings unconditionally at rest so every banner
   card shares one surface fill on both desktop and touch (preventing sticky
   :hover from re-exposing core washes after a tap) while keeping :focus-visible
   rings intact. */
${CARD} ${FLAT_ROW} {
  background-color: transparent;
  box-shadow: none;
}

${CARD} ${TOGGLE} {
  background-color: transparent;
}

${CARD} ${TOGGLE}:not(:focus-visible) {
  box-shadow: none;
}

/* Unified label (medium foreground, steady with no shine sweep) and value
   (regular muted-foreground, no shine) grammar for normalized core banner
   spans. Font size is inherited from the row so compact badges such as
   text-2xs (10px) keep their size. */
${CARD} ${LABEL} {
  font-weight: 500;
  color: var(--foreground);
  -webkit-text-fill-color: var(--foreground);
  -webkit-mask-image: none;
  mask-image: none;
  animation: none;
  will-change: auto;
}

${CARD} ${VALUE} {
  font-weight: 400;
  color: var(--muted-foreground);
  -webkit-text-fill-color: var(--muted-foreground);
  -webkit-mask-image: none;
  mask-image: none;
  animation: none;
  will-change: auto;
}

/* Every interactive top-level banner header lightens on hover via one shared
   token, gated to hover-capable pointers. Box-shadow is guarded by
   :not(:focus-visible) so hovering a keyboard-focused toggle never wipes its
   focus ring. */
@media (hover: hover) {
  ${CARD} ${TOGGLE}:hover {
    background-color: var(--t3-prompt-banner-hover-bg);
  }

  ${CARD} ${TOGGLE}:hover:not(:focus-visible) {
    box-shadow: var(--t3-prompt-banner-hover-shadow);
  }
}

/* Disclosure bodies (both direct core children and plugin-wrapped segments such
   as bb--git/changed-files, rpiv-todo, and pr-watch): drop reserved 1px
   border-top while collapsed, and draw a matching one-device-pixel hairline
   when expanded. */
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

interface CardMarkSets {
  cards: Set<Element>;
  toggles: Set<Element>;
  flatRows: Set<Element>;
  labels: Set<Element>;
  values: Set<Element>;
}

function emptyMarks(): CardMarkSets {
  return {
    cards: new Set<Element>(),
    toggles: new Set<Element>(),
    flatRows: new Set<Element>(),
    labels: new Set<Element>(),
    values: new Set<Element>(),
  };
}

function isHeaderDisclosureButton(el: Element): boolean {
  return (
    el.tagName === "BUTTON" && el.hasAttribute("aria-expanded") && !el.hasAttribute("aria-haspopup")
  );
}

/** Standalone PendingInteractionShell cards use data-expanded or pair two sibling
 *  disclosure buttons controlling the same content ID; leave their buttons alone. */
function isPendingInteractionCard(card: Element): boolean {
  if (card.hasAttribute("data-expanded")) return true;
  const first = card.firstElementChild;
  if (first?.tagName !== "DIV") return false;
  const seen = new Set<string>();
  for (let child = first.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (!isHeaderDisclosureButton(child)) continue;
    const controls = child.getAttribute("aria-controls");
    if (controls === null) continue;
    if (seen.has(controls)) return true;
    seen.add(controls);
  }
  return false;
}

/** True when `el` contains no non-whitespace direct text nodes (all copy is in child spans). */
function hasOnlyElementText(el: Element): boolean {
  for (let node = el.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 3 && (node.textContent?.trim() ?? "") !== "") {
      return false;
    }
  }
  return true;
}

/** Marks a single plain-text label span directly inside a header button
 *  (ActiveChildThreadsCard "Active child threads", QueuedMessagesList "Queue"). */
function collectDirectButtonLabel(button: Element, labels: Set<Element>): void {
  for (let child = button.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (
      child.tagName === "SPAN" &&
      child.childElementCount === 0 &&
      (child.textContent?.trim() ?? "") !== ""
    ) {
      labels.add(child);
      return;
    }
  }
}

/** Marks multi-part background-activity summary spans (`[label, value, ...]`). */
function collectMultiPartSummaryMarks(
  header: Element,
  labels: Set<Element>,
  values: Set<Element>,
): void {
  let summary: Element | null = null;
  for (let child = header.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.tagName === "SPAN") {
      summary = child;
      break;
    }
  }
  if (summary === null) return;
  if (
    summary.hasAttribute("data-promptbox-hide-compact") ||
    summary.hasAttribute("data-promptbox-compact-label") ||
    !hasOnlyElementText(summary)
  ) {
    return;
  }
  const parts: Element[] = [];
  for (let child = summary.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.tagName === "SPAN") parts.push(child);
  }
  if (parts.length < 2) return;
  labels.add(parts[0]!);
  for (let i = 1; i < parts.length; i++) {
    values.add(parts[i]!);
  }
}

function collectDirectToggleChildren(row: Element, toggles: Set<Element>): void {
  for (let child = row.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (isHeaderDisclosureButton(child)) {
      toggles.add(child);
    }
  }
}

function collectPluginCardMarks(card: Element, toggles: Set<Element>): void {
  for (let child = card.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.tagName !== "DIV") continue;
    // Skip interactive toolbar cards (e.g. Captain NeedsYou ask body with More / Read plan).
    if (child.getAttribute("role") === "toolbar") continue;
    // Direct toggle inside wrapper (if a plugin renders a button directly).
    collectDirectToggleChildren(child, toggles);
    // Single-disclosure plugin cards (e.g. rpiv-todo: card > div > div:first-child > button).
    const firstRow = child.firstElementChild;
    if (firstRow?.tagName === "DIV" && !firstRow.hasAttribute("data-state")) {
      collectDirectToggleChildren(firstRow, toggles);
    }
    // Multi-item Radix Collapsible plugin cards (e.g. PrWatchBanner: card > div > div[data-state] > div:first-child > button).
    for (let item = child.firstElementChild; item !== null; item = item.nextElementSibling) {
      if (item.tagName === "DIV" && item.hasAttribute("data-state")) {
        const headerRow = item.firstElementChild;
        if (headerRow?.tagName === "DIV") {
          collectDirectToggleChildren(headerRow, toggles);
        }
      }
    }
  }
}

function collectCoreHeaderRowMarks(row: Element, marks: CardMarkSets): void {
  marks.flatRows.add(row);
  for (let child = row.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (isHeaderDisclosureButton(child)) {
      marks.toggles.add(child);
      collectDirectButtonLabel(child, marks.labels);
      collectMultiPartSummaryMarks(child, marks.labels, marks.values);
      continue;
    }
    // Plugin-contributed thread-context segments (e.g. bb--git/changed-files) wrap
    // their toggle inside <div data-bb-plugin="..." class="contents">.
    if (child.tagName === "DIV" && child.hasAttribute("data-bb-plugin")) {
      collectDirectToggleChildren(child, marks.toggles);
      continue;
    }
    // 1-item non-interactive ThreadBackgroundCommandsCard header: <div aria-label="..."> without role.
    if (
      child.tagName === "DIV" &&
      child.hasAttribute("aria-label") &&
      !child.hasAttribute("role")
    ) {
      marks.flatRows.add(child);
      collectMultiPartSummaryMarks(child, marks.labels, marks.values);
    }
  }
}

function collectCoreCardMarks(card: Element, marks: CardMarkSets): void {
  const first = card.firstElementChild;
  if (first === null) return;

  // Direct button header: ActiveChildThreadsCard (normal + back header) & ThreadWorkflowCard.
  if (first.tagName === "BUTTON") {
    if (isHeaderDisclosureButton(first) || first.nextElementSibling?.tagName === "SECTION") {
      marks.toggles.add(first);
      collectDirectButtonLabel(first, marks.labels);
    }
    return;
  }

  // <header> wrapper: QueuedMessagesList.
  if (first.tagName === "HEADER") {
    for (let child = first.firstElementChild; child !== null; child = child.nextElementSibling) {
      if (isHeaderDisclosureButton(child)) {
        marks.toggles.add(child);
        collectDirectButtonLabel(child, marks.labels);
      }
    }
    return;
  }

  // Core <div> header wrapper: ThreadTodoCard, CollapsibleActiveStackCard (Plan/Goal),
  // ThreadBackgroundCommandsCard (1-item & 2+-item), ThreadPromptContextBanner (incl. bb--git),
  // ThreadMachineStatusBanner, ThreadModelFallbackCard, ProviderRequirementBanner.
  if (first.tagName === "DIV") {
    collectCoreHeaderRowMarks(first, marks);
  }
}

function isPluginCard(card: Element): boolean {
  return card.parentElement?.hasAttribute("data-bb-plugin-root") === true;
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

function syncAttrSet(
  root: Element,
  attr: string,
  next: Set<Element>,
  prev: Set<Element> | null,
): void {
  if (prev !== null) {
    for (const old of prev) {
      if (!next.has(old)) old.removeAttribute(attr);
    }
  } else {
    for (const marked of root.querySelectorAll(`[${attr}]`)) {
      if (!next.has(marked)) marked.removeAttribute(attr);
    }
  }
  for (const el of next) {
    if (!el.hasAttribute(attr)) el.setAttribute(attr, "");
  }
}

function clearMarkSets(marks: CardMarkSets): void {
  for (const el of marks.cards) el.removeAttribute(CARD_ATTR);
  for (const el of marks.toggles) el.removeAttribute(TOGGLE_ATTR);
  for (const el of marks.flatRows) el.removeAttribute(FLAT_ROW_ATTR);
  for (const el of marks.labels) el.removeAttribute(LABEL_ATTR);
  for (const el of marks.values) el.removeAttribute(VALUE_ATTR);
}

function clearAllMarksInSubtree(root: Element): void {
  for (const attr of ALL_MARK_ATTRS) {
    for (const marked of root.querySelectorAll(`[${attr}]`)) {
      marked.removeAttribute(attr);
    }
  }
}

function computeMarks(stack: Element): CardMarkSets {
  const marks = emptyMarks();
  collectTopLevelCards(stack, marks.cards);
  for (const card of marks.cards) {
    if (isPendingInteractionCard(card)) continue;
    if (isPluginCard(card)) {
      collectPluginCardMarks(card, marks.toggles);
    } else {
      collectCoreCardMarks(card, marks);
    }
  }
  return marks;
}

/** Syncs card, toggle, flat-row, label, and value marks in `stack`, removing stale marks. */
export function syncPromptStackCards(
  stack: Element,
  prev: CardMarkSets | null = null,
): CardMarkSets {
  const next = computeMarks(stack);
  syncAttrSet(stack, CARD_ATTR, next.cards, prev?.cards ?? null);
  syncAttrSet(stack, TOGGLE_ATTR, next.toggles, prev?.toggles ?? null);
  syncAttrSet(stack, FLAT_ROW_ATTR, next.flatRows, prev?.flatRows ?? null);
  syncAttrSet(stack, LABEL_ATTR, next.labels, prev?.labels ?? null);
  syncAttrSet(stack, VALUE_ATTR, next.values, prev?.values ?? null);
  return next;
}

function collectShells(node: Node, out: Element[]): void {
  if (!(node instanceof Element)) return;
  if (node.matches(SHELL)) out.push(node);
  if (node.childElementCount > 0) {
    for (const found of node.querySelectorAll(SHELL)) out.push(found);
  }
}

function hasRelevantStackMutation(records: readonly MutationRecord[]): boolean {
  for (const record of records) {
    if (record.target instanceof Element && record.target.closest(BODY_SKIP_SELECTOR) !== null) {
      continue;
    }
    for (const node of record.addedNodes) {
      if (node instanceof Element) return true;
    }
    for (const node of record.removedNodes) {
      if (node instanceof Element) return true;
    }
  }
  return false;
}

interface WatchedShell {
  shellObserver: MutationObserver;
  stack: Element | null;
  stackObserver: MutationObserver | null;
  marks: CardMarkSets;
}

export function mountPromptStackBannerStyle(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};

  const style = document.createElement("style");
  style.setAttribute(STYLE_MARK, "");
  style.textContent = PROMPT_STACK_BANNER_CSS;
  document.head.append(style);

  const watchedShells = new Map<Element, WatchedShell>();

  const detachStack = (entry: WatchedShell) => {
    entry.stackObserver?.disconnect();
    entry.stackObserver = null;
    clearMarkSets(entry.marks);
    if (entry.stack !== null) clearAllMarksInSubtree(entry.stack);
    entry.marks = emptyMarks();
    entry.stack = null;
  };

  const attachStack = (entry: WatchedShell, stack: Element | null) => {
    if (entry.stack === stack) return;
    detachStack(entry);
    if (stack === null) return;
    entry.stack = stack;
    entry.marks = syncPromptStackCards(stack, null);
    const observer = new MutationObserver((records) => {
      if (!hasRelevantStackMutation(records)) return;
      entry.marks = syncPromptStackCards(stack, entry.marks);
    });
    observer.observe(stack, { childList: true, subtree: true });
    entry.stackObserver = observer;
  };

  const watchShell = (shell: Element) => {
    // Skip nested composers (e.g. queued-message inline FollowUpPromptBox) without
    // skipping top-level composers inside semantic <section> ancestors.
    if (shell.parentElement?.closest(SHELL) !== null) return;
    if (watchedShells.has(shell)) return;
    const entry: WatchedShell = {
      shellObserver: new MutationObserver(() => {
        attachStack(entry, shell.firstElementChild);
      }),
      stack: null,
      stackObserver: null,
      marks: emptyMarks(),
    };
    watchedShells.set(shell, entry);
    entry.shellObserver.observe(shell, { childList: true });
    attachStack(entry, shell.firstElementChild);
  };

  const unwatchShell = (shell: Element) => {
    const entry = watchedShells.get(shell);
    if (!entry) return;
    entry.shellObserver.disconnect();
    detachStack(entry);
    watchedShells.delete(shell);
  };

  for (const shell of document.querySelectorAll(SHELL)) watchShell(shell);

  const bodyObserver = new MutationObserver((records) => {
    const added: Element[] = [];
    const removed: Element[] = [];
    for (const record of records) {
      // Mutations inside an already-watched shell can only add nested shells,
      // which watchShell ignores anyway — skip scanning them on bodyObserver.
      if (
        watchedShells.size > 0 &&
        record.target instanceof Element &&
        record.target.closest(SHELL) !== null
      ) {
        continue;
      }
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
    for (const shell of watchedShells.keys()) unwatchShell(shell);
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
