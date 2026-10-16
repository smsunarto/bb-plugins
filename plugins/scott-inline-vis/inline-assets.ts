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
/**
 * A fragmented MP4 starts playing before its Blob arrives: its MediaSource
 * type first, then its bytes in order. The Blob still follows as the fallback.
 */
export type InlineAssetChunk = { key: string; stream: string } | { key: string; chunk: Uint8Array };
export type InlineAssetMessage = InlineAssetResult | InlineAssetChunk;

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
      // A stream the decoder rejects falls back to its Blob.
      const stream = [...streams.values()].find((candidate) => candidate.player === player);
      if (stream) return fail(stream);
      if (event.target !== player) {
        if (exhausted(player)) report(player, cannotPlay);
        return;
      }
      const code = player.error?.code;
      report(player, code === 3 || code === 4 ? cannotPlay : "Video playback failed. Reload the preview to try again.");
    }, true);
    player.addEventListener("loadeddata", () => { status.hidden = true; });
  };
  const choosing = (player) =>
    player.networkState === HTMLMediaElement.NETWORK_EMPTY || player.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
  const assets = (key) => [...document.querySelectorAll("[data-bb-inline-preview]")]
    .filter((element) => element.getAttribute("data-bb-inline-preview") === key);
  const fill = (elements, blob) => {
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
      if (url) {
        if (choosing(player)) player.load();
      } else if (!player.querySelector("source") || exhausted(player)) {
        report(player, "Video failed to load.");
      }
    }
  };
  // A fragmented MP4 plays through MediaSource while it downloads. Its Blob
  // still arrives last, and any MediaSource failure falls back to that Blob.
  const MediaSourceType = self.ManagedMediaSource ?? self.MediaSource;
  const streams = new Map();
  const fallback = (stream) => {
    streams.delete(stream.key);
    const { player, elements } = stream;
    const time = player.currentTime;
    const playing = !player.paused;
    // The player still holds the MediaSource, so a filled <source> needs an explicit reload.
    const reload = elements[0] !== player && !choosing(player);
    if (player.srcObject) player.srcObject = null;
    player.removeAttribute("src");
    fill(elements, stream.blob);
    if (reload) player.load();
    if (time > 0) player.addEventListener("loadedmetadata", () => {
      player.currentTime = time;
      if (playing) player.play().catch(() => {});
    }, { once: true });
  };
  const fail = (stream) => {
    stream.failed = true;
    if (stream.blob) fallback(stream);
  };
  const pump = (stream) => {
    const { buffer, source } = stream;
    if (!buffer || buffer.updating || stream.failed || stream.ended) return;
    try {
      if (stream.queue.length > 0) buffer.appendBuffer(stream.queue.shift());
      else if (stream.blob) {
        source.endOfStream();
        stream.ended = true;
      }
    } catch {
      fail(stream);
    }
  };
  const startStream = (key, type) => {
    const elements = assets(key);
    const player = elements[0]?.closest("video");
    // Only a video's sole candidate streams. A choice between candidates waits for their Blobs.
    if (!player || elements.length !== 1 || (elements[0] !== player && player.querySelectorAll("source").length !== 1)) return;
    if (streams.has(key) || !MediaSourceType?.isTypeSupported(type)) return;
    const source = new MediaSourceType();
    const stream = { key, player, elements, source, buffer: null, queue: [], blob: null, ended: false, failed: false };
    streams.set(key, stream);
    source.addEventListener("sourceopen", () => {
      try {
        stream.buffer = source.addSourceBuffer(type);
      } catch {
        return fail(stream);
      }
      stream.buffer.addEventListener("updateend", () => pump(stream));
      stream.buffer.addEventListener("error", () => fail(stream));
      pump(stream);
    }, { once: true });
    // ManagedMediaSource asks for data again after evicting some. The whole file is here by then.
    source.addEventListener("startstreaming", () => { if (stream.ended) fallback(stream); });
    // ManagedMediaSource attaches only without AirPlay, which cannot play this frame's media anyway.
    if (MediaSourceType === self.ManagedMediaSource) player.disableRemotePlayback = true;
    // WebKit rejects MediaSource URLs in an opaque frame but accepts srcObject.
    // Chromium accepts only the URL.
    try {
      player.srcObject = source;
    } catch {
      const url = URL.createObjectURL(source);
      urls.push(url);
      player.src = url + (elements[0].getAttribute("data-bb-inline-preview-hash") ?? "");
    }
  };
  const receive = (message) => {
    const stream = streams.get(message.key);
    if (message.stream) return startStream(message.key, message.stream);
    if (message.chunk) {
      if (stream && !stream.failed) {
        stream.queue.push(message.chunk);
        pump(stream);
      }
      return;
    }
    if (!stream) return fill(assets(message.key), message.blob);
    if (!message.blob) {
      streams.delete(message.key);
      return report(stream.player, "Video failed to load.");
    }
    stream.blob = message.blob;
    // A player that never opened its MediaSource, for example with preload="none", takes the Blob.
    if (stream.failed || !stream.buffer) fallback(stream);
    else pump(stream);
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

/**
 * Read one declared asset through the authenticated app origin. A fragmented
 * MP4 also goes to `onChunk` as it downloads, so the frame can play it early.
 */
export async function fetchInlineAsset(
  asset: InlinePreviewAsset,
  signal: AbortSignal,
  onChunk?: (message: InlineAssetChunk) => void,
): Promise<Blob> {
  const response = await fetch(asset.url, {
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  if (!response.ok)
    throw new Error(`Failed to load asset ${new URL(asset.url).pathname}: HTTP ${response.status}`);
  const type = response.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() ?? "";
  const compatibleType = asset.image
    ? type.startsWith("image/")
    : type.startsWith("video/") || type === "application/ogg";
  if (!compatibleType) {
    void response.body?.cancel();
    throw new Error(`Preview asset has unsupported MIME type: ${type || "unknown"}`);
  }
  if (asset.image || !onChunk || !response.body) return response.blob();
  const chunks: Uint8Array[] = [];
  // Bytes read before the init segment decides whether the file streams.
  let head: Uint8Array | null = new Uint8Array(0);
  let streaming = false;
  const reader = response.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    chunks.push(read.value);
    if (streaming) onChunk({ key: asset.key, chunk: read.value });
    if (!head) continue;
    head = concat(head, read.value);
    const streamType = fragmentedMp4Type(head);
    if (streamType === undefined) continue;
    head = null;
    if (streamType === null) continue;
    streaming = true;
    onChunk({ key: asset.key, stream: streamType });
    for (const chunk of chunks) onChunk({ key: asset.key, chunk });
  }
  return new Blob(chunks as BlobPart[], { type });
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first);
  bytes.set(second, first.length);
  return bytes;
}

type Box = { type: string; start: number; end: number };

/** Boxes that may precede `moov` in a streamable file. */
const PREFIX_BOXES = new Set(["ftyp", "free", "skip", "wide", "pdin", "uuid"]);
const MAX_INIT_BYTES = 4 * 1024 * 1024;

/** The ISO BMFF box at `offset`, undefined when its header is not here yet. */
function boxAt(view: DataView, offset: number): Box | null | undefined {
  if (offset + 8 > view.byteLength) return undefined;
  let size = view.getUint32(offset);
  let start = offset + 8;
  if (size === 1) {
    if (offset + 16 > view.byteLength) return undefined;
    size = Number(view.getBigUint64(offset + 8));
    start = offset + 16;
  }
  const end = size === 0 ? Infinity : offset + size;
  const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4));
  return end < start ? null : { type, start, end };
}

