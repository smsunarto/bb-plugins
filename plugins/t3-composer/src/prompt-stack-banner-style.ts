/**
 * Unified frame, hairline, fill, and divider styles for every banner card in
 * BB's prompt stack (`[data-promptbox-shell] > div:first-child`).
 *
 * Why one shared content-script stylesheet instead of per-card rules:
 * - BB's `PromptStackCard` draws a 1px `border-border` edge, while T3 Composer
 *   uses a one-device-pixel hairline (`--t3-composer-ring-width` /
 *   `--t3-composer-hairline`). An inset `box-shadow` on the `<section>` itself
 *   paints beneath child fills (`bg-popover` on expanded bodies, `bg-background/70`
 *   on active rows) and washes out or disappears. Painting the hairline on
 *   `::after` above children keeps every card's edge crisp and identical.
 * - Several core banners (`ThreadBackgroundCommandsCard`, `ActiveChildThreadsCard`,
 *   `ThreadTodoCard`, `CollapsibleActiveStackCard`) apply `activityRowClass("active")`
 *   (`bg-background/70 shadow-xs ring-1 ring-border/60`) on top of
 *   `PromptStackCard`'s `bg-surface-raised-solid`, making them darker than
 *   neighbouring cards (`Workflow`, `Model fallback`, `Provider requirement`,
 *   `Machine status`, `Thread context`, `Queued messages`, and `chrome: "card"`
 *   plugin banners). Neutralizing that inner wash/ring at rest puts every card
 *   on one shared `bg-surface-raised-solid` fill.
 * - Every rule targets all prompt-stack cards through one semantic selector
 *   (no Tailwind utility classes, no per-card ids, no per-card aria-labels).
 *
 * Depends on BB's prompt-stack DOM: `[data-promptbox-shell] > div:first-child`
 * holding `<section>` cards directly, inside `[data-bb-plugin-root]`, or inside
 * workflow stack wrapper `<div>`s, with collapsible bodies as child
 * `<section aria-hidden="true|false">` elements.
 */
const MARK = "data-t3-prompt-stack-banner-style";

/**
 * Every banner card `<section>` in the prompt stack: excludes collapsible
 * disclosure bodies (`[role="region"]`, `[aria-hidden]`) and outer group
 * wrappers that contain nested banner card `<section>`s (such as the
 * workflows plugin's multi-run wrapper).
 */
export const PROMPT_STACK_CARD_SELECTOR =
  '[data-promptbox-shell] > div:first-child section:not([role="region"]):not([aria-hidden]):not(:has(section:not([role="region"]):not([aria-hidden])))';

const PEEK_LAYER = "[data-promptbox-shell] > div:first-child [data-prompt-stack-peek]";

export const PROMPT_STACK_BANNER_CSS = `
/* One frame, hairline, and label/value typography tokens for every prompt-stack
   card. Painting the hairline on ::after above full-width headers and opaque
   expanded bodies keeps every card's edge crisp and identical. */
${PROMPT_STACK_CARD_SELECTOR} {
  --prompt-banner-label-weight: 500;
  --prompt-banner-label-color: var(--foreground);
  --prompt-banner-value-weight: 400;
  --prompt-banner-value-color: var(--muted-foreground);
  position: relative;
  overflow: hidden;
  border-width: 0;
  min-height: 32px !important;
}

${PROMPT_STACK_CARD_SELECTOR}::after,
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

/* Core active-row banners paint bg-background/70 + shadow-xs + ring-1 over
   PromptStackCard's bg-surface-raised-solid. Clear that inner wash and ring at
   rest so every prompt-stack card shares one fill while keeping hover and focus. */
${PROMPT_STACK_CARD_SELECTOR} > button[aria-expanded]:not(:focus-visible),
${PROMPT_STACK_CARD_SELECTOR} > div[role="group"]:not(:focus-visible),
${PROMPT_STACK_CARD_SELECTOR} > div:first-child > button[aria-expanded]:not(:focus-visible),
${PROMPT_STACK_CARD_SELECTOR} > div:first-child > div[aria-label]:not(:focus-visible) {
  box-shadow: none;
}

${PROMPT_STACK_CARD_SELECTOR} > button[aria-expanded]:not(:hover),
${PROMPT_STACK_CARD_SELECTOR} > div[role="group"]:not(:hover),
${PROMPT_STACK_CARD_SELECTOR} > div:first-child > button[aria-expanded]:not(:hover),
${PROMPT_STACK_CARD_SELECTOR} > div:first-child > div[aria-label]:not(:hover) {
  background-color: transparent;
}

/* Shared label/value typography and icon-to-text gap across every prompt-stack
   header row: primary labels are 12px medium foreground; secondary values are
   12px regular muted-foreground; multi-line alert headers match the 6px icon gap. */
${PROMPT_STACK_CARD_SELECTOR} > button[aria-expanded] > svg + span:not(:has(span)),
${PROMPT_STACK_CARD_SELECTOR} > button[aria-expanded] > span:has(> svg) + span:not(:has(span)),
${PROMPT_STACK_CARD_SELECTOR} > div:first-child > button[aria-expanded] > svg + span:not(:has(span)),
${PROMPT_STACK_CARD_SELECTOR} > div:first-child > button[aria-expanded] > img + span:not(:has(span)),
${PROMPT_STACK_CARD_SELECTOR} > div:first-child > div[role="status"] > svg + span:not(:has(span)),
${PROMPT_STACK_CARD_SELECTOR} > div:first-child > div[role="status"] > img + span:not(:has(span)),
${PROMPT_STACK_CARD_SELECTOR} > div[role="status"] > svg + span:not(:has(span)),
${PROMPT_STACK_CARD_SELECTOR} > div[role="group"] > button[aria-expanded] > svg + span:not(:has(span)),
${PROMPT_STACK_CARD_SELECTOR} > div:first-child > div[aria-label] > svg + span > span:first-child,
${PROMPT_STACK_CARD_SELECTOR} > div:first-child > button[aria-expanded] > svg + span > span:first-child,
${PROMPT_STACK_CARD_SELECTOR} > button[aria-expanded] > svg + span > span:first-child {
  font-weight: var(--prompt-banner-label-weight);
  color: var(--prompt-banner-label-color);
}

${PROMPT_STACK_CARD_SELECTOR} > div:first-child > div[aria-label] > svg + span > span:nth-child(2) {
  font-weight: var(--prompt-banner-value-weight);
  color: var(--prompt-banner-value-color);
  -webkit-text-fill-color: currentColor;
}

${PROMPT_STACK_CARD_SELECTOR} > div[role="alert"] > div:first-child {
  gap: 0.375rem;
}

/* Collapsed disclosure bodies reserve a 1px transparent border-top on some cards,
   exposing a strip of card fill below the header. Drop it while closed, and draw
   a matching one-device-pixel divider above opaque bodies when open. */
${PROMPT_STACK_CARD_SELECTOR} > section[aria-hidden="true"] {
  border-top-width: 0;
}

${PROMPT_STACK_CARD_SELECTOR} > section[aria-hidden="false"] {
  position: relative;
  border-top-width: 0;
}

${PROMPT_STACK_CARD_SELECTOR} > section[aria-hidden="false"]::before {
  content: "";
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: var(--t3-composer-ring-width);
  background: var(--t3-composer-hairline);
  pointer-events: none;
}
`;

export function mountPromptStackBannerStyle(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};

  const style = document.createElement("style");
  style.setAttribute(MARK, "");
  style.textContent = PROMPT_STACK_BANNER_CSS;
  document.head.append(style);

  const dispose = () => {
    signal.removeEventListener("abort", dispose);
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
