// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
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

test("loads video and source src once through the authenticated preview boundary and transfers blobs without serializing video into HTML", async () => {
  const { fetch, create } = transport();
  const signal = new AbortController().signal;
  const result = await prepareInlineAssets(
    '<video src="./media/a.mp4#t=2"></video><video><source src="media/a.mp4"></video><video src="data:video/mp4;base64,AAAA"></video>',
    documentUrl.href,
    signal,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]![0])).toMatch(/\/file-previews\/lease\/media\/a\.mp4$/);
  expect(fetch.mock.calls[0]![1]).toEqual({
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  const doc = new DOMParser().parseFromString(result.srcDoc!, "text/html");
  expect(doc.querySelector("base")?.href).toMatch(/\/file-previews\/lease\/player\.html$/);
  expect(doc.querySelector("video")?.hasAttribute("src")).toBe(false);
  expect(result.assets[0]?.hash).toBe("#t=2");
  expect(result.assets[0]?.blob).toBe(result.assets[1]?.blob);
  expect(await result.assets[0]?.blob.text()).toBe("video");
  expect(doc.querySelector("source")?.hasAttribute("src")).toBe(false);
  expect(doc.querySelectorAll("video")[2]?.src).toBe("data:video/mp4;base64,AAAA");
  expect(result.token).toBeTruthy();
  expect(create).not.toHaveBeenCalled();
});

test("does not fetch or rewrite HTML containing only existing data or remote embeds", async () => {
  const { fetch } = transport();
  const result = await prepareInlineAssets(
    '<video src="data:video/mp4;base64,AAAA"></video>',
    documentUrl.href,
    new AbortController().signal,
  );
  expect(result.srcDoc).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

test("surfaces root confinement errors without creating a parent-origin blob URL", async () => {
  const { fetch, create } = transport();
  fetch.mockResolvedValueOnce(new Response("video", { headers: { "content-type": "video/mp4" } }));
  fetch.mockResolvedValueOnce(new Response("symlink escapes read root", { status: 400 }));
  await expect(
    prepareInlineAssets(
      '<video src="a.mp4"></video><video src="outside-symlink.mp4"></video>',
      documentUrl.href,
      new AbortController().signal,
    ),
  ).rejects.toThrow("HTTP 400");
  expect(create).not.toHaveBeenCalled();
});

test("rejects an authentication HTML response instead of treating it as a video", async () => {
  const { fetch, create } = transport();
  fetch.mockResolvedValueOnce(new Response("login", { headers: { "content-type": "text/html" } }));
  await expect(
    prepareInlineAssets(
      '<video src="a.mp4"></video>',
      documentUrl.href,
      new AbortController().signal,
    ),
  ).rejects.toThrow("unsupported MIME type");
  expect(create).not.toHaveBeenCalled();
});

test("does not retain a blob when collapse aborts an in-flight read", async () => {
  const { fetch, create } = transport();
  const controller = new AbortController();
  fetch.mockImplementationOnce(async () => {
    controller.abort();
    return new Response("video", { headers: { "content-type": "video/mp4" } });
  });
  await expect(
    prepareInlineAssets('<video src="a.mp4"></video>', documentUrl.href, controller.signal),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

test("fetches videos through the SDK preview lease", async () => {
  const { fetch } = transport();
  const result = await prepareInlineAssets(
    '<video src="clip.mp4"></video>',
    documentUrl.href,
    new AbortController().signal,
  );
  expect(String(fetch.mock.calls[0]![0])).toMatch(/\/file-previews\/lease\/clip\.mp4$/);
  const doc = new DOMParser().parseFromString(result.srcDoc!, "text/html");
  expect(doc.querySelector("base")?.href).toMatch(/\/file-previews\/lease\/player\.html$/);
});

test("honors an explicit local base and leaves remote-base embeds alone", async () => {
  const { fetch } = transport();
  const local = await prepareInlineAssets(
    '<base href="media/"><video src="a.mp4"></video>',
    documentUrl.href,
    new AbortController().signal,
  );
  expect(String(fetch.mock.calls[0]![0])).toMatch(/\/file-previews\/lease\/media\/a\.mp4$/);
  expect(local.assets).toHaveLength(1);
  const remote = await prepareInlineAssets(
    '<base href="https://example.com/"><video src="a.mp4"></video>',
    documentUrl.href,
    new AbortController().signal,
  );
  expect(remote.srcDoc).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("reports decoder failures inside the opaque frame and clears the alert after recovery", async () => {
  transport();
  const result = await prepareInlineAssets(
    '<video src="clip.mp4"></video>',
    documentUrl.href,
    new AbortController().signal,
  );
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(result.srcDoc!, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.URL.createObjectURL = vi.fn(() => "blob:null/video");
      window.HTMLMediaElement.prototype.load = vi.fn();
    },
  });
  const win = dom.window;
  win.dispatchEvent(
    new win.MessageEvent("message", {
      source: win as unknown as Window,
      data: { type: "bb:inline-preview-assets", token: result.token, assets: result.assets },
    }),
  );
  const video = win.document.querySelector("video")!;
  Object.defineProperty(video, "error", { value: { code: 3 } });
  video.dispatchEvent(new win.Event("error"));
  const alert = win.document.querySelector('[role="alert"]') as HTMLParagraphElement;
  expect(alert.hidden).toBe(false);
  expect(alert.textContent).toContain("compatible MP4 copy");
  video.dispatchEvent(new win.Event("loadeddata"));
  expect(alert.hidden).toBe(true);
  dom.window.close();
});

test("loads sibling images through the same opaque-frame bridge", async () => {
  const { fetch } = transport();
  fetch.mockResolvedValueOnce(new Response("image", { headers: { "content-type": "image/png" } }));
  const result = await prepareInlineAssets(
    '<img src="before.png">',
    documentUrl.href,
    new AbortController().signal,
  );
  expect(String(fetch.mock.calls[0]![0])).toBe(`${root.href}before.png`);
  expect(result.assets[0]?.blob.type).toBe("image/png");
  expect(result.srcDoc).toContain('data-bb-inline-preview="0"');
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
