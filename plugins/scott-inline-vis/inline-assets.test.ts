// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchInlineAsset,
  injectWideEscapeBridge,
  prepareInlineAssets,
  resolvePreviewAssetUrl,
} from "./inline-assets.ts";

afterEach(() => vi.restoreAllMocks());
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

async function frame(html: string) {
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
