/**
 * bb mobile's WebView cancels every frame navigation outside the bb origin,
 * `about:srcdoc` included. A prepared preview therefore loads this same-origin
 * page, which writes the document the app sends into itself. The CSP sandbox
 * keeps the page opaque even when it is framed or opened without the iframe's
 * sandbox attribute.
 */
export const PREVIEW_FRAME_PATH = "/frame";
/** The Video.js bundle a fragment with a controlled video inlines. */
export const VIDEO_PLAYER_PATH = "/video-player.js";

export const PREVIEW_FRAME_MESSAGES = {
  ready: "bb:inline-vis:frame-ready",
  document: "bb:inline-vis:document",
} as const;

/**
 * What a framed preview may do, for both the iframe attribute and the page's
 * CSP. Forms submit and downloads save; links and popups go through the host.
 */
export const PREVIEW_FRAME_SANDBOX = "allow-scripts allow-forms allow-downloads";

export const PREVIEW_FRAME_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `sandbox ${PREVIEW_FRAME_SANDBOX}`,
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

export function videoPlayerUrl(pluginId: string): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${VIDEO_PLAYER_PATH}`;
}

export function previewFrameUrl(pluginId: string): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${PREVIEW_FRAME_PATH}`;
}