function children(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  for (let offset = start; ;) {
    const box = boxAt(view, offset);
    if (!box || box.end > end) return boxes;
    boxes.push(box);
    offset = box.end;
  }
}

const child = (view: DataView, parent: Box | undefined, type: string, skip = 0) =>
  parent && children(view, parent.start + skip, parent.end).find((box) => box.type === type);

/**
 * The MediaSource type of a fragmented MP4 that MediaSource can play as it
 * downloads, such as `video/mp4; codecs="avc1.640029,mp4a.40.2"`. Null means
 * the file must arrive whole. Undefined means its init segment is not here yet.
 */
export function fragmentedMp4Type(bytes: Uint8Array): string | null | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const more = bytes.length < MAX_INIT_BYTES ? undefined : null;
  try {
    for (let offset = 0; ;) {
      const box = boxAt(view, offset);
      if (box === undefined) return more;
      if (box === null || (offset === 0 && box.type !== "ftyp")) return null;
      if (box.type === "moov") return box.end > bytes.length ? more : moovType(view, box);
      if (!PREFIX_BOXES.has(box.type)) return null;
      offset = box.end;
    }
  } catch {
    // A truncated or malformed box inside a complete moov.
    return null;
  }
}

function moovType(view: DataView, moov: Box): string | null {
  const boxes = children(view, moov.start, moov.end);
  // Only a fragmented file's moov extends into later movie fragments.
  if (!boxes.some((box) => box.type === "mvex")) return null;
  const codecs: string[] = [];
  for (const trak of boxes.filter((box) => box.type === "trak")) {
    const stbl = child(view, child(view, child(view, trak, "mdia"), "minf"), "stbl");
    const stsd = child(view, stbl, "stsd");
    // The full box header and entry count precede the first sample entry.
    const [entry] = stsd ? children(view, stsd.start + 8, stsd.end) : [];
    const codec = entry && sampleCodec(view, entry);
    if (!codec) return null;
    codecs.push(codec);
  }
  return codecs.length > 0 ? `video/mp4; codecs="${codecs.join(",")}"` : null;
}

