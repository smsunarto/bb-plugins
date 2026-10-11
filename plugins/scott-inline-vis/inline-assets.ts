export function resolvePreviewAssetUrl(src: string, documentUrl: URL, rootUrl: URL): URL | null {
  const value = src.trim();
  // Remote/data/blob URLs and root-relative URLs retain their existing browser behavior.
  if (!value || /^[a-z][a-z\d+.-]*:|^[/#]/iu.test(value)) return null;
  if (value.includes("\\")) throw new Error("Relative asset paths must use forward slashes.");
  const url = new URL(value, documentUrl);
  if (url.origin !== rootUrl.origin || !url.pathname.startsWith(rootUrl.pathname)) {
    throw new Error(`Asset path escapes the preview directory: ${src}`);
  }
  const segments = url.pathname.slice(rootUrl.pathname.length).split("/").map(decodeURIComponent);
  if (segments.some((segment) => segment === ".." || /[\\/\0]/u.test(segment))) {
    throw new Error(`Invalid relative asset path: ${src}`);
  }
  return url;
}

/**
 * An opaque iframe cannot send Connect's SameSite session cookie for subresources.
 * Fetch only declared local images and videos in the app, then send the iframe only those Blobs.
 * The server still chooses the host and enforces realpath containment and size.
 */
export interface InlinePreviewAsset {
  key: string;
  url: string;
  image: boolean;
}

/** One asset's outcome, sent to the frame as soon as it settles. */
export type InlineAssetResult = { key: string; blob: Blob } | { key: string; failed: true };

// Blob URLs are storage-partitioned. Create them inside the opaque frame from
// structured-cloned Blobs, never in the authenticated parent origin. Results
// travel over a port the frame document creates, so they die with that
// document instead of following the frame window to wherever it navigates.
export const INLINE_ASSET_READY = "bb:inline-preview-ready";
const ASSET_ATTRIBUTE = "data-bb-inline-preview";
const HASH_ATTRIBUTE = "data-bb-inline-preview-hash";
const ASSET_BRIDGE = `(() => {
  const token = "BB_ASSET_TOKEN";
  const urls = [];
  const statuses = new Map();
  const cannotPlay = "This browser cannot play this video. Try a compatible MP4 copy.";
  const report = (player, text) => {
    const status = statuses.get(player);
    status.setAttribute("role", "alert");
    status.textContent = text;
    status.hidden = false;
  };
  // Every candidate has arrived, the browser tried them all, and none loaded.
  const exhausted = (player) =>
    !player.querySelector("[data-bb-inline-preview]") &&
    player.networkState === HTMLMediaElement.NETWORK_NO_SOURCE &&
    player.readyState === HTMLMediaElement.HAVE_NOTHING;
  const watch = (player) => {
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.style.cssText = "position:fixed;inset:auto 0 0;margin:0;padding:12px;background:Canvas;color:CanvasText;z-index:2147483647;font:14px system-ui";
    status.textContent = "Loading video…";
    player.after(status);
    statuses.set(player, status);
    // Media errors do not bubble. Capture sees the player's own error and each
    // <source> candidate's, including failures only a device's decoder hits.
    player.addEventListener("error", (event) => {
      if (event.target !== player) {
        if (exhausted(player)) report(player, cannotPlay);
        return;
      }
      const code = player.error?.code;
      report(player, code === 3 || code === 4 ? cannotPlay : "Video playback failed. Reload the preview to try again.");
    }, true);
    player.addEventListener("loadeddata", () => { status.hidden = true; });
  };
  const receive = ({ key, blob }) => {
    const elements = [...document.querySelectorAll("[data-bb-inline-preview]")]
      .filter((element) => element.getAttribute("data-bb-inline-preview") === key);
    if (elements.length === 0) return;
    const url = blob ? URL.createObjectURL(blob) : null;
    if (url) urls.push(url);
    const players = new Set();
    for (const element of elements) {
      if (url) element.src = url + (element.getAttribute("data-bb-inline-preview-hash") ?? "");
      element.removeAttribute("data-bb-inline-preview");
      element.removeAttribute("data-bb-inline-preview-hash");
      const player = element.closest("video");
      if (player) players.add(player);
    }
    for (const player of players) {
      // A late <source> must not restart a player that already chose another.
      const choosing = player.networkState === HTMLMediaElement.NETWORK_EMPTY || player.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
      if (url) {
        if (choosing) player.load();
      } else if (!player.querySelector("source") || exhausted(player)) {
        report(player, "Video failed to load.");
      }
    }
  };
  addEventListener("DOMContentLoaded", () => {
    for (const element of document.querySelectorAll("[data-bb-inline-preview]")) {
      const player = element.closest("video");
      if (player && !statuses.has(player)) watch(player);
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => receive(event.data);
    parent.postMessage({ type: "bb:inline-preview-ready", token }, "*", [channel.port2]);
  });
  addEventListener("pagehide", () => { for (const url of urls) URL.revokeObjectURL(url); });
})();`;

/** Full HTML keeps its own styling and gains only the Wide-view keyboard bridge. */
export function injectWideEscapeBridge(document: Document, token: string) {
  const bridge = document.createElement("script");
  bridge.textContent = `addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const selector of ["dialog:modal", "dialog[open][closedby=closerequest i]", "dialog[open][closedby=any i]", ":popover-open:not([popover=manual i])"]) {
      try { if (document.querySelector(selector)) return; }
      catch { /* Unsupported native features cannot be open. */ }
    }
    setTimeout(() => {
      if (!event.defaultPrevented) parent.postMessage({type:"bb:inline-vis:escape",token:${JSON.stringify(token)}}, "*");
    }, 0);
  });`;
  document.head.prepend(bridge);
}

/**
 * Build the frame document. Local media becomes keyed placeholders that the
 * frame fills from `fetchInlineAsset` Blobs, so the document renders before
 * any media arrives. `prepare` (the fragment runtime) gets the parsed document
 * plus the message token. Without either, the caller loads the leased URL directly.
 */
export function prepareInlineAssets(
  html: string,
  previewUrl: string,
  prepare?: (document: Document, token: string) => void,
): { html?: string; assets: InlinePreviewAsset[]; token?: string } {
  const documentUrl = new URL(previewUrl, window.location.href);
  const rootUrl = new URL("./", documentUrl);
  const document = new DOMParser().parseFromString(html, "text/html");
  const declaredBase = document.querySelector("base[href]");
  const assetBase = new URL(declaredBase?.getAttribute("href") ?? documentUrl.href, documentUrl);
  // An explicit external base belongs to the artifact, not the preview loader.
  const localBase =
    assetBase.origin === rootUrl.origin && assetBase.pathname.startsWith(rootUrl.pathname);
  const sources = localBase
    ? [...document.querySelectorAll("img[src], video[src], video source[src]")]
    : [];
  const media = sources.flatMap((element) => {
    const url = resolvePreviewAssetUrl(element.getAttribute("src")!, assetBase, rootUrl);
    return url ? [{ element, url }] : [];
  });
  if (media.length === 0 && !prepare) return { assets: [] };
  const assets = new Map<string, InlinePreviewAsset>();
  for (const { element, url } of media) {
    const hash = url.hash;
    url.hash = "";
    const image = element.tagName === "IMG";
    const id = `${image}:${url.href}`;
    const asset = assets.get(id) ?? { key: String(assets.size), url: url.href, image };
    assets.set(id, asset);
    element.removeAttribute("src");
    element.setAttribute(ASSET_ATTRIBUTE, asset.key);
    if (hash) element.setAttribute(HASH_ATTRIBUTE, hash);
  }
  const token = crypto.randomUUID();
  (prepare ?? injectWideEscapeBridge)(document, token);
  if (assets.size > 0) {
    const bridge = document.createElement("script");
    bridge.textContent = ASSET_BRIDGE.replace("BB_ASSET_TOKEN", token);
    document.head.prepend(bridge);
  }
  if (localBase) {
    // The frame page's URL is the plugin route. Keep other relative assets at the HTML directory.
    const base = document.createElement("base");
    base.href = assetBase.href;
    document.head.prepend(base);
  }
  return {
    html: `<!doctype html>\n${document.documentElement.outerHTML}`,
    assets: [...assets.values()],
    token,
  };
}

/** Read one declared asset through the authenticated app origin. */
export async function fetchInlineAsset(
  asset: InlinePreviewAsset,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(asset.url, {
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  if (!response.ok)
    throw new Error(`Failed to load asset ${new URL(asset.url).pathname}: HTTP ${response.status}`);
  const blob = await response.blob();
  const compatibleType = asset.image
    ? blob.type.startsWith("image/")
    : blob.type.startsWith("video/") || blob.type === "application/ogg";
  if (!compatibleType) {
    throw new Error(`Preview asset has unsupported MIME type: ${blob.type || "unknown"}`);
  }
  return blob;
}
