import {
  AppendOnlyStreamTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  ReadableStreamSource,
  type EncodedPacket,
  type InputTrack,
} from "mediabunny";

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
  /** Relative to the preview directory, so it outlives the lease in `url`. */
  path: string;
  image: boolean;
}

export type VideoSize = { width: number; height: number };

/** One asset's outcome, sent to the frame as soon as it settles. */
export type InlineAssetResult = { key: string; blob: Blob } | { key: string; failed: true };
/**
 * A video starts playing before its Blob arrives: its display size as soon as
 * its index is read, the MediaSource type of its fragmented MP4 copy, then
 * that copy's bytes in order, or a failure part way. The Blob still follows
 * as the fallback.
 */
export type InlineAssetChunk =
  | { key: string; size: VideoSize }
  | { key: string; stream: string }
  | { key: string; chunk: Uint8Array }
  | { key: string; streamFailed: true };
export type InlineAssetMessage = InlineAssetResult | InlineAssetChunk;

// Blob URLs are storage-partitioned. Create them inside the opaque frame from
// structured-cloned Blobs, never in the authenticated parent origin. Results
// travel over a port the frame document creates, so they die with that
// document instead of following the frame window to wherever it navigates.
export const INLINE_ASSET_READY = "bb:inline-preview-ready";
const ASSET_ATTRIBUTE = "data-bb-inline-preview";
const HASH_ATTRIBUTE = "data-bb-inline-preview-hash";
const RATIO_ATTRIBUTE = "data-bb-inline-preview-ratio";
const RATIO_PROPERTY = "--bb-inline-preview-ratio";
// Zero specificity, so any author rule on the player wins, however late it loads.
const RATIO_STYLE = `:where(video[${RATIO_ATTRIBUTE}]) { aspect-ratio: var(${RATIO_PROPERTY}); }`;
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
  // A held player's box follows the size the app or the decoder reports.
  // Once a player decodes a source, that source's size wins over any
  // candidate's reported size, including one it never plays.
  const decoded = new WeakSet();
  const shape = (player, width, height) => {
    if (player.hasAttribute("${RATIO_ATTRIBUTE}") && width > 0 && height > 0)
      player.style.setProperty("${RATIO_PROPERTY}", width + " / " + height);
  };
  const watch = (player) => {
    // Keep the decoded ratio, so a fallback from the stream to the Blob, which
    // empties the player for a moment, holds the box too.
    player.addEventListener("loadedmetadata", () => {
      decoded.add(player);
      shape(player, player.videoWidth, player.videoHeight);
    });
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.style.cssText = "position:fixed;inset:auto 0 0;margin:0;padding:12px;background:Canvas;color:CanvasText;z-index:2147483647;font:14px system-ui";
    status.textContent = "Loading video…";
    // A skinned player's control bar sits at the bottom, so the bar moves to the top.
    if (player.closest("video-skin")) status.style.inset = "0 0 auto";
    (player.closest("video-player") ?? player).after(status);
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
  // A video plays its fragmented MP4 copy through MediaSource while it
  // downloads. Its Blob arrives last, and any failure falls back to that Blob.
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
    if (message.size) {
      for (const element of assets(message.key)) {
        const player = element.closest("video");
        if (player && !decoded.has(player)) shape(player, message.size.width, message.size.height);
      }
      return;
    }
    if (message.stream) return startStream(message.key, message.stream);
    if (message.streamFailed) return stream && fail(stream);
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
 * `videoSize` returns a size seen before for a video path relative to the
 * preview directory, so its player starts at that size.
 */
export function prepareInlineAssets(
  html: string,
  previewUrl: string,
  prepare?: (document: Document, token: string) => void,
  videoSize?: (path: string) => VideoSize | undefined,
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
    const asset = assets.get(id) ?? {
      key: String(assets.size),
      url: url.href,
      path: url.href.slice(rootUrl.href.length),
      image,
    };
    assets.set(id, asset);
    element.removeAttribute("src");
    element.setAttribute(ASSET_ATTRIBUTE, asset.key);
    if (hash) element.setAttribute(HASH_ATTRIBUTE, hash);
    if (!image) holdVideoBox(element.closest("video")!, videoSize?.(asset.path));
  }
  const token = crypto.randomUUID();
  (prepare ?? injectWideEscapeBridge)(document, token);
  if (assets.size > 0) {
    const bridge = document.createElement("script");
    bridge.textContent = ASSET_BRIDGE.replace("BB_ASSET_TOKEN", token);
    document.head.prepend(bridge);
  }
  if (document.querySelector(`video[${RATIO_ATTRIBUTE}]`)) {
    const style = document.createElement("style");
    style.textContent = RATIO_STYLE;
    document.head.prepend(style);
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
 * A <video> without metadata is 150px tall at any width, then jumps to its
 * real height. Hold the size the app saw before, or 16:9, the usual recording
 * shape, until the app or the decoder reports the real size. Width and height
 * attributes and a poster already size the box, so those players keep theirs.
 */
function holdVideoBox(player: HTMLVideoElement, size: VideoSize | undefined) {
  if (["width", "height", "poster"].some((name) => player.hasAttribute(name))) return;
  player.setAttribute(RATIO_ATTRIBUTE, "");
  player.style.setProperty(RATIO_PROPERTY, size ? `${size.width} / ${size.height}` : "16 / 9");
}

/**
 * Read one declared asset through the authenticated app origin. A video also
 * goes to `onChunk` as fragmented MP4 while it downloads, so the frame can
 * play it early. Its Blob arrives only after the stream ends or fails.
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
  const [download, remux] = response.body.tee();
  const streaming = streamFragments(remux, (message) => onChunk({ key: asset.key, ...message }));
  const blob = await new Response(download).blob();
  await streaming;
  return blob.slice(0, blob.size, type);
}

type StreamMessage =
  | { size: VideoSize }
  | { stream: string }
  | { chunk: Uint8Array }
  | { streamFailed: true };

/**
 * Rewrap an MP4 or QuickTime video as fragmented MP4 while it downloads,
 * copying its encoded packets. A file whose index trails its media starts
 * only once whole. Never rejects: other files simply wait for their Blob.
 */
async function streamFragments(
  bytes: ReadableStream<Uint8Array>,
  send: (message: StreamMessage) => void,
): Promise<void> {
  const input = new Input({
    source: new ReadableStreamSource(bytes, { handleUnhandledError: () => {} }),
    formats: [MP4, QTFF],
  });
  // Fragments wait until the MIME type, which needs each track's first packet, is known.
  let pending: Uint8Array[] | null = [];
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "fragmented" }),
    target: new AppendOnlyStreamTarget(
      new WritableStream({
        write: (chunk) => (pending ? void pending.push(chunk) : send({ chunk })),
      }),
    ),
  });
  try {
    const tracks = await input.getTracks();
    // The frame sizes the player from this before any media plays.
    const video = await input.getPrimaryVideoTrack();
    if (video) {
      const [width, height] = await Promise.all([
        video.getDisplayWidth(),
        video.getDisplayHeight(),
      ]);
      send({ size: { width, height } });
    }
    const copies = await Promise.all(tracks.map((track) => addCopy(output, track)));
    await output.start();
    const announce = async () => {
      const stream = await output.getMimeType();
      if (!pending) return;
      send({ stream });
      for (const chunk of pending) send({ chunk });
      pending = null;
    };
    void announce().catch(() => {});
    await Promise.all(copies.map((copy) => copy?.()));
    await output.finalize();
  } catch {
    // Before the MIME type, the frame has nothing to undo and waits for the Blob.
    if (!pending) send({ streamFailed: true });
    pending = null;
    void output.cancel();
  } finally {
    // Stop reading, so the tee stops buffering this branch.
    input.dispose();
  }
}

