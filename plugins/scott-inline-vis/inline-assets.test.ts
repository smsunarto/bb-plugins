// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchInlineAsset,
  type InlineAssetChunk,
  injectWideEscapeBridge,
  prepareInlineAssets,
  resolvePreviewAssetUrl,
} from "./inline-assets.ts";
import { BufferSource, EncodedPacketSink, Input, MP4 } from "mediabunny";
import { chunkedResponse, mp4File, STREAM_TYPE } from "./mp4-fixture.ts";

afterEach(() => vi.restoreAllMocks());
const text = (value: string) => new TextEncoder().encode(value);
const root = new URL("https://scott.getbb.app/api/v1/file-previews/lease/");
const documentUrl = new URL("player.html", root);

describe("relative preview asset URLs", () => {
  test("preserves the thread route, artifact directory, encoded filenames, and fragments", () => {
    expect(resolvePreviewAssetUrl("media/detail%20clip.mp4#t=4", documentUrl, root)?.href).toBe(
      `${root.href}media/detail%20clip.mp4#t=4`,
    );
    expect(resolvePreviewAssetUrl("clip%20%231.mp4", documentUrl, root)?.pathname).toMatch(
      /\/clip%20%231\.mp4$/,
    );
  });

  test.each([
    "../../../outside.mp4",
    "%2e%2e/%2e%2e/%2e%2e/outside.mp4",
    "..%2foutside.mp4",
    "a%5cb.mp4",
    "a%00b.mp4",
    "..\\outside.mp4",
  ])("rejects traversal and ambiguous path %s", (src) => {
    expect(() => resolvePreviewAssetUrl(src, documentUrl, root)).toThrow();
  });

  test.each([
    "data:video/mp4;base64,AAAA",
    "https://example.com/clip.mp4",
    "blob:https://example.com/id",
    "//example.com/clip.mp4",
    "/clip.mp4",
    "#fragment",
  ])("preserves existing non-relative URL %s", (src) => {
    expect(resolvePreviewAssetUrl(src, documentUrl, root)).toBeNull();
  });
});

function transport() {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("video", { headers: { "content-type": "video/mp4" } }));
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:https://scott.getbb.app/test");
  return { fetch, create };
}

