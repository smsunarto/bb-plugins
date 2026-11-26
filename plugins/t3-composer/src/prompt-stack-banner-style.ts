/**
 * Unified frame, hairline, disclosure divider, and no-icon-glimmer styles for
 * every banner card in BB's prompt stack (`[data-promptbox-shell] > div:first-child`).
 *
 * Design:
 * - Tag each top-level prompt-stack banner `<section>` with `data-t3-prompt-stack-card`
 *   by walking only the prompt stack's outer `<div>` wrappers and stopping at the
 *   first `<section>` on every branch. Nested `<section>` elements inside a card
 *   (disclosure bodies, inline `PendingInteractionShell`, queued-message inline
 *   editors) are never tagged, and the outer card never loses its tag when one
 *   opens inside it.
 * - Every CSS rule anchors on `[data-t3-prompt-stack-card]` or `[data-prompt-stack-peek]`
 *   with zero `:has()`, zero Tailwind utility classes, and zero bare-`span`
 *   structural selectors into core banner insides.
 * - Active-row wash/ring neutralization targets only core's own stable toggle
 *   button IDs (`#thread-prompt-banner-child-threads-toggle`, `#thread-todo-card-toggle`);
 *   core banners without stable inner hooks keep the shared frame and are tracked
 *   for native core unification.
 * - Banner icons never glimmer, shimmer, shine, or pulse in any state.
 *
 * Depends on BB's prompt-stack DOM: `[data-promptbox-shell] > div:first-child`
 * holding top-level `<section>` cards directly, inside `[data-bb-plugin-root]`,
 * or inside workflow/peek wrapper `<div>`s, with collapsible disclosure bodies
 * rendered as `section[role="region"][aria-hidden="true|false"]`.
 */
const STYLE_MARK = "data-t3-prompt-stack-banner-style";
export const CARD_ATTR = "data-t3-prompt-stack-card";

const SHELL = "[data-promptbox-shell]";
const CARD = `[${CARD_ATTR}]`;
const PEEK_LAYER = "[data-promptbox-shell] > div:first-child [data-prompt-stack-peek]";

export const PROMPT_STACK_BANNER_CSS = `
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
   Text running treatments (.animate-shine on spans) are left untouched. */
${CARD} .animate-shine-icon,
${CARD} .animate-pulse,
${CARD} svg:not(.animate-spin) {
  -webkit-mask-image: none !important;
  mask-image: none !important;
  animation: none !important;
  will-change: auto !important;
}

/* Clear active-row wash/ring on core's stable disclosure toggle button IDs so
   those interactive buttons share the card surface at rest while preserving
   hover and focus-visible rings. */
${CARD} #thread-prompt-banner-child-threads-toggle:not(:focus-visible),
${CARD} #thread-todo-card-toggle:not(:focus-visible) {
  box-shadow: none;
}

${CARD} #thread-prompt-banner-child-threads-toggle:not(:hover),
${CARD} #thread-todo-card-toggle:not(:hover) {
  background-color: transparent;
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

/** Syncs `CARD_ATTR` on every top-level card in `stack`, removing stale marks. */
export function syncPromptStackCards(stack: Element): void {
  const next = new Set<Element>();
  collectTopLevelCards(stack, next);

  for (const marked of stack.querySelectorAll(`[${CARD_ATTR}]`)) {
    if (!next.has(marked)) marked.removeAttribute(CARD_ATTR);
  }
  for (const card of next) {
    if (!card.hasAttribute(CARD_ATTR)) card.setAttribute(CARD_ATTR, "");
  }
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
    for (const marked of stack.querySelectorAll(`[${CARD_ATTR}]`)) {
      marked.removeAttribute(CARD_ATTR);
    }
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
      for (const marked of stack.querySelectorAll(`[${CARD_ATTR}]`)) {
        marked.removeAttribute(CARD_ATTR);
      }
    }
    watchedStacks.clear();
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