/** Add a track that copies `track`'s packets, and return the copy to run once the output starts. */
async function addCopy(output: Output, track: InputTrack): Promise<(() => Promise<void>) | null> {
  if (track.isVideoTrack()) {
    if (!track.codec) throw new Error("Unknown video codec");
    const source = new EncodedVideoPacketSource(track.codec);
    output.addVideoTrack(source, { rotation: await track.getRotation() });
    const decoderConfig = (await track.getDecoderConfig()) ?? undefined;
    return () =>
      copyPackets(track, source, (packet, first) =>
        source.add(packet, first ? { decoderConfig } : undefined),
      );
  }
  if (track.isAudioTrack()) {
    if (!track.codec) throw new Error("Unknown audio codec");
    const source = new EncodedAudioPacketSource(track.codec);
    output.addAudioTrack(source);
    const decoderConfig = (await track.getDecoderConfig()) ?? undefined;
    return () =>
      copyPackets(track, source, (packet, first) =>
        source.add(packet, first ? { decoderConfig } : undefined),
      );
  }
  return null;
}

async function copyPackets(
  track: InputTrack,
  source: { close(): void },
  add: (packet: EncodedPacket, first: boolean) => Promise<void>,
) {
  let first = true;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    await add(packet, first);
    first = false;
  }
  source.close();
}
