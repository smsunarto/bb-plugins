import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { PREVIEW_FRAME_MESSAGES, PREVIEW_FRAME_URL } from "../shared/preview-frame.ts";

// `::html{src}` pages run in a sandboxed, opaque-origin frame. Behind bb
// Connect, that frame cannot send the SameSite session cookie, so every
// subresource it asks the preview lease for gets the Connect login page.
// The app fetches the page and its local stylesheets, scripts, and media
// with the cookie instead, and hands the frame one self-contained document
// through the plugin's frame page (see preview-frame.ts).
// A `<base>` at the page keeps everything else resolving as it did, so a
// page that fetches files at run time still works where no gate stands in
// between.

// Media is inlined as data: URLs. Larger files keep their lease URL.
const maxInlineMediaBytes = 8 * 1024 * 1024;

async function fetchLeased(url: URL, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { credentials: "same-origin", redirect: "error", signal });
  if (!response.ok) throw new Error(`${decodeURIComponent(url.pathname)}: HTTP ${response.status}`);
  return response;
}

function leasedUrl(value: string | null, base: URL, root: URL): URL | null {
  if (value === null || value.trim() === "" || /^(data|blob):/i.test(value.trim())) return null;
  const url = new URL(value, base);
  url.hash = "";
  return url.origin === root.origin && url.pathname.startsWith(root.pathname) ? url : null;
}

async function dataUrlOf(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

/** A stylesheet's own relative `url()`s, made absolute before it moves into the page. */
function absoluteCssUrls(css: string, sheet: URL): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, quote: string, ref: string) =>
    /^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(ref)
      ? match
      : `url(${quote}${new URL(ref, sheet).href}${quote})`,
  );
}

interface Lease {
  readonly base: URL;
  readonly root: URL;
  readonly signal: AbortSignal;
}

/** Fetch every lease file `selector` names in `attribute` in the app, then inline it. */
async function inlineEach<E extends Element>(
  document: Document,
  selector: string,
  attribute: string,
  lease: Lease,
  inline: (element: E, response: Response, url: URL) => Promise<void>,
): Promise<void> {
  for (const element of document.querySelectorAll<E>(selector)) {
    const url = leasedUrl(element.getAttribute(attribute), lease.base, lease.root);
    if (url !== null) await inline(element, await fetchLeased(url, lease.signal), url);
  }
}

const inlineStylesheet = async (link: HTMLLinkElement, response: Response, url: URL) => {
  const style = link.ownerDocument.createElement("style");
  const media = link.getAttribute("media");
  if (media !== null) style.setAttribute("media", media);
  style.textContent = absoluteCssUrls(await response.text(), url).replaceAll(
    "</style",
    "<\\/style",
  );
  link.replaceWith(style);
};

const inlineScript = async (script: HTMLScriptElement, response: Response) => {
  script.removeAttribute("src");
  script.textContent = (await response.text()).replaceAll("</script", "<\\/script");
  // An inline classic script runs where it stands. A deferred one waited for
  // the whole document, so it moves to the end to keep that order.
  if (script.hasAttribute("defer") && script.type !== "module") {
    script.removeAttribute("defer");
    script.ownerDocument.body.append(script);
  }
};

const inlineMedia = (attribute: string) => async (element: Element, response: Response) => {
  const blob = await response.blob();
  if (blob.size <= maxInlineMediaBytes) element.setAttribute(attribute, await dataUrlOf(blob));
};

/**
 * The page at `pageUrl` with its local stylesheets, scripts, and media
 * inlined. Only files under the lease root `rootUrl` are fetched.
 */
export async function inlineHtmlEmbed(
  pageUrl: string,
  rootUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const page = new URL(pageUrl, window.location.href);
  const root = new URL(`${rootUrl.replace(/\/$/, "")}/`, window.location.href);
  const html = await (await fetchLeased(page, signal)).text();
  const document = new DOMParser().parseFromString(html, "text/html");
  const declared = document.querySelector("base[href]")?.getAttribute("href") ?? null;
  const lease: Lease = { base: new URL(declared ?? page.href, page), root, signal };
  await inlineEach(document, 'link[rel~="stylesheet" i]', "href", lease, inlineStylesheet);
  await inlineEach(document, "script[src]", "src", lease, inlineScript);
  const media = "img[src], video[src], audio[src], source[src]";
  await inlineEach(document, media, "src", lease, inlineMedia("src"));
  await inlineEach(document, "video[poster]", "poster", lease, inlineMedia("poster"));
  if (declared === null) {
    const tag = document.createElement("base");
    tag.href = lease.base.href;
    document.head.prepend(tag);
  }
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

type Embed =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly html: string }
  | { readonly status: "failed"; readonly message: string };

export function HtmlEmbed(props: {
  readonly title: string;
  readonly src: string;
  readonly rootUrl: string;
  readonly height: number;
}): ReactElement {
  const { title, src, rootUrl, height } = props;
  const [embed, setEmbed] = useState<Embed>({ status: "loading" });
  const frame = useRef<HTMLIFrameElement>(null);
  // Windows that already received a document. A frame keeps its window when it
  // navigates, so a window that asks again may now hold a page from elsewhere.
  const served = useRef(new WeakSet<Window>());
  const [frameKey, setFrameKey] = useState(0);
  useEffect(() => {
    // Without a lease (another plugin reusing the editor), load the page as is.
    if (rootUrl === "") return;
    const controller = new AbortController();
    setEmbed({ status: "loading" });
    void (async () => {
      let next: Embed;
      try {
        next = { status: "ready", html: await inlineHtmlEmbed(src, rootUrl, controller.signal) };
      } catch (error) {
        next = {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      // A page that finishes after its source changed must not replace the newer one.
      if (!controller.signal.aborted) setEmbed(next);
    })();
    return () => controller.abort();
  }, [src, rootUrl]);
  useLayoutEffect(() => {
    if (embed.status !== "ready") return;
    const { html } = embed;
    const deliver = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || event.data?.type !== PREVIEW_FRAME_MESSAGES.ready) {
        return;
      }
      // Each window gets the document once. One that asks again reloaded or
      // navigated back to the frame page, so a fresh frame replaces it.
      if (served.current.has(target)) {
        setFrameKey((key) => key + 1);
        return;
      }
      served.current.add(target);
      target.postMessage({ type: PREVIEW_FRAME_MESSAGES.document, html }, "*");
    };
    window.addEventListener("message", deliver);
    return () => window.removeEventListener("message", deliver);
  }, [embed]);
  if (rootUrl === "") {
    return <iframe title={title} sandbox="allow-scripts" style={{ height }} src={src} />;
  }
  if (embed.status === "failed") {
    return (
      <p role="alert" className="canvas-html-embed-status" style={{ height }}>
        {embed.message}
      </p>
    );
  }
  if (embed.status === "loading") {
    return <p className="canvas-html-embed-status" style={{ height }} aria-busy="true" />;
  }
  return (
    <iframe
      key={frameKey}
      ref={frame}
      title={title}
      sandbox="allow-scripts"
      style={{ height }}
      src={PREVIEW_FRAME_URL}
    />
  );
}
