const BODY = "#thread-prompt-banner-child-threads-body";
const CARD = `[data-promptbox-shell] section:has(> ${BODY})`;

const CSS = `
/* Draw the card's outline above the full-width toggle and opaque body fills. */
${CARD} {
  position: relative;
  box-shadow: none;
}
${CARD}::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 var(--t3-composer-ring-width) var(--t3-composer-hairline);
  pointer-events: none;
}

/* The reserved divider exposes a strip of card fill below the closed toggle. */
${CARD} > ${BODY}[aria-hidden="true"] {
  border-top-width: 0;
}
`;

export function mountChildThreadsBannerStyle(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};

  const style = document.createElement("style");
  style.setAttribute("data-t3-child-threads-banner-style", "");
  style.textContent = CSS;
  document.head.append(style);

  const dispose = () => {
    signal.removeEventListener("abort", dispose);
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