test("marks local video and source src once without fetching or serializing video into HTML", () => {
  const { fetch, create } = transport();
  const result = prepareInlineAssets(
    '<video src="./media/a.mp4#t=2"></video><video><source src="media/a.mp4"></video><video src="data:video/mp4;base64,AAAA"></video>',
    documentUrl.href,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(result.assets).toEqual([{ key: "0", url: `${root.href}media/a.mp4`, image: false }]);
  const doc = new DOMParser().parseFromString(result.html!, "text/html");
  expect(doc.querySelector("base")?.href).toMatch(/\/file-previews\/lease\/player\.html$/);
  const [first, second, data] = doc.querySelectorAll("video");
  expect(first?.hasAttribute("src")).toBe(false);
  expect(first?.getAttribute("data-bb-inline-preview")).toBe("0");
  expect(first?.getAttribute("data-bb-inline-preview-hash")).toBe("#t=2");
  expect(second?.querySelector("source")?.hasAttribute("src")).toBe(false);
  expect(second?.querySelector("source")?.getAttribute("data-bb-inline-preview")).toBe("0");
  expect(data?.src).toBe("data:video/mp4;base64,AAAA");
  expect(result.token).toBeTruthy();
  expect(create).not.toHaveBeenCalled();
});

test("reads an asset through the authenticated preview boundary", async () => {
  const { fetch, create } = transport();
  const signal = new AbortController().signal;
  const [asset] = prepareInlineAssets('<video src="clip.mp4"></video>', documentUrl.href).assets;
  const blob = await fetchInlineAsset(asset!, signal);
  expect(String(fetch.mock.calls[0]![0])).toBe(`${root.href}clip.mp4`);
  expect(fetch.mock.calls[0]![1]).toEqual({
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  expect(await blob.text()).toBe("video");
  expect(create).not.toHaveBeenCalled();
});

test("does not rewrite HTML containing only existing data or remote embeds", () => {
  const result = prepareInlineAssets(
    '<video src="data:video/mp4;base64,AAAA"></video>',
    documentUrl.href,
  );
  expect(result).toEqual({ assets: [] });
});

test("surfaces root confinement errors without creating a parent-origin blob URL", async () => {
  const { fetch, create } = transport();
  fetch.mockResolvedValueOnce(new Response("symlink escapes read root", { status: 400 }));
  const [asset] = prepareInlineAssets(
    '<video src="outside-symlink.mp4"></video>',
    documentUrl.href,
  ).assets;
  await expect(fetchInlineAsset(asset!, new AbortController().signal)).rejects.toThrow(
    "Failed to load asset /api/v1/file-previews/lease/outside-symlink.mp4: HTTP 400",
  );
  expect(create).not.toHaveBeenCalled();
});

test("rejects an authentication HTML response instead of treating it as a video", async () => {
  const { fetch, create } = transport();
  fetch.mockResolvedValueOnce(new Response("login", { headers: { "content-type": "text/html" } }));
  const [asset] = prepareInlineAssets('<video src="a.mp4"></video>', documentUrl.href).assets;
  await expect(fetchInlineAsset(asset!, new AbortController().signal)).rejects.toThrow(
    "unsupported MIME type: text/html",
  );
  expect(create).not.toHaveBeenCalled();
});

test("honors an explicit local base and leaves remote-base embeds alone", () => {
  const local = prepareInlineAssets(
    '<base href="media/"><video src="a.mp4"></video>',
    documentUrl.href,
  );
  expect(local.assets).toEqual([{ key: "0", url: `${root.href}media/a.mp4`, image: false }]);
  const remote = prepareInlineAssets(
    '<base href="https://example.com/"><video src="a.mp4"></video>',
    documentUrl.href,
  );
  expect(remote).toEqual({ assets: [] });
});

/** Chromium attaches a MediaSource only by URL. WebKit, in an opaque frame, only by srcObject. */
async function frame(
  html: string,
  mediaSource?: unknown,
  engine: "chromium" | "webkit" = "chromium",
) {
  const { JSDOM } = await import("jsdom");
  const result = prepareInlineAssets(html, documentUrl.href);
  let blobs = 0;
  const port = { onmessage: null as ((event: { data: unknown }) => void) | null };
  const load = vi.fn();
  const dom = new JSDOM(result.html!, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.URL.createObjectURL = vi.fn(() => `blob:null/${++blobs}`);
      window.HTMLMediaElement.prototype.load = load;
      Object.assign(window, { MediaSource: mediaSource });
      const attached = new WeakMap<object, unknown>();
      Object.defineProperty(window.HTMLMediaElement.prototype, "srcObject", {
        get() {
          return attached.get(this) ?? null;
        },
        set(value: unknown) {
          if (value !== null && engine === "chromium") throw new TypeError("Not a MediaStream");
          attached.set(this, value);
        },
      });
      // jsdom has no MessageChannel. The parent end only needs a transferable marker.
      Object.assign(window, {
        MessageChannel: class {
          port1 = port;
          port2 = "frame-port";
        },
      });
    },
  });
  const win = dom.window;
  const ready = vi.fn();
  win.parent.postMessage = ready;
  win.document.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
  const deliver = (data: Record<string, unknown>) => port.onmessage!({ data });
  const status = () => win.document.querySelector("video + p") as HTMLParagraphElement;
  const media = (element: Element, networkState: number, readyState: number) => {
    Object.defineProperty(element, "networkState", { value: networkState, configurable: true });
    Object.defineProperty(element, "readyState", { value: readyState, configurable: true });
  };
  return { win, deliver, ready, status, media, load, token: result.token };
}

const NETWORK_IDLE = 1;
const NETWORK_NO_SOURCE = 3;
const HAVE_NOTHING = 0;
const HAVE_ENOUGH_DATA = 4;

test("shows a loading video and fills each asset as it arrives over the frame's port", async () => {
  const { win, deliver, ready, status, token } = await frame(
    '<img src="before.png"><video src="clip.mp4#t=2"></video>',
  );
  expect(ready).toHaveBeenCalledWith({ type: "bb:inline-preview-ready", token }, "*", [
    "frame-port",
  ]);
  expect(status().hidden).toBe(false);
  expect(status().textContent).toBe("Loading video…");
  deliver({ key: "1", blob: new win.Blob(["video"]) });
  expect(win.document.querySelector("video")?.getAttribute("src")).toBe("blob:null/1#t=2");
  expect(win.document.querySelector("img")?.hasAttribute("src")).toBe(false);
  deliver({ key: "0", blob: new win.Blob(["image"]) });
  expect(win.document.querySelector("img")?.getAttribute("src")).toBe("blob:null/2");
  // A repeated delivery cannot replace a filled asset.
  deliver({ key: "0", blob: new win.Blob(["again"]) });
  expect(win.document.querySelector("img")?.getAttribute("src")).toBe("blob:null/2");
  win.document.querySelector("video")!.dispatchEvent(new win.Event("loadeddata"));
  expect(status().hidden).toBe(true);
  win.close();
});

test("ignores asset messages that do not arrive on the frame's own port", async () => {
  const { win, token } = await frame('<img src="before.png">');
  win.dispatchEvent(
    new win.MessageEvent("message", {
      source: win as unknown as Window,
      data: { type: "bb:inline-preview-assets", token, key: "0", blob: new win.Blob(["x"]) },
    }),
  );
  expect(win.document.querySelector("img")?.hasAttribute("src")).toBe(false);
  win.close();
});

test("a late alternate source does not restart a player that already chose one", async () => {
  const { win, deliver, media, load } = await frame(
    '<video><source src="clip.webm" type="video/webm"><source src="clip.mp4"></video>',
  );
  const video = win.document.querySelector("video")!;
  media(video, NETWORK_NO_SOURCE, HAVE_NOTHING);
  deliver({ key: "1", blob: new win.Blob(["mp4"]) });
  expect(load).toHaveBeenCalledTimes(1);
  media(video, NETWORK_IDLE, HAVE_ENOUGH_DATA);
  deliver({ key: "0", blob: new win.Blob(["webm"]) });
  expect(load).toHaveBeenCalledTimes(1);
  expect(video.querySelector("source")?.getAttribute("src")).toBe("blob:null/2");
  win.close();
});

test("reports a source the browser cannot play only after every candidate fails", async () => {
  const { win, deliver, media, status } = await frame(
    '<video><source src="clip.webm"><source src="clip.mp4"></video>',
  );
  const video = win.document.querySelector("video")!;
  const [webm, mp4] = video.querySelectorAll("source");
  media(video, NETWORK_NO_SOURCE, HAVE_NOTHING);
  deliver({ key: "0", blob: new win.Blob(["webm"]) });
  webm!.dispatchEvent(new win.Event("error"));
  // The second candidate is still downloading.
  expect(status().textContent).toBe("Loading video…");
  deliver({ key: "1", blob: new win.Blob(["corrupt"]) });
  mp4!.dispatchEvent(new win.Event("error"));
  expect(status().getAttribute("role")).toBe("alert");
  expect(status().textContent).toBe(
    "This browser cannot play this video. Try a compatible MP4 copy.",
  );
  win.close();
});

test("reports a failed download and decoder failures inside the opaque frame", async () => {
  const failed = await frame('<video src="clip.mp4"></video>');
  failed.deliver({ key: "0", failed: true });
  expect(failed.status().getAttribute("role")).toBe("alert");
  expect(failed.status().textContent).toBe("Video failed to load.");
  failed.win.close();

  const sources = await frame('<video><source src="a.webm"><source src="b.mp4"></video>');
  sources.media(sources.win.document.querySelector("video")!, NETWORK_NO_SOURCE, HAVE_NOTHING);
  sources.deliver({ key: "0", failed: true });
  expect(sources.status().textContent).toBe("Loading video…");
  sources.deliver({ key: "1", failed: true });
  expect(sources.status().textContent).toBe("Video failed to load.");
  sources.win.close();

  const { win, deliver, status } = await frame('<video src="clip.mp4"></video>');
  deliver({ key: "0", blob: new win.Blob(["video"]) });
  const video = win.document.querySelector("video")!;
  Object.defineProperty(video, "error", { value: { code: 3 } });
  video.dispatchEvent(new win.Event("error"));
  expect(status().hidden).toBe(false);
  expect(status().textContent).toContain("compatible MP4 copy");
  video.dispatchEvent(new win.Event("loadeddata"));
  expect(status().hidden).toBe(true);
  win.close();
});

const concat = (chunks: Uint8Array[]) => {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

/** Read a file back the way a player would: its layout and every video packet. */
async function readBack(bytes: Uint8Array) {
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
  const [track] = await input.getVideoTracks();
  const packets: number[] = [];
  for await (const packet of new EncodedPacketSink(track!).packets())
    packets.push(packet.data.at(-1)!);
  const latin1 = new TextDecoder("latin1").decode(bytes);
  return { fragmented: latin1.includes("moof"), packets };
}

test.each(["in-memory", false, "fragmented"] as const)(
  "streams an MP4 with fastStart %s to the frame as fragmented MP4",
  async (fastStart) => {
    const { fetch } = transport();
    const file = await mp4File(fastStart);
    fetch.mockResolvedValueOnce(chunkedResponse([file.subarray(0, 100), file.subarray(100)]));
    const [asset] = prepareInlineAssets('<video src="clip.mp4"></video>', documentUrl.href).assets;
    const messages: InlineAssetChunk[] = [];
    const blob = await fetchInlineAsset(asset!, new AbortController().signal, (message) =>
      messages.push(message),
    );
    expect(messages[0]).toEqual({ key: "0", stream: STREAM_TYPE });
    const chunks = messages.slice(1).map((message) => ("chunk" in message ? message.chunk : null));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks).not.toContain(null);
    expect(await readBack(concat(chunks as Uint8Array[]))).toEqual({
      fragmented: true,
      packets: [0, 1, 2, 3, 4, 5],
    });
    // The frame's fallback is the original file, untouched.
    expect(blob.type).toBe("video/mp4");
    expect(blob.size).toBe(file.length);
  },
);

test("leaves a video it cannot rewrap to its Blob", async () => {
  const { fetch } = transport();
  fetch.mockResolvedValueOnce(chunkedResponse([text("not an mp4")], "video/webm"));
  const [asset] = prepareInlineAssets('<video src="clip.webm"></video>', documentUrl.href).assets;
  const onChunk = vi.fn();
  const blob = await fetchInlineAsset(asset!, new AbortController().signal, onChunk);
  expect(onChunk).not.toHaveBeenCalled();
  expect(await blob.text()).toBe("not an mp4");
  expect(blob.type).toBe("video/webm");
});

function fakeMediaSource(supported = true) {
  class FakeSourceBuffer {
    updating = false;
    appended: string[] = [];
    listeners = new Map<string, () => void>();
    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, listener);
    }
    appendBuffer(chunk: Uint8Array) {
      this.appended.push(new TextDecoder().decode(chunk));
      this.updating = true;
    }
    finish() {
      this.updating = false;
      this.listeners.get("updateend")!();
    }
  }
  const sources: FakeMediaSource[] = [];
  class FakeMediaSource {
    static isTypeSupported = vi.fn(() => supported);
    listeners = new Map<string, () => void>();
    type?: string;
    buffer?: FakeSourceBuffer;
    endOfStream = vi.fn();
    constructor() {
      sources.push(this);
    }
    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, listener);
    }
    addSourceBuffer(type: string) {
      this.type = type;
      return (this.buffer = new FakeSourceBuffer());
    }
    open() {
      this.listeners.get("sourceopen")!();
    }
  }
  return { FakeMediaSource, sources };
}

