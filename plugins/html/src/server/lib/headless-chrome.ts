import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ThemeAppearance } from "../../shared/html-render.ts";
import { startPublicProxy } from "./public-proxy.ts";

/**
 * Renders a page in headless Chrome over the DevTools pipe. Ported from T3
 * Code's `headlessChrome.ts`: the page is served from a fake `.localhost`
 * origin by Fetch interception, the main frame cannot navigate away, and
 * every other request leaves through the public-only proxy.
 */

export class HtmlRenderBrowserError extends Error {
  /** The tail of Chrome's stderr, when the browser exited. */
  readonly output: string | undefined;

  constructor(reason: string, output?: string, options?: ErrorOptions) {
    super(`Headless Chrome could not render the page: ${reason}.`, options);
    this.name = "HtmlRenderBrowserError";
    this.output = output;
  }
}

export interface ConsoleMessage {
  readonly level: "log" | "info" | "warning" | "error";
  readonly text: string;
}

export interface HtmlScreenshot {
  readonly png: string;
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: readonly ConsoleMessage[];
}

const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_TEXT_CHARS = 500;
const VIEWPORT_HEIGHT = 800;
const MAX_CAPTURE_HEIGHT = 4_000;
const CAPTURE_TIMEOUT_MS = 20_000;
// Chrome blocks file access; images arrive inlined. Browser-only .localhost permits secure contexts and HTTP resources.
const PAGE_ORIGIN = "http://html-page.localhost";
const PAGE_URL = `${PAGE_ORIGIN}/page.html`;
const PAGE_NAME = "page.html";

const CONSOLE_LEVELS: Readonly<Record<string, ConsoleMessage["level"]>> = {
  log: "log",
  debug: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  info: "info",
  warning: "warning",
  error: "error",
  assert: "error",
};

type RemoteObject = { type?: string; value?: unknown; description?: string };

const remoteObjectText = (value: RemoteObject) =>
  typeof value.value === "string"
    ? value.value
    : (value.description ?? (value.value === undefined ? String(value.type) : String(value.value)));

function consoleMessageFromEvent(method: string, params: any): ConsoleMessage | undefined {
  if (method === "Runtime.consoleAPICalled") {
    const level = CONSOLE_LEVELS[params?.type];
    return level && Array.isArray(params.args)
      ? { level, text: (params.args as RemoteObject[]).map(remoteObjectText).join(" ") }
      : undefined;
  }
  if (method === "Runtime.exceptionThrown") {
    const details = params?.exceptionDetails;
    return typeof details?.text === "string"
      ? { level: "error", text: details.exception?.description ?? details.text }
      : undefined;
  }
  if (method === "Log.entryAdded") {
    const entry = params?.entry;
    return entry && (entry.level === "error" || entry.level === "warning")
      ? { level: entry.level, text: entry.url ? `${entry.text} ${entry.url}` : String(entry.text) }
      : undefined;
  }
  return undefined;
}

// Wait for fonts and two paint frames to capture late layout.
const SETTLE_EXPRESSION =
  "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))";
// scrollHeight is at least viewport height; use the root box for shorter pages.
const MEASURE_EXPRESSION =
  "(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()";

type Pending = { method: string; resolve(value: any): void; reject(error: Error): void };

interface PageEvents {
  readonly mainFrameId: string;
  body: string | undefined;
  loaded: { resolve(): void; reject(error: Error): void } | undefined;
  readonly consoleMessages: ConsoleMessage[];
  omittedConsoleMessages: number;
}

