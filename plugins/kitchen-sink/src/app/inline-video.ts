/** Preserve the owning thread's authenticated, root-confined workspace route. */
export function buildWorktreePreviewUrl(threadId: string, file: string): string {
  const encodedFile = file.split("/").map(encodeURIComponent).join("/");
  return `/api/v1/threads/${encodeURIComponent(threadId)}/worktree/files/${encodedFile}`;
}

export function resolveWorkspaceVideoUrl(src: string, documentUrl: URL, rootUrl: URL): URL | null {
  const value = src.trim();
  // Remote/data/blob URLs and root-relative URLs retain their existing browser behavior.
  if (!value || /^[a-z][a-z\d+.-]*:|^[/#]/iu.test(value)) return null;
  if (value.includes("\\")) throw new Error("Relative video paths must use forward slashes.");
  const url = new URL(value, documentUrl);
  if (url.origin !== rootUrl.origin || !url.pathname.startsWith(rootUrl.pathname)) {
    throw new Error(`Video path escapes the workspace: ${src}`);
  }
  const segments = url.pathname.slice(rootUrl.pathname.length).split("/").map(decodeURIComponent);
  if (segments.some((segment) => segment === ".." || /[\\/\0]/u.test(segment))) {
    throw new Error(`Invalid relative video path: ${src}`);
  }
  return url;
}

/**
 * An opaque iframe cannot send Connect's SameSite session cookie for subresources.
 * Fetch only declared workspace videos in the app, then send the iframe only those Blobs.
 * The server still chooses the thread host and enforces realpath containment and size.
 */
export interface InlineVideoAsset {
  key: string;
  blob: Blob;
  hash: string;
}

// Blob URLs are storage-partitioned. Create them inside the opaque frame from
// structured-cloned Blobs, never in the authenticated parent origin.
export const INLINE_VIDEO_MESSAGE = "bb:inline-video-assets";
const VIDEO_ATTRIBUTE = "data-bb-inline-video";
const VIDEO_BRIDGE = `(() => {
  const token = "BB_VIDEO_TOKEN";
  const urls = [];
  let received = false;
  addEventListener("message", (event) => {
    if (event.source !== parent || received || event.data?.type !== "bb:inline-video-assets" || event.data.token !== token) return;
    received = true;
    const players = new Set();
    for (const asset of event.data.assets) {
      const url = URL.createObjectURL(asset.blob);
      urls.push(url);
      for (const element of document.querySelectorAll("[data-bb-inline-video]")) {
        if (element.getAttribute("data-bb-inline-video") !== asset.key) continue;
        element.src = url + asset.hash;
        element.removeAttribute("data-bb-inline-video");
        const player = element.closest("video");
        if (player) players.add(player);
      }
    }
    for (const player of players) {
      // Media errors do not bubble. Report them next to the affected player,
      // including failures that only occur on a device's hardware decoder.
      const error = document.createElement("p");
      error.setAttribute("role", "alert");
      error.style.cssText = "position:fixed;inset:auto 0 0;margin:0;padding:12px;background:Canvas;color:CanvasText;z-index:2147483647;font:14px system-ui";
      error.hidden = true;
      player.after(error);
      player.addEventListener("error", () => {
        const code = player.error?.code;
        error.textContent = code === 3 || code === 4
          ? "This browser cannot play this video. Try a compatible MP4 copy."
          : "Video playback failed. Reload the preview to try again.";
        error.hidden = false;
      });
      player.addEventListener("loadeddata", () => { error.hidden = true; });
      player.load();
    }
  });
  addEventListener("DOMContentLoaded", () => parent.postMessage({ type: "bb:inline-video-ready", token }, "*"));
  addEventListener("pagehide", () => { for (const url of urls) URL.revokeObjectURL(url); });
})();`;

export async function prepareInlineVideos(
  html: string,
  threadId: string,
  file: string,
  signal: AbortSignal,
): Promise<{ srcDoc?: string; assets: InlineVideoAsset[]; token?: string }> {
  const documentUrl = new URL(buildWorktreePreviewUrl(threadId, file), window.location.href);
  const rootUrl = new URL(buildWorktreePreviewUrl(threadId, ""), documentUrl);
  const document = new DOMParser().parseFromString(html, "text/html");
  const declaredBase = document.querySelector("base[href]");
  const assetBase = new URL(declaredBase?.getAttribute("href") ?? documentUrl.href, documentUrl);
  // An explicit external base belongs to the artifact, not the workspace loader.
  if (assetBase.origin !== rootUrl.origin || !assetBase.pathname.startsWith(rootUrl.pathname)) {
    return { assets: [] };
  }
  const sources = [...document.querySelectorAll("video[src], video source[src]")];
  const videos = sources.flatMap((element) => {
    const url = resolveWorkspaceVideoUrl(element.getAttribute("src")!, assetBase, rootUrl);
    return url ? [{ element, url }] : [];
  });
  if (videos.length === 0) return { assets: [] };
  const blobs = new Map<string, Blob>();
  const assets: InlineVideoAsset[] = [];
  // Sequential reads keep peak transport memory bounded to one asset at a time.
  for (const { element, url } of videos) {
    signal.throwIfAborted();
    const hash = url.hash;
    url.hash = "";
    let blob = blobs.get(url.href);
    if (!blob) {
      const response = await fetch(url, { credentials: "same-origin", redirect: "error", signal });
      if (!response.ok)
        throw new Error(`Failed to load video ${url.pathname}: HTTP ${response.status}`);
      blob = await response.blob();
      signal.throwIfAborted();
      if (!blob.type.startsWith("video/") && blob.type !== "application/ogg") {
        throw new Error(`Workspace video has unsupported MIME type: ${blob.type || "unknown"}`);
      }
      blobs.set(url.href, blob);
    }
    const key = String(assets.length);
    assets.push({ key, blob, hash });
    element.removeAttribute("src");
    element.setAttribute(VIDEO_ATTRIBUTE, key);
  }
  // srcdoc otherwise inherits the app URL. Keep other relative assets at the HTML directory.
  const base = document.createElement("base");
  base.href = assetBase.href;
  document.head.prepend(base);
  const bridge = document.createElement("script");
  const token = crypto.randomUUID();
  bridge.textContent = VIDEO_BRIDGE.replace("BB_VIDEO_TOKEN", token);
  document.head.prepend(bridge);
  return { srcDoc: `<!doctype html>\n${document.documentElement.outerHTML}`, assets, token };
}
