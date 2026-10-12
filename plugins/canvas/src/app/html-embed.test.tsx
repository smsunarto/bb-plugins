import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { installDom } from "@bb-kit/core/testing";

installDom();
const { act, cleanup, render } = await import("@testing-library/react");
const { HtmlEmbed, inlineHtmlEmbed } = await import("./html-embed.tsx");

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const lease = "/api/v1/file-previews/lease-1";
const served: Record<string, Blob> = {
  [`${lease}/notes/page.html`]: new Blob([
    '<!doctype html><html><head><link rel="stylesheet" href="css/style.css">' +
      '<script src="app.js" defer></script><script src="https://cdn.example/lib.js"></script>' +
      '</head><body><img src="img/dot.png" alt="dot"></body></html>',
  ]),
  [`${lease}/notes/css/style.css`]: new Blob(["body { background: url('../img/dot.png'); }"]),
  [`${lease}/notes/app.js`]: new Blob(["document.title = 'ready';"]),
  [`${lease}/notes/img/dot.png`]: new Blob(["PNG"], { type: "image/png" }),
};

function serve() {
  const fetched = mock(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = served[url.pathname];
    expect(init?.credentials).toBe("same-origin");
    return body === undefined
      ? new Response("<title>bb connect</title>", { status: 401 })
      : new Response(body, { headers: { "content-type": body.type || "text/plain" } });
  });
  globalThis.fetch = fetched as unknown as typeof fetch;
  return fetched;
}

it("hands the frame one document with the page's local files inlined", async () => {
  const fetched = serve();
  const srcDoc = await inlineHtmlEmbed(
    `${lease}/notes/page.html`,
    lease,
    new AbortController().signal,
  );
  expect(srcDoc).toBe(
    "<!doctype html>\n<html><head>" +
      `<base href="http://localhost${lease}/notes/page.html">` +
      `<style>body { background: url('http://localhost${lease}/notes/img/dot.png'); }</style>` +
      '<script src="https://cdn.example/lib.js"></script>' +
      '</head><body><img src="data:image/png;base64,UE5H" alt="dot">' +
      "<script>document.title = 'ready';</script></body></html>",
  );
  // Only lease files are fetched, and only from the app, where the session cookie applies.
  expect(fetched.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
    `${lease}/notes/page.html`,
    `${lease}/notes/css/style.css`,
    `${lease}/notes/app.js`,
    `${lease}/notes/img/dot.png`,
  ]);
});

it("reports a page the lease cannot serve", async () => {
  serve();
  await expect(
    inlineHtmlEmbed(`${lease}/notes/missing.html`, lease, new AbortController().signal),
  ).rejects.toThrow(`${lease}/notes/missing.html: HTTP 401`);
});

/**
 * Post `data` to the app from `source`, the way the frame page asks for its
 * document. Returns what the app posts back to `frame`.
 */
function askForDocument(
  frame: HTMLIFrameElement,
  source: Window = frame.contentWindow!,
  data: unknown = { type: "bb:canvas:frame-ready" },
): unknown[] {
  const posted: unknown[] = [];
  const post = spyOn(frame.contentWindow!, "postMessage").mockImplementation((data: unknown) => {
    posted.push(data);
  });
  act(() => {
    window.dispatchEvent(new window.MessageEvent("message", { source, data }));
  });
  post.mockRestore();
  return posted;
}

function embed(src: string) {
  return <HtmlEmbed title="Embed" src={src} rootUrl={lease} height={200} />;
}

const pageA = `${lease}/a.html`;
const pageB = `${lease}/b.html`;
const documentB = `<!doctype html>\n<html><head><base href="http://localhost${pageB}"></head><body>B</body></html>`;

it("answers each frame once and replaces a frame that asks again", async () => {
  globalThis.fetch = (async () => new Response("<body>B</body>")) as unknown as typeof fetch;
  const { container, findByTitle } = render(embed(pageB));
  const first = (await findByTitle("Embed")) as HTMLIFrameElement;
  expect(first.getAttribute("src")).toBe("/api/v1/plugins/canvas/http/frame");
  // Only the frame's own ready message is answered.
  expect(askForDocument(first, window)).toEqual([]);
  expect(askForDocument(first, first.contentWindow!, { type: "bb:canvas:other" })).toEqual([]);
  expect(askForDocument(first)).toEqual([{ type: "bb:canvas:document", html: documentB }]);

  // A reload, or a page the frame navigated to, asks from the same window.
  expect(askForDocument(first)).toEqual([]);
  const fresh = container.querySelector("iframe")!;
  expect(fresh).not.toBe(first);
  expect(askForDocument(fresh)).toEqual([{ type: "bb:canvas:document", html: documentB }]);
});

it("never hands a frame a page that finished loading after its source changed", async () => {
  let finishA!: () => void;
  const pageALoaded = new Promise<void>((resolve) => (finishA = resolve));
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    if (new URL(String(input)).pathname === pageA) {
      await pageALoaded;
      return new Response("<body>A</body>");
    }
    return new Response("<body>B</body>");
  }) as unknown as typeof fetch;
  const { container, findByTitle, rerender } = render(embed(pageA));
  rerender(embed(pageB));
  const frame = (await findByTitle("Embed")) as HTMLIFrameElement;
  expect(askForDocument(frame)).toEqual([{ type: "bb:canvas:document", html: documentB }]);

  await act(async () => {
    finishA();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(askForDocument(frame)).toEqual([]);
  const fresh = container.querySelector("iframe")!;
  expect(askForDocument(fresh)).toEqual([{ type: "bb:canvas:document", html: documentB }]);
});