function sampleCodec(view: DataView, entry: Box): string | null {
  const hex = (offset: number) => view.getUint8(offset).toString(16).padStart(2, "0");
  if (entry.type === "avc1" || entry.type === "avc3") {
    // A visual sample entry's fixed fields take 78 bytes.
    const avcC = child(view, entry, "avcC", 78);
    return avcC
      ? `${entry.type}.${hex(avcC.start + 1)}${hex(avcC.start + 2)}${hex(avcC.start + 3)}`
      : null;
  }
  if (entry.type !== "mp4a") return null;
  // An audio sample entry's fixed fields take 28 bytes, plus more in QuickTime versions 1 and 2.
  const version = view.getUint16(entry.start + 8);
  const esds = child(view, entry, "esds", 28 + (version === 1 ? 16 : version === 2 ? 36 : 0));
  return esds ? audioCodec(view, esds) : null;
}

/** RFC 6381 names AAC by its decoder config: `mp4a.40.<audio object type>`. */
function audioCodec(view: DataView, esds: Box): string | null {
  let offset = esds.start + 4;
  const descriptor = (tag: number) => {
    if (view.getUint8(offset++) !== tag) return false;
    // Each length byte carries 7 bits, and its high bit marks another byte.
    for (let i = 0; i < 4 && view.getUint8(offset++) & 0x80; i++);
    return true;
  };
  if (!descriptor(0x03)) return null;
  const flags = view.getUint8(offset + 2);
  offset += 3;
  if (flags & 0x80) offset += 2;
  if (flags & 0x40) offset += 1 + view.getUint8(offset);
  if (flags & 0x20) offset += 2;
  if (!descriptor(0x04)) return null;
  const objectType = view.getUint8(offset);
  if (objectType !== 0x40) return `mp4a.${objectType.toString(16)}`;
  offset += 13;
  return descriptor(0x05) ? `mp4a.40.${view.getUint8(offset) >> 3}` : "mp4a.40.2";
}
