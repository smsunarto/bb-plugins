/**
 * Full HTML keeps its own styling and gains only the Wide-view keyboard bridge,
 * plus a guard so an unhandled form submission cannot navigate the frame away.
 */
function injectWideEscapeBridge(document: Document, token: string) {
  const bridge = document.createElement("script");
  bridge.textContent = `addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const selector of ["dialog:modal", "dialog[open][closedby=closerequest i]", "dialog[open][closedby=any i]", ":popover-open:not([popover=manual i])"]) {
      try { if (document.querySelector(selector)) return; }
      catch { /* Unsupported native features cannot be open. */ }
    }
    setTimeout(() => {
      if (!event.defaultPrevented) parent.postMessage({type:"bb:html:escape",token:${JSON.stringify(token)}}, "*");
    }, 0);
  });
  addEventListener("submit", (event) => { if (!event.defaultPrevented) event.preventDefault(); });`;
  document.head.prepend(bridge);
}

/**
 * Build the frame document for a published page. `prepare` (the fragment
 * runtime) gets the parsed document plus the message token; a full document
 * gains only the Wide-view bridge.
 */
export function prepareFrameDocument(
  html: string,
  prepare?: (document: Document, token: string) => void,
): { html: string; token: string } {
  const document = new DOMParser().parseFromString(html, "text/html");
  const token = crypto.randomUUID();
  (prepare ?? injectWideEscapeBridge)(document, token);
  return { html: `<!doctype html>\n${document.documentElement.outerHTML}`, token };
}