/** CDP pipe uses fd 3 in, fd 4 out and NUL-delimited JSON. */
async function launchBrowser(input: {
  executable: string;
  noSandbox: boolean;
  profileDirectory: string;
  proxyPort: number;
}) {
  let child: ChildProcess;
  try {
    child = spawn(
      input.executable,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        "--mute-audio",
        "--block-new-web-contents",
        `--proxy-server=socks5://127.0.0.1:${input.proxyPort}`,
        // Loopback would otherwise skip the proxy.
        "--proxy-bypass-list=<-loopback>",
        // WebRTC would otherwise send UDP, which no proxy carries.
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ...(input.noSandbox ? ["--no-sandbox"] : []),
        `--user-data-dir=${input.profileDirectory}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
    );
  } catch (cause) {
    throw new HtmlRenderBrowserError("the browser could not be started", undefined, { cause });
  }
  const outgoing = child.stdio[3] as Writable;
  const incoming = child.stdio[4] as Readable;
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (text: string) => {
    stderrTail = (stderrTail + text).slice(-2_048);
  });
  outgoing.on("error", () => {});

  const pending = new Map<number, Pending>();
  const pages = new Map<string, PageEvents>();
  let disconnected: HtmlRenderBrowserError | undefined;
  let nextId = 0;

  const write = (message: string) => {
    if (!disconnected) outgoing.write(`${message}\0`);
  };
  const post = (method: string, params: Record<string, unknown>, sessionId: string) =>
    write(JSON.stringify({ id: ++nextId, method, params, sessionId }));

  const disconnect = (reason: string) => {
    if (disconnected) return;
    const exit =
      child.exitCode !== null
        ? ` (exit code ${child.exitCode})`
        : child.signalCode !== null
          ? ` (signal ${child.signalCode})`
          : "";
    disconnected = new HtmlRenderBrowserError(`${reason}${exit}`, stderrTail);
    for (const waiter of pending.values()) waiter.reject(disconnected);
    pending.clear();
    for (const page of pages.values()) page.loaded?.reject(disconnected);
  };
  child.once("error", (cause) => disconnect(`the browser could not be started: ${cause.message}`));
  // Startup aborts close the pipe; give stderr a moment to explain why.
  child.once("exit", () => setTimeout(() => disconnect("the browser exited unexpectedly"), 50));

  const settle = (message: any) => {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (!waiter) return;
    if (message.error) {
      waiter.reject(
        new HtmlRenderBrowserError(`${waiter.method} failed: ${String(message.error.message)}`),
      );
    } else waiter.resolve(message.result);
  };

  const route = (page: PageEvents, sessionId: string, params: any) => {
    const requestId: unknown = params?.requestId;
    const requestUrl: unknown = params?.request?.url;
    if (typeof requestId !== "string" || typeof requestUrl !== "string") return;
    const url = requestUrl.split("#", 1)[0]!;
    if (url === PAGE_URL && page.body !== undefined) {
      post(
        "Fetch.fulfillRequest",
        {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
          body: page.body,
        },
        sessionId,
      );
      return;
    }
    // Chrome asks for a favicon on every load; an empty answer keeps it out of the console.
    if (url === `${PAGE_ORIGIN}/favicon.ico`) {
      post("Fetch.fulfillRequest", { requestId, responseCode: 204, body: "" }, sessionId);
      return;
    }
    // Subframes may show other sites through the proxy; the main frame stays on the page.
    const otherSiteFrame =
      params.resourceType === "Document" &&
      params.frameId !== page.mainFrameId &&
      !url.startsWith(`${PAGE_ORIGIN}/`);
    if (otherSiteFrame) post("Fetch.continueRequest", { requestId }, sessionId);
    else post("Fetch.failRequest", { requestId, errorReason: "AccessDenied" }, sessionId);
  };

  const record = (page: PageEvents, consoleMessage: ConsoleMessage) => {
    if (page.consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
      page.omittedConsoleMessages += 1;
      return;
    }
    const text = consoleMessage.text.replaceAll(PAGE_URL, PAGE_NAME);
    page.consoleMessages.push({
      level: consoleMessage.level,
      text:
        text.length > MAX_CONSOLE_TEXT_CHARS ? `${text.slice(0, MAX_CONSOLE_TEXT_CHARS)}…` : text,
    });
  };

  const receive = (raw: string) => {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message?.id === "number") {
      settle(message);
      return;
    }
    const sessionId: unknown = message?.sessionId;
    const page = typeof sessionId === "string" ? pages.get(sessionId) : undefined;
    if (typeof sessionId !== "string" || !page || typeof message.method !== "string") return;
    if (message.method === "Page.loadEventFired") page.loaded?.resolve();
    else if (message.method === "Fetch.requestPaused") route(page, sessionId, message.params);
    else {
      const consoleMessage = consoleMessageFromEvent(message.method, message.params);
      if (consoleMessage) record(page, consoleMessage);
    }
  };

  // Chunks may split messages; screenshot replies span many chunks.
  let partial: string[] = [];
  incoming.setEncoding("utf8");
  incoming.on("data", (text: string) => {
    let start = 0;
    for (let end = text.indexOf("\0"); end !== -1; end = text.indexOf("\0", start)) {
      partial.push(text.slice(start, end));
      const complete = partial.join("");
      partial = [];
      start = end + 1;
      receive(complete);
    }
    if (start < text.length) partial.push(text.slice(start));
  });
  incoming.on("close", () => setTimeout(() => disconnect("the browser exited unexpectedly"), 50));

  const send = <A = unknown>(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<A> => {
    if (disconnected) return Promise.reject(disconnected);
    const id = ++nextId;
    return new Promise<A>((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };

  async function openPage(width: number, appearance: ThemeAppearance) {
    const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    // A page target's id is its main frame's id.
    const events: PageEvents = {
      mainFrameId: targetId,
      body: undefined,
      loaded: undefined,
      consoleMessages: [],
      omittedConsoleMessages: 0,
    };
    pages.set(sessionId, events);
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Log.enable", {}, sessionId);
    await send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: appearance }] },
      sessionId,
    );
    // Previews have no use for WebRTC, whose ICE servers can make the browser
    // resolve names outside the proxy. Runs before page scripts in every frame.
    await send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;",
        runImmediately: true,
      },
      sessionId,
    );
    // Intercept the page and all document navigations to keep the main frame on it.
    await send(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: `${PAGE_ORIGIN}/*` },
          { urlPattern: "*", resourceType: "Document" },
        ],
      },
      sessionId,
    );
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );

    async function load(body: string): Promise<number> {
      const loaded = new Promise<void>((resolve, reject) => {
        events.loaded = { resolve, reject };
      });
      events.body = body;
      const navigation = await send<{ errorText?: string }>(
        "Page.navigate",
        { url: PAGE_URL },
        sessionId,
      );
      if (navigation.errorText) throw new HtmlRenderBrowserError("the page could not be opened");
      await loaded;
      await send(
        "Runtime.evaluate",
        { expression: SETTLE_EXPRESSION, awaitPromise: true },
        sessionId,
      );
      const measured = await send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: MEASURE_EXPRESSION, returnByValue: true },
        sessionId,
      );
      const value = measured.result?.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new HtmlRenderBrowserError("the page height could not be measured");
      }
      return Math.max(0, Math.ceil(value));
    }

    const screenshot = async (height: number) =>
      (
        await send<{ data: string }>(
          "Page.captureScreenshot",
          {
            format: "png",
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height, scale: 1 },
          },
          sessionId,
        )
      ).data;

    const consoleMessages = (): readonly ConsoleMessage[] =>
      events.omittedConsoleMessages === 0
        ? [...events.consoleMessages]
        : [
            ...events.consoleMessages,
            {
              level: "warning",
              text: `${events.omittedConsoleMessages} more console messages were omitted.`,
            },
          ];

    return { load, screenshot, consoleMessages };
  }

  const close = async () => {
    disconnect("the browser was closed");
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(timer);
  };

  return { openPage, close };
}

/** Pages reach 25 MiB, so encode the body once with Node's encoder. */
const pageBody = (html: string) => Buffer.from(html, "utf8").toString("base64");

export async function captureHtmlScreenshot(input: {
  executable: string;
  noSandbox: boolean;
  html: string;
  width: number;
  appearance: ThemeAppearance;
  signal?: AbortSignal;
}): Promise<HtmlScreenshot> {
  input.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "bb-html-preview-"));
  const proxy = await startPublicProxy();
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new HtmlRenderBrowserError(
            `the page did not finish loading within ${CAPTURE_TIMEOUT_MS / 1000} seconds`,
          ),
        ),
      CAPTURE_TIMEOUT_MS,
    );
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Preview was cancelled."));
    input.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const run = async () => {
      browser = await launchBrowser({
        executable: input.executable,
        noSandbox: input.noSandbox,
        profileDirectory: join(directory, "profile"),
        proxyPort: proxy.port,
      });
      // A timeout or cancel can settle the race while the browser starts.
      if (finished) await browser.close();
      const page = await browser.openPage(input.width, input.appearance);
      const contentHeight = await page.load(pageBody(input.html));
      const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURE_HEIGHT));
      const png = await page.screenshot(capturedHeight);
      return { png, contentHeight, capturedHeight, consoleMessages: page.consoleMessages() };
    };
    return await Promise.race([run(), timeout, aborted]);
  } finally {
    finished = true;
    clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
    await proxy.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
