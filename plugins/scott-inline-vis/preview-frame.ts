/**
 * bb mobile's WebView cancels every frame navigation outside the bb origin,
 * `about:srcdoc` included. A prepared preview therefore loads this same-origin
 * page, which writes the document the app sends into itself. The CSP sandbox
 * keeps the page opaque even when it is framed or opened without the iframe's
 * sandbox attribute.
 */
export const PREVIEW_FRAME_PATH = "/frame";

export const PREVIEW_FRAME_MESSAGES = {
  ready: "bb:inline-vis:frame-ready",
  document: "bb:inline-vis:document",
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

export function previewFrameUrl(pluginId: string): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${PREVIEW_FRAME_PATH}`;
}