test("plays a fragmented MP4 through MediaSource before its Blob arrives", async () => {
  const { FakeMediaSource, sources } = fakeMediaSource();
  const { win, deliver, status } = await frame(
    '<video src="clip.mp4#t=2"></video>',
    FakeMediaSource,
  );
  const video = win.document.querySelector("video")!;
  deliver({ key: "0", stream: STREAM_TYPE });
  expect(FakeMediaSource.isTypeSupported).toHaveBeenCalledWith(STREAM_TYPE);
  expect(video.getAttribute("src")).toBe("blob:null/1#t=2");
  deliver({ key: "0", chunk: text("init") });
  const [source] = sources;
  source!.open();
  expect(source!.type).toBe(STREAM_TYPE);
  deliver({ key: "0", chunk: text("fragment") });
  // One append at a time: the second waits for the first to finish.
  expect(source!.buffer!.appended).toEqual(["init"]);
  source!.buffer!.finish();
  expect(source!.buffer!.appended).toEqual(["init", "fragment"]);
  deliver({ key: "0", blob: new win.Blob(["init", "fragment"]) });
  expect(source!.endOfStream).not.toHaveBeenCalled();
  source!.buffer!.finish();
  expect(source!.endOfStream).toHaveBeenCalledTimes(1);
  // The stream keeps playing. The Blob stays in reserve.
  expect(video.getAttribute("src")).toBe("blob:null/1#t=2");
  video.dispatchEvent(new win.Event("loadeddata"));
  expect(status().hidden).toBe(true);
  win.close();
});

