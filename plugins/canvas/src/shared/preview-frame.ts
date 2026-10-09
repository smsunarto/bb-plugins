/**
 * The page `::html` embeds load before their document arrives. bb mobile's
 * WebView cancels every frame navigation that is not an http(s) URL on the
 * app's origin, so a `srcdoc` frame stays blank there. The frame instead loads
 * this static page from the plugin's own route, asks its parent for the
 * prepared document, and writes it into itself. The route's sandbox CSP keeps
 * the page opaque even when it is opened outside the iframe.
 */
export const PREVIEW_FRAME_PATH = "/frame";

export const PREVIEW_FRAME_URL = `/api/v1/plugins/canvas/http${PREVIEW_FRAME_PATH}`;

export const PREVIEW_FRAME_MESSAGES = {
  ready: "bb:canvas:frame-ready",
  document: "bb:canvas:document",
} as const;

export const PREVIEW_FRAME_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "sandbox allow-scripts",
  "cache-control": "no-store",
};

export const PREVIEW_FRAME_HTML = `<!doctype html><meta charset="utf-8"><script>
addEventListener("message", function load(event) {
  if (event.source !== parent || event.data?.type !== ${JSON.stringify(PREVIEW_FRAME_MESSAGES.document)} || typeof event.data.html !== "string") return;
  removeEventListener("message", load);
  document.open();
  document.write(event.data.html);
  document.close();
});
parent.postMessage({ type: ${JSON.stringify(PREVIEW_FRAME_MESSAGES.ready)} }, "*");
</script>`;