test("attaches the MediaSource as srcObject where WebKit requires it", async () => {
  const { FakeMediaSource, sources } = fakeMediaSource();
  const { win, deliver } = await frame('<video src="clip.mp4"></video>', FakeMediaSource, "webkit");
  const video = win.document.querySelector("video")!;
  deliver({ key: "0", stream: STREAM_TYPE });
  expect(video.srcObject).toBe(sources[0]);
  expect(video.hasAttribute("src")).toBe(false);
  // A stream that never opened, as with preload="none", hands over the Blob.
  deliver({ key: "0", blob: new win.Blob(["video"]) });
  expect(video.srcObject).toBeNull();
  expect(video.getAttribute("src")).toBe("blob:null/1");
  win.close();
});

test("falls back to the Blob when the decoder rejects a stream", async () => {
  const { FakeMediaSource, sources } = fakeMediaSource();
  const { win, deliver, status, load } = await frame(
    '<video><source src="clip.mp4"></video>',
    FakeMediaSource,
  );
  const video = win.document.querySelector("video")!;
  deliver({ key: "0", stream: STREAM_TYPE });
  expect(video.getAttribute("src")).toBe("blob:null/1");
  sources[0]!.open();
  deliver({ key: "0", chunk: text("corrupt") });
  video.dispatchEvent(new win.Event("error"));
  // The Blob is still coming, so the frame does not report a failure yet.
  expect(status().textContent).toBe("Loading video…");
  deliver({ key: "0", blob: new win.Blob(["corrupt"]) });
  expect(video.hasAttribute("src")).toBe(false);
  expect(video.querySelector("source")?.getAttribute("src")).toBe("blob:null/2");
  expect(load).toHaveBeenCalledTimes(1);
  win.close();
});

test("falls back to the Blob when the stream fails part way", async () => {
  const { FakeMediaSource, sources } = fakeMediaSource();
  const { win, deliver } = await frame('<video src="clip.mp4"></video>', FakeMediaSource);
  const video = win.document.querySelector("video")!;
  deliver({ key: "0", stream: STREAM_TYPE });
  sources[0]!.open();
  deliver({ key: "0", chunk: text("init") });
  sources[0]!.buffer!.finish();
  deliver({ key: "0", streamFailed: true });
  deliver({ key: "0", blob: new win.Blob(["whole file"]) });
  // A truncated stream must not end as if it were complete.
  expect(sources[0]!.endOfStream).not.toHaveBeenCalled();
  expect(video.getAttribute("src")).toBe("blob:null/2");
  win.close();
});

test("waits for the Blob without a supported MediaSource or with several candidates", async () => {
  const unsupported = await frame(
    '<video src="clip.mp4"></video>',
    fakeMediaSource(false).FakeMediaSource,
  );
  unsupported.deliver({ key: "0", stream: STREAM_TYPE });
  unsupported.deliver({ key: "0", chunk: text("init") });
  const video = unsupported.win.document.querySelector("video")!;
  expect(video.hasAttribute("src")).toBe(false);
  unsupported.deliver({ key: "0", blob: new unsupported.win.Blob(["init"]) });
  expect(video.getAttribute("src")).toBe("blob:null/1");
  unsupported.win.close();

  const { FakeMediaSource, sources } = fakeMediaSource();
  const candidates = await frame(
    '<video><source src="a.mp4"><source src="b.mp4"></video>',
    FakeMediaSource,
  );
  candidates.deliver({ key: "1", stream: STREAM_TYPE });
  expect(sources).toHaveLength(0);
  expect(candidates.win.document.querySelector("video")!.hasAttribute("src")).toBe(false);
  candidates.win.close();
});

test("loads sibling images through the same opaque-frame bridge", async () => {
  const { fetch } = transport();
  fetch.mockResolvedValueOnce(new Response("image", { headers: { "content-type": "image/png" } }));
  const result = prepareInlineAssets('<img src="before.png">', documentUrl.href);
  expect(result.assets).toEqual([{ key: "0", url: `${root.href}before.png`, image: true }]);
  expect(result.html).toContain('data-bb-inline-preview="0"');
  const blob = await fetchInlineAsset(result.assets[0]!, new AbortController().signal);
  expect(blob.type).toBe("image/png");
});

test("local-media Escape waits for author handlers before forwarding", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<button>Focus</button>", { runScripts: "dangerously" });
  const win = dom.window;
  const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
  injectWideEscapeBridge(win.document, "media-token");
  const button = win.document.querySelector("button")!;
  const press = () =>
    button.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  win.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
  press();
  await new Promise((resolve) => win.setTimeout(resolve, 10));
  expect(post).not.toHaveBeenCalled();
  press();
  await new Promise((resolve) => win.setTimeout(resolve, 10));
  expect(post).toHaveBeenCalledExactlyOnceWith(
    { type: "bb:inline-vis:escape", token: "media-token" },
    "*",
  );
  dom.window.close();
});

test.each([
  "dialog:modal",
  "dialog[open][closedby=closerequest i]",
  "dialog[open][closedby=any i]",
  ":popover-open:not([popover=manual i])",
])("local-media Escape lets %s dismiss first", async (selector) => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<button>Focus</button><dialog></dialog>", { runScripts: "dangerously" });
  const win = dom.window;
  const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
  injectWideEscapeBridge(win.document, "media-token");
  const originalQuery = win.document.querySelector.bind(win.document);
  const dialog = originalQuery("dialog")!;
  let nativeOpen = true;
  vi.spyOn(win.document, "querySelector").mockImplementation((query) =>
    query === selector && nativeOpen
      ? dialog
      : originalQuery(
          [
            "dialog:modal",
            "dialog[open][closedby=closerequest i]",
            ":popover-open:not([popover=manual i])",
          ].includes(query)
            ? "#absent"
            : query,
        ),
  );
  const button = originalQuery("button")!;
  const press = () =>
    button.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  press();
  nativeOpen = false;
  await new Promise((resolve) => win.setTimeout(resolve, 10));
  expect(post).not.toHaveBeenCalled();
  press();
  await new Promise((resolve) => win.setTimeout(resolve, 10));
  expect(post).toHaveBeenCalledExactlyOnceWith(
    { type: "bb:inline-vis:escape", token: "media-token" },
    "*",
  );
  dom.window.close();
});

test("local-media Escape leaves Wide view with a persistent manual popover", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<button>Focus</button><div popover="MANUAL">Legend</div>', {
    runScripts: "dangerously",
  });
  const win = dom.window;
  const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
  injectWideEscapeBridge(win.document, "media-token");
  const originalQuery = win.document.querySelector.bind(win.document);
  const popover = originalQuery("[popover]")!;
  // jsdom does not implement the native open-popover pseudo-class.
  vi.spyOn(win.document, "querySelector").mockImplementation((query) => {
    if (query === ":popover-open") return popover;
    if (query === ":popover-open:not([popover=manual i])")
      return popover.matches("[popover=manual i]") ? null : popover;
    return originalQuery(query === "dialog:modal" ? "#absent" : query);
  });
  originalQuery("button")!.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => win.setTimeout(resolve, 10));
  expect(post).toHaveBeenCalledExactlyOnceWith(
    { type: "bb:inline-vis:escape", token: "media-token" },
    "*",
  );
  dom.window.close();
});
