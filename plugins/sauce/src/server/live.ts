import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { BrowserUnavailableError, type BrowserRunner } from "./browser.ts";
import { pngGrayThumbnail, pngSize } from "./png.ts";

/**
 * Sauce Labs Live, driven through its web app. The account is on a Live Testing
 * plan: Appium and the Real Device Access API reject it, so the web UI is the
 * only way to reach a device. Selectors anchor on roles, names, and Sauce's
 * data-qa attributes; each one below was mapped against the live app.
 */

export const LIVE_HOME = "https://app.saucelabs.com/live/app-testing";

export type SauceErrorCode =
  | "browser_unavailable"
  | "signed_out"
  | "capacity_reached"
  | "held_by_other_thread"
  | "no_session"
  | "no_frame"
  | "stale_frame"
  | "session_active"
  | "not_found"
  | "unsupported"
  | "timeout"
  | "start_pending"
  | "cancelled"
  | "page_changed";

export class SauceError extends Error {
  override readonly name = "SauceError";
  constructor(
    readonly code: SauceErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export type PageState = {
  url: string;
  kind: "signed_out" | "session" | "session_ended" | "live" | "other";
  /** "Samsung Galaxy S23 - Android 16" while a session runs. */
  device: string | null;
  /** Sauce says the account's one live slot is in use elsewhere. */
  capacityReached: boolean;
};

export type AppBuild = { id: string; label: string };
export type DeviceRow = { name: string; status: string; os: string; screen: string };
export type Rect = { left: number; top: number; width: number; height: number };
export type Point = { x: number; y: number };

export type SaucePageDeps = {
  sleep(ms: number): Promise<void>;
  now(): number;
  /**
   * Raw 8-bit grayscale pixels of an image resized to width x height, for PNGs the
   * in-process decoder does not handle; null when ImageMagick is not installed.
   */
  grayThumbnail(path: string, width: number, height: number): Promise<Uint8Array | null>;
};

function imageMagickThumbnail(binary: string, path: string, width: number, height: number) {
  return new Promise<Uint8Array | null>((resolve) => {
    execFile(
      binary,
      [path, "-resize", `${width}x${height}!`, "-colorspace", "gray", "-depth", "8", "gray:-"],
      { encoding: "buffer", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : new Uint8Array(stdout)),
    );
  });
}

export const defaultPageDeps: SaucePageDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  // ImageMagick 7 installs `magick`; Ubuntu's ImageMagick 6 installs only `convert`.
  grayThumbnail: async (path, width, height) =>
    (await imageMagickThumbnail("magick", path, width, height)) ??
    imageMagickThumbnail("convert", path, width, height),
};

/**
 * How a screenshot's rotation was read. Sauce draws a landscape app sideways in a
 * portrait canvas, so the screen's shape allows two rotations, and comparing the
 * canvas with the upright screenshot picks one. `clear` is false when neither
 * canvas frame matched the screenshot well: the screen changed during the capture,
 * or it is too uniform (a black or single-colour frame) to tell.
 */
export type RotationReading = {
  candidates: readonly [number, number];
  best: number | null;
  clear: boolean;
  /** The best sample's correlation with the screenshot, and its lead over the other rotation. */
  score?: number;
  margin?: number;
};

/** A canvas frame must correlate at least this well with the screenshot... */
const MIN_MATCH = 0.5;
/** ...and beat the other rotation by this much, or the reading is not clear. */
const MIN_MARGIN = 0.2;

/**
 * Scores each candidate rotation of each canvas sample (gray, cw x ch) against the
 * upright screenshot thumbnail (gray, sized for the candidates' upright shape) by
 * normalized correlation, and keeps the best-matching sample.
 */
export function scoreRotation(
  samples: readonly (ArrayLike<number> | null)[],
  canvas: { width: number; height: number },
  upright: { pixels: ArrayLike<number>; width: number; height: number },
  candidates: readonly [number, number],
): RotationReading {
  let best: { rotation: number; score: number; margin: number } | null = null;
  for (const sample of samples) {
    if (!sample) continue;
    const [first, second] = candidates.map((rotation) =>
      correlation(turnThumbnail(sample, canvas, upright, rotation), upright.pixels),
    ) as [number, number];
    const top =
      first >= second
        ? { rotation: candidates[0], score: first }
        : { rotation: candidates[1], score: second };
    if (!best || top.score > best.score) best = { ...top, margin: Math.abs(first - second) };
  }
  if (!best) return { candidates, best: null, clear: false };
  return {
    candidates,
    best: best.rotation,
    clear: best.score >= MIN_MATCH && best.margin >= MIN_MARGIN,
    score: Math.round(best.score * 100) / 100,
    margin: Math.round(best.margin * 100) / 100,
  };
}

/** The canvas thumbnail turned upright by `rotation`, using the same mapping as touches. */
function turnThumbnail(
  canvas: ArrayLike<number>,
  size: { width: number; height: number },
  upright: { width: number; height: number },
  rotation: number,
): Float64Array {
  const out = new Float64Array(upright.width * upright.height);
  for (let y = 0; y < upright.height; y += 1) {
    for (let x = 0; x < upright.width; x += 1) {
      const [cx, cy] = canvasFraction(
        { x: (x + 0.5) / upright.width, y: (y + 0.5) / upright.height },
        rotation,
      );
      const col = Math.min(size.width - 1, Math.floor(cx * size.width));
      const row = Math.min(size.height - 1, Math.floor(cy * size.height));
      out[y * upright.width + x] = canvas[row * size.width + col] ?? 0;
    }
  }
  return out;
}

function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i] ?? 0;
    meanB += b[i] ?? 0;
  }
  meanA /= n;
  meanB /= n;
  let cross = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    cross += da * db;
    varA += da * da;
    varB += db * db;
  }
  return varA === 0 || varB === 0 ? 0 : cross / Math.sqrt(varA * varB);
}

const STATE_SCRIPT = `(() => {
  const text = document.body ? document.body.innerText : "";
  const ended = [...document.querySelectorAll("h1,h2,h3,h4")].some((h) => /test session has ended/i.test(h.innerText));
  const header = [...document.querySelectorAll("[tabindex]")].map((e) => e.innerText && e.innerText.trim()).find((t) => t && / - (Android|iOS|iPadOS) /.test(t) && t.length < 80);
  return {
    url: location.href,
    host: location.host,
    path: location.pathname,
    ended,
    device: header || null,
    capacity: /reached your testing capacity/i.test(text),
  };
})()`;

const CANVAS = "canvas.testobject-device__canvas";

/**
 * The ADB Shell command box. Sauce also renders a device paste box
 * (textarea.testobject-device__paste-area) that forwards every key to the phone.
 */
const SHELL_INPUT = "textarea:not(.testobject-device__paste-area)";
const SHELL_FOCUSED = `document.activeElement === document.querySelector(${JSON.stringify(SHELL_INPUT)})`;

/** Longest edge, in pixels, of the grayscale samples used to compare screens. */
const SAMPLE_EDGE = 48;

/** Time allowed for a gesture's process and browser round trips, beyond its own duration. */
const GESTURE_TIMEOUT_MS = 30_000;

/**
 * What one move-and-wait pair costs inside an agent-browser batch beyond its wait.
 * Each wait between drag moves is shortened by it. Timed on a local page,
 * 2026-11-13: with this value, drags asked for 300, 1000 and 2000 ms took within 10%.
 */
const BATCH_STEP_OVERHEAD_MS = 5;

/**
 * The moves of a drag from `start` to `end`, evenly spaced over `durationMs`. The
 * path is linear so a swipe is still moving when the finger lifts.
 */
export function dragMoves(
  start: { x: number; y: number },
  end: { x: number; y: number },
  durationMs: number,
): string[] {
  const steps = Math.max(2, Math.min(40, Math.round(durationMs / 25)));
  const pause = Math.max(0, Math.round(durationMs / steps) - BATCH_STEP_OVERHEAD_MS);
  const moves: string[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(start.x + ((end.x - start.x) * step) / steps);
    const y = Math.round(start.y + ((end.y - start.y) * step) / steps);
    moves.push(`mouse move ${x} ${y}`);
    if (pause > 0 && step < steps) moves.push(`wait ${pause}`);
  }
  return moves;
}

/** Sauce's device table shows this many pages at most before a list is reported truncated. */
const MAX_DEVICE_PAGES = 12;

/** Clicks the device table's Next Page button; returns the current page label, or "last". */
const NEXT_PAGE = `(() => {
  const next = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Go to Next Page");
  if (!next || next.disabled) return "last";
  const current = document.querySelector("button[aria-current=page]")?.getAttribute("aria-label") || "";
  next.click();
  return "from:" + current;
})()`;

const CURRENT_PAGE = `document.querySelector("button[aria-current=page]")?.getAttribute("aria-label") || ""`;

/** Non-empty cell texts of a device-table row: name, status, OS version, screen. */
const ROW_CELLS = `const rowCells = (r) => [...r.querySelectorAll("[role=gridcell],[role=rowheader]")].map((c) => c.innerText.trim()).filter(Boolean);`;

export function createSaucePage(browser: BrowserRunner, deps: SaucePageDeps = defaultPageDeps) {
  /** Browser launches counted when the current session started; a later launch closed its page. */
  let launchesAtStart: number | null = null;

  async function evaluate<T>(script: string, timeoutMs?: number): Promise<T> {
    const data = await browser.run(["eval", script], timeoutMs);
    return data.result as T;
  }

  async function poll<T>(
    timeoutMs: number,
    probe: () => Promise<T | null | undefined | false>,
    intervalMs = 1500,
  ): Promise<T | null> {
    const deadline = deps.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (deps.now() >= deadline) return null;
      await deps.sleep(intervalMs);
    }
  }

  async function state(): Promise<PageState> {
    const raw = await evaluate<{
      url: string;
      host: string;
      path: string;
      ended: boolean;
      device: string | null;
      capacity: boolean;
    }>(STATE_SCRIPT);
    const kind: PageState["kind"] =
      raw.host === "accounts.saucelabs.com"
        ? "signed_out"
        : raw.host !== "app.saucelabs.com"
          ? "other"
          : raw.path.startsWith("/live/mobile/")
            ? raw.ended
              ? "session_ended"
              : "session"
            : raw.path.startsWith("/live/")
              ? "live"
              : "other";
    return { url: raw.url, kind, device: raw.device, capacityReached: raw.capacity };
  }

  async function open(url: string) {
    await browser.run(["open", url], 60_000);
  }

  /** Loads Sauce Live unless a session page is showing; a session page is never navigated away from here. */
  async function home(): Promise<PageState> {
    let current = await state();
    if (current.kind === "session") return current;
    if (current.kind === "other" || current.kind === "session_ended") {
      await open(LIVE_HOME);
      current =
        (await poll(30_000, async () => {
          const next = await state();
          return next.kind === "other" ? null : next;
        })) ?? (await state());
    }
    if (current.kind === "live") {
      // A Live URL shows before Sauce's app checks the sign-in and redirects to
      // accounts.saucelabs.com, so wait for the app to render before trusting it.
      current =
        (await poll(
          20_000,
          async () => {
            const next = await state();
            if (next.kind !== "live") return next;
            return (await evaluate<boolean>(`!!document.querySelector("[data-qa]")`)) ? next : null;
          },
          700,
        )) ?? (await state());
    }
    return current;
  }

  async function signIn(): Promise<PageState> {
    // The link reads "Google"; "Authenticate with Google" is its title. It renders after the page loads.
    const clicked = await poll(
      15_000,
      () =>
        evaluate<boolean>(`(() => {
          const link = [...document.querySelectorAll("a")].find((a) => /service=googleTree/.test(a.getAttribute("href") || "") || /Authenticate with Google/i.test(a.title || ""));
          if (link) link.click();
          return !!link;
        })()`),
      700,
    );
    if (!clicked)
      throw new SauceError(
        "signed_out",
        "The Sauce sign-in page has no Authenticate with Google link.",
      );
    // Google may stop on its own page (a password or account prompt); that is not signed in.
    const signedIn = await poll(45_000, async () => {
      const next = await state();
      return next.kind === "signed_out" || next.kind === "other" ? null : next;
    });
    if (!signedIn) {
      throw new SauceError(
        "signed_out",
        "Authenticate with Google did not sign the Sauce browser back in.",
        "The saved Google session may have expired. Ask the user to sign in to Sauce Labs once in the sauce-live browser profile on the bb server machine.",
      );
    }
    return signedIn;
  }

  async function requireLive(): Promise<PageState> {
    const current = await home();
    if (current.kind === "signed_out") {
      throw new SauceError(
        "signed_out",
        "Sauce Labs is signed out.",
        "Run `bb sauce status --sign-in`.",
      );
    }
    if (current.kind === "session") {
      throw new SauceError(
        "session_active",
        `A live session on ${current.device ?? "a device"} is open in the Sauce browser.`,
        "Run `bb sauce status`. If the session is this thread's, run `bb sauce end` first; otherwise do not end it.",
      );
    }
    if (current.kind === "other") throw notOnSauce(current);
    // Sauce's capacity banner stays up after a failed start; reload the page so a stale
    // banner does not block browsing. A slot still busy shows at Start Test.
    if (current.capacityReached) await open(LIVE_HOME);
    // Narrow windows collapse the device search box; a fresh browser starts narrow.
    await browser.run(["set", "viewport", "1600", "1000"]);
    // A build's device page (/file/<id>/device) lacks the picker anchors below, so start from home.
    if (!current.capacityReached && !/\/live\/app-testing\/?(\?|#|$)/.test(current.url))
      await open(LIVE_HOME);
    // The device picker renders a few seconds after the URL settles.
    const ready = await poll(
      30_000,
      () =>
        evaluate<boolean>(
          `!!document.querySelector("[data-qa=search-dialog-input-trigger]") && !!document.querySelector("[data-qa=device-filter-bar-search]")`,
        ),
      700,
    );
    if (!ready) throw new SauceError("page_changed", "The Sauce Live device picker did not load.");
    return current;
  }

  /**
   * Runs one browser action and reports whether it landed. Sauce re-renders its
   * pickers and filter bars as they load and as views switch, so an action can hit
   * an element that is being replaced; callers retry until the page settles. A
   * missing browser is not a page race and still fails at once.
   */
  function tryAction(args: string[]): Promise<boolean> {
    return browser.run(args).then(
      () => true,
      (error: unknown) => {
        if (error instanceof BrowserUnavailableError) throw error;
        return false;
      },
    );
  }

  async function openAppPicker() {
    const ready = await poll(
      15_000,
      async () =>
        (await evaluate<boolean>(`!!document.querySelector("[data-qa=search-dialog]")`)) ||
        ((await tryAction(["click", "[data-qa=search-dialog-input-trigger]"])) &&
          evaluate<boolean>(`!!document.querySelector("[data-qa=search-dialog]")`)),
      700,
    );
    if (!ready) throw new SauceError("page_changed", "The Sauce app picker did not open.");
  }

  async function closeAppPicker() {
    await browser
      .run(["find", "role", "button", "click", "--name", "Dismiss", "--exact"])
      .catch(() => browser.run(["press", "Escape"]));
  }

  /** Builds in the open app picker, newest first, with their Sauce storage file ids. */
  async function appEntries(query: string | undefined): Promise<AppBuild[]> {
    if (query) {
      const filled = await poll(
        10_000,
        () => tryAction(["fill", "[data-qa=search-dialog-input]", query]),
        500,
      );
      if (!filled) throw new SauceError("page_changed", "The Sauce app picker has no search box.");
      await deps.sleep(1500);
    }
    const read = () =>
      evaluate<
        AppBuild[]
      >(`[...document.querySelectorAll('[data-qa^="app-search-and-select-file-id-"]')].map((e) => ({
      id: e.getAttribute("data-qa").slice("app-search-and-select-file-id-".length),
      label: (e.getAttribute("aria-label") || e.innerText || "").replace(/\\s+/g, " ").replace(/^App Build Icon /, "").trim(),
    }))`);
    // The picker fills its list after it opens; an empty read is usually too early.
    const apps = await poll(
      10_000,
      async () => {
        const found = await read();
        return found.length > 0 ? found : null;
      },
      700,
    );
    return apps ?? [];
  }

  async function listApps(query?: string): Promise<AppBuild[]> {
    await requireLive();
    await openAppPicker();
    const apps = await appEntries(query);
    await closeAppPicker();
    return apps;
  }

  /** Picks a build from app storage, newest first, and opens its device list; returns its label. */
  async function selectApp(query?: string): Promise<string> {
    const wanted = query?.toLowerCase();
    const pick = (apps: AppBuild[]) =>
      wanted
        ? apps.find(
            (candidate) =>
              candidate.label.toLowerCase().includes(wanted) || candidate.id === wanted,
          )
        : apps[0];
    await openAppPicker();
    // Match the newest builds locally first; Sauce's own search matches app names, not labels.
    let app = pick(await appEntries(undefined));
    if (!app && query) app = pick(await appEntries(query));
    await closeAppPicker();
    if (!app) {
      throw new SauceError(
        "not_found",
        query
          ? `No build in Sauce app storage matches "${query}".`
          : "Sauce app storage holds no builds.",
        "List builds with `bb sauce apps`.",
      );
    }
    await open(`${LIVE_HOME}/file/${app.id}/device`);
    const ready = await poll(
      30_000,
      () => evaluate<boolean>(`!!document.querySelector("[data-qa=device-filter-bar-search]")`),
      700,
    );
    if (!ready)
      throw new SauceError("page_changed", `The device list for "${app.label}" did not load.`);
    return app.label;
  }

  async function showDeviceTable(query: string) {
    // An IPA's device page keeps its Mobile Real tab hidden, and the role lookup that clicks
    // the tab skips hidden elements, so click only a visible one.
    const tabbed = await poll(
      5_000,
      () =>
        evaluate<boolean>(
          `[...document.querySelectorAll("[role=tab]")].some((tab) => tab.checkVisibility() && tab.innerText.trim() === "Mobile Real")`,
        ),
      500,
    );
    if (tabbed) {
      const clicked = await poll(
        8_000,
        () => tryAction(["find", "role", "tab", "click", "--name", "Mobile Real", "--exact"]),
        700,
      );
      if (!clicked) {
        const tabs = await evaluate<string[]>(
          `[...document.querySelectorAll("[role=tab]")].map((tab) => (tab.checkVisibility() ? "" : "hidden ") + JSON.stringify(tab.innerText.trim().slice(0, 40)))`,
        );
        throw new SauceError(
          "page_changed",
          `The Sauce device list's Mobile Real tab did not accept a click. Tabs: ${tabs.join(", ")}.`,
        );
      }
    }
    const table = await poll(
      10_000,
      () =>
        evaluate<boolean>(`(() => {
          const toggle = document.querySelector("[data-qa=device-filter-view-type-selection-table]");
          if (!toggle) return false;
          if (toggle.getAttribute("aria-pressed") !== "true") toggle.click();
          return true;
        })()`),
      700,
    );
    if (!table)
      throw new SauceError("page_changed", "The Sauce device list has no Table View toggle.");
    // Switching views re-renders the filter bar and can drop typed text, so confirm it stuck.
    const searched = await poll(
      12_000,
      async () => {
        // The search box is replaced while the view switches; a fill that lands then retries.
        if (!(await tryAction(["fill", "[data-qa=device-filter-bar-search]", query]))) return false;
        await deps.sleep(1500);
        return evaluate<boolean>(
          `document.querySelector("[data-qa=device-filter-bar-search]")?.value === ${JSON.stringify(query)}`,
        );
      },
      500,
    );
    if (!searched)
      throw new SauceError("page_changed", "The Sauce device search did not accept the query.");
    await deps.sleep(1000);
  }

  async function pageRows(): Promise<DeviceRow[]> {
    return evaluate<DeviceRow[]>(`(() => {
      ${ROW_CELLS}
      return [...document.querySelectorAll("[data-qa=device-table] [role=row]")]
        .map(rowCells)
        .filter((cells) => cells.length >= 4)
        .map(([name, status, os, ...screen]) => ({ name, status, os, screen: screen.join(" ") }));
    })()`);
  }

  /** Moves the device table to its next page; false on the last page. */
  async function nextPage(): Promise<boolean> {
    const clicked = await evaluate<string>(NEXT_PAGE);
    if (typeof clicked !== "string" || !clicked.startsWith("from:")) return false;
    const from = clicked.slice("from:".length);
    const moved = await poll(
      8_000,
      async () => (await evaluate<string>(CURRENT_PAGE)) !== from,
      300,
    );
    if (!moved)
      throw new SauceError("page_changed", "The Sauce device table did not turn the page.");
    // The rows render a moment after the pager updates.
    await deps.sleep(500);
    return true;
  }

  /**
   * Visits the device table page by page (Sauce shows 25 rows a page, newest OS
   * first) until \`stop\` accepts a page's rows or the pages run out.
   */
  async function walkRows(
    stop: (rows: DeviceRow[]) => boolean,
  ): Promise<{ rows: DeviceRow[]; truncated: boolean }> {
    const rows: DeviceRow[] = [];
    for (let page = 1; ; page += 1) {
      const found = await pageRows();
      rows.push(...found);
      if (stop(found)) return { rows, truncated: false };
      if (page >= MAX_DEVICE_PAGES) return { rows, truncated: true };
      if (!(await nextPage())) return { rows, truncated: false };
    }
  }

  /**
   * Devices that can run a build: Sauce filters the table by the build's platform,
   * so this selects the same build `bb sauce start` would (newest when `app` is omitted).
   */
  async function listDevices(
    query: string,
    app?: string,
  ): Promise<{ app: string; devices: DeviceRow[]; truncated: boolean }> {
    await requireLive();
    const label = await selectApp(app);
    await showDeviceTable(query);
    const { rows, truncated } = await walkRows(() => false);
    return { app: label, devices: rows, truncated };
  }

  function rowMatches(row: DeviceRow, device: string, os: string | undefined) {
    return (
      row.name.toLowerCase() === device.toLowerCase() &&
      (!os || row.os.toLowerCase().startsWith(os.toLowerCase()))
    );
  }

  async function selectRow(row: DeviceRow) {
    const clicked = await evaluate<boolean>(`(() => {
      const want = ${JSON.stringify(row)};
      ${ROW_CELLS}
      const row = [...document.querySelectorAll("[data-qa=device-table] [role=row]")].find((r) => {
        const [name, status, os] = rowCells(r);
        return name === want.name && status === want.status && os === want.os;
      });
      if (row) row.click();
      return !!row;
    })()`);
    if (!clicked)
      throw new SauceError(
        "page_changed",
        "The device row disappeared before it could be selected.",
      );
  }

  /**
   * Sauce renders Start Test once a row is selected and keeps it disabled while the
   * account's one live slot is in use; a disabled button is the busy slot.
   */
  async function clickStartTest(signal: AbortSignal | undefined) {
    const enabled = await poll(
      8_000,
      async () =>
        (await evaluate<"enabled" | "disabled" | null>(`(() => {
          const b = [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Start Test");
          return b ? (b.disabled || b.getAttribute("aria-disabled") === "true" ? "disabled" : "enabled") : null;
        })()`)) === "enabled",
      700,
    );
    if (!enabled) {
      const shown = await evaluate<boolean>(
        `[...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Start Test")`,
      );
      if (shown) throw capacityReached();
      throw new SauceError("page_changed", "Sauce showed no Start Test button for the device.");
    }
    // Last point where stopping costs nothing: after this click a device is coming up.
    if (signal?.aborted) throw cancelledError();
    const clicked = await tryAction([
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Start Test",
      "--exact",
    ]);
    if (clicked) return;
    if ((await state()).capacityReached) throw capacityReached();
    throw new SauceError("page_changed", "The Start Test button did not accept a click.");
  }

  /**
   * Waits for the session page after Start Test. Any way out other than the session
   * page or start_pending aborts the start, so no device comes up without a holder.
   */
  async function waitForSession(signal: AbortSignal | undefined): Promise<PageState | null> {
    let started: PageState | "cancelled" | null;
    try {
      started = await poll(
        150_000,
        async () => {
          if (signal?.aborted) return "cancelled" as const;
          // One failed read (the page navigating) must not abandon a device coming up.
          const next = await state().catch((error: unknown) => {
            if (error instanceof BrowserUnavailableError) throw error;
            return null;
          });
          if (!next) return null;
          if (next.capacityReached) return next;
          return next.kind === "session" && next.device ? next : null;
        },
        2500,
      );
    } catch (error) {
      await abortStart().catch(() => false);
      throw error;
    }
    if (started === "cancelled") {
      await abortStart();
      throw cancelledError();
    }
    return started;
  }

  /** Starts a live session; resolves with the Sauce device header once the session page shows. */
  async function startSession(
    input: { app?: string; device: string; os?: string },
    signal?: AbortSignal,
  ): Promise<{ app: string; device: string; url: string }> {
    await requireLive();
    const app = await selectApp(input.app);
    await showDeviceTable(input.device);
    const isWanted = (row: DeviceRow) =>
      rowMatches(row, input.device, input.os) && /^available$/i.test(row.status);
    // The table stays on the page where the wanted row was found, so it can be clicked.
    const { rows } = await walkRows((page) => page.some(isWanted));
    const matching = rows.filter((row) => rowMatches(row, input.device, input.os));
    const available = matching.find(isWanted);
    if (!available) {
      const seen = (matching.length > 0 ? matching : rows).slice(0, 12);
      throw new SauceError(
        "not_found",
        `No available real device named "${input.device}"${input.os ? ` on ${input.os}` : ""}. Seen: ${
          seen.map((row) => `${row.name} (${row.os}, ${row.status})`).join("; ") || "none"
        }.`,
        `Pick a name and os exactly as \`bb sauce devices\` lists them for this build (app: ${JSON.stringify(app)}).`,
      );
    }
    await selectRow(available);
    await clickStartTest(signal);
    const started = await waitForSession(signal);
    if (!started) {
      throw new SauceError(
        "start_pending",
        "Start Test was clicked, but the session page did not appear within 150 s.",
        "The device may still be starting, and this thread keeps it. Run `bb sauce status` in a minute: on session_mine, continue; otherwise run `bb sauce end` to free the device.",
      );
    }
    if (started.capacityReached && started.kind !== "session") throw capacityReached();
    launchesAtStart = browser.launches?.() ?? 0;
    return { app, device: started.device ?? available.name, url: started.url };
  }

  /**
   * Stops a start that Start Test set going: ends the session if its page is up,
   * otherwise leaves the page, which Sauce treats as abandoning the start (measured
   * 2026-11-13: a new session started 30 s after the session page was left).
   * Resolves true once the tab is off any session page.
   */
  async function abortStart(): Promise<boolean> {
    const current = await state();
    if (current.kind === "session") return endSession();
    await open(LIVE_HOME);
    const left = await poll(20_000, async () => (await state()).kind !== "session", 1000);
    if (!left) return endSession();
    return true;
  }

  async function requireSession(): Promise<PageState> {
    const current = await state();
    if (current.kind !== "session") {
      const restarted = launchesAtStart !== null && (browser.launches?.() ?? 0) > launchesAtStart;
      throw new SauceError(
        "no_session",
        current.kind === "session_ended"
          ? "The live session has ended (Sauce ends idle sessions after a few minutes)."
          : restarted
            ? "The shared Sauce browser restarted, which closed the session page."
            : "No live session is open.",
        restarted
          ? "Sauce may keep the slot busy for several minutes. Run `bb sauce status`; on capacity_reached, wait and retry `bb sauce start`."
          : "Start one with `bb sauce start`.",
      );
    }
    return current;
  }

  /** The device canvas; it mounts a moment after the session page shows, so wait for it. */
  async function canvasRect(): Promise<Rect> {
    const rect = await poll(
      10_000,
      async () => {
        const found = await evaluate<Rect | null>(`(() => {
          const c = document.querySelector(${JSON.stringify(CANVAS)});
          if (!c) return null;
          const r = c.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        })()`);
        return found && found.width >= 10 ? found : null;
      },
      500,
    );
    if (!rect)
      throw new SauceError(
        "page_changed",
        "The device screen did not appear on the session page within 10 s.",
        "Run `bb sauce status`; if it says session_mine, run `bb sauce look` again.",
      );
    return rect;
  }

  /**
   * Sends one gesture as a single agent-browser `batch`, so the browser daemon paces
   * the pointer events itself instead of one process spawn per event. A step that
   * fails after the finger went down would leave it held for the next command, so any
   * failure lifts it; a failed lift is retried once.
   */
  async function gesture(steps: readonly string[], timeoutMs: number) {
    try {
      await browser.run(["batch", "--bail", ...steps], timeoutMs);
    } catch (error) {
      await browser.run(["mouse", "up"]).catch(() => browser.run(["mouse", "up"]).catch(() => {}));
      throw error;
    }
  }

  /** The session and its canvas in one read; the canvas mounts a moment after the page. */
  async function pointerFrame(rotation: number) {
    const session = await requireSession();
    const rect = await canvasRect();
    return { rect, pointer: pointerRotation(rotation, session.device, rect) };
  }

  /** `rotation` is the screenshot's (picture) rotation; touches go through pointerRotation. */
  async function tap(point: Point, rotation: number, holdMs = 0) {
    const { rect, pointer } = await pointerFrame(rotation);
    const at = toViewport(point, pointer, rect);
    await gesture(
      [
        `mouse move ${at.x} ${at.y}`,
        "mouse down",
        ...(holdMs > 0 ? [`wait ${holdMs}`] : []),
        "mouse up",
      ],
      GESTURE_TIMEOUT_MS + holdMs,
    );
  }

  async function drag(
    from: Point,
    to: Point,
    rotation: number,
    durationMs: number,
    holdMs: number,
  ) {
    const { rect, pointer } = await pointerFrame(rotation);
    const start = toViewport(from, pointer, rect);
    const end = toViewport(to, pointer, rect);
    await gesture(
      [
        `mouse move ${start.x} ${start.y}`,
        "mouse down",
        ...dragMoves(start, end, durationMs),
        ...(holdMs > 0 ? [`wait ${holdMs}`] : []),
        "mouse up",
      ],
      GESTURE_TIMEOUT_MS + durationMs + holdMs,
    );
  }

  async function clickMenu(name: "Home" | "Rotate Device" | "Restart App" | "Developer Options") {
    await requireSession();
    await browser.run(["find", "role", "menuitem", "click", "--name", name, "--exact"]);
  }

  /** Clicks a marked element through agent-browser's download, which saves what the click downloads. */
  async function downloadMarked(markScript: string, path: string, what: string) {
    const marked = await evaluate<boolean>(markScript);
    if (!marked)
      throw new SauceError("page_changed", `The ${what} control is not on the session page.`);
    await browser.run(["download", "[data-bb-sauce-target]", path], 90_000);
  }

  /**
   * Grayscale thumbnail of the device area as the page shows it, before any rotation.
   * The session canvas is a transparent input layer over Sauce's video, so its pixels
   * are empty; a page screenshot of its box captures what is actually drawn there.
   */
  async function canvasThumbnail(path: string, width: number, height: number) {
    try {
      await browser.run(["screenshot", CANVAS, path]);
      return await pngGrayThumbnail(new Uint8Array(await readFile(path)), width, height);
    } catch {
      return null;
    }
  }

  /**
   * Saves Sauce's native, upright screenshot to `path` and reads its rotation. The
   * device area is sampled just before and just after the capture (beside `path`):
   * the capture takes a few seconds, and whichever frame matches it is compared.
   */
  async function captureScreen(path: string): Promise<{
    width: number;
    height: number;
    reading: RotationReading;
    /** Upright grayscale thumbnail of the capture, for comparing one look with the next. */
    thumbnail: Uint8Array | null;
  }> {
    await requireSession();
    const rect = await canvasRect();
    const canvas =
      rect.width >= rect.height
        ? { width: 48, height: Math.max(8, Math.round((48 * rect.height) / rect.width)) }
        : { width: Math.max(8, Math.round((48 * rect.width) / rect.height)), height: 48 };
    const before = await canvasThumbnail(`${path}.before.png`, canvas.width, canvas.height);
    await downloadMarked(
      `(() => {
        document.querySelectorAll("[data-bb-sauce-target]").forEach((e) => e.removeAttribute("data-bb-sauce-target"));
        const item = [...document.querySelectorAll('[role=menuitem]')].find((e) => e.innerText.trim() === "Take Screenshot");
        if (item) item.setAttribute("data-bb-sauce-target", "");
        return !!item;
      })()`,
      path,
      "Take Screenshot",
    );
    const after = await canvasThumbnail(`${path}.after.png`, canvas.width, canvas.height);
    const bytes = new Uint8Array(await readFile(path));
    const size = pngSize(bytes);
    if (!size)
      throw new SauceError("page_changed", "Sauce's Take Screenshot did not produce a PNG.");
    const sameShape = rect.width >= rect.height === size.width >= size.height;
    const candidates: readonly [number, number] = sameShape ? [0, 180] : [90, 270];
    const upright = sameShape ? canvas : { width: canvas.height, height: canvas.width };
    const pixels =
      (await pngGrayThumbnail(bytes, upright.width, upright.height)) ??
      (await deps.grayThumbnail(path, upright.width, upright.height));
    const reading = pixels
      ? scoreRotation([before, after], canvas, { ...upright, pixels }, candidates)
      : { candidates, best: null, clear: false };
    return { ...size, reading, thumbnail: pixels ?? null };
  }

  /**
   * A small grayscale sample of the device area as the page shows it now (not turned
   * upright), for telling whether the screen is still or has changed. One page
   * screenshot in one process, far cheaper than Sauce's native capture; its size
   * comes from the picture itself. Null when the canvas could not be captured.
   */
  async function sampleScreen(path: string): Promise<Uint8Array | null> {
    try {
      await browser.run(["screenshot", CANVAS, path]);
      const bytes = new Uint8Array(await readFile(path));
      const size = pngSize(bytes);
      if (!size || size.width < 10 || size.height < 10) return null;
      const scale = SAMPLE_EDGE / Math.max(size.width, size.height);
      return await pngGrayThumbnail(
        bytes,
        Math.max(8, Math.round(size.width * scale)),
        Math.max(8, Math.round(size.height * scale)),
      );
    } catch (error) {
      if (error instanceof BrowserUnavailableError) throw error;
      return null;
    }
  }

  async function openDeveloperTab(tab: "ADB Shell" | "Device Log") {
    const open = await evaluate<boolean>(
      `[...document.querySelectorAll('[role=tab]')].some((t) => t.innerText.trim() === ${JSON.stringify(tab)})`,
    );
    if (!open) {
      await clickMenu("Developer Options");
      await deps.sleep(1500);
    }
    await browser.run(["find", "role", "tab", "click", "--name", tab, "--exact"]);
    await deps.sleep(1200);
  }

  async function shell(command: string, timeoutMs: number): Promise<string> {
    const session = await requireSession();
    if (session.device && !/ - Android /.test(session.device)) {
      throw new SauceError("unsupported", "The ADB shell exists only on Android devices.");
    }
    await openDeveloperTab("ADB Shell");
    const echo = `adb shell ${command}`;
    const panelText = () =>
      evaluate<string | null>(`(() => {
        let n = document.querySelector(${JSON.stringify(SHELL_INPUT)});
        for (let i = 0; i < 10 && n; i += 1) {
          n = n.parentElement;
          if (n && n.innerText.includes(${JSON.stringify(echo)})) return n.innerText;
        }
        return null;
      })()`);
    // A repeated command already has an echo and prompt on screen; wait for a new echo.
    const echoesBefore = countOf(await panelText(), echo);
    // After the first command Sauce ignores a programmatic fill, and Enter submits an
    // empty line, so the command is typed. Sauce forwards keys pressed outside the
    // shell box to the phone, and after each command it moves focus to the device's
    // paste box; so every key waits until the shell box itself has focus.
    const focusShell = async () => {
      if (!(await tryAction(["focus", SHELL_INPUT]))) return false;
      return evaluate<boolean>(SHELL_FOCUSED);
    };
    const shellValue = () =>
      evaluate<string | null>(
        `document.querySelector(${JSON.stringify(SHELL_INPUT)})?.value ?? null`,
      );
    const notSent = (why: string) =>
      new SauceError(
        "page_changed",
        `adb shell ${command} was not sent: ${why}. No keys reached the device.`,
        "Run `bb sauce shell` again; if it keeps failing, run `bb sauce look` to check the device.",
      );
    if (!(await poll(5_000, focusShell, 500)))
      throw notSent("the ADB shell box did not take focus");
    if ((await shellValue()) !== "") {
      await browser.run(["press", "Control+a"]);
      if (!(await evaluate<boolean>(SHELL_FOCUSED))) throw notSent("the ADB shell box lost focus");
      await browser.run(["press", "Backspace"]);
    }
    if (!(await evaluate<boolean>(SHELL_FOCUSED))) throw notSent("the ADB shell box lost focus");
    await browser.run(["keyboard", "type", command]);
    if ((await shellValue()) !== command) {
      throw notSent("the ADB shell box did not hold the typed command");
    }
    if (!(await evaluate<boolean>(SHELL_FOCUSED))) throw notSent("the ADB shell box lost focus");
    await browser.run(["press", "Enter"]);
    const output = await poll(
      timeoutMs,
      async () => {
        const text = await panelText();
        if (!text || countOf(text, echo) <= echoesBefore) return null;
        const after = text.slice(text.lastIndexOf(echo) + echo.length);
        // The panel prints a fresh "<device> : /$ adb shell" prompt once the command finishes.
        const prompt = after.search(/\n[^\n]*: \/\$ adb shell\s*$/);
        return prompt >= 0 ? after.slice(0, prompt).trim() || "(no output)" : null;
      },
      800,
    );
    if (output === null)
      throw new SauceError(
        "timeout",
        `adb shell ${command} printed no prompt within ${timeoutMs} ms.`,
      );
    return output;
  }

  /**
   * The log toolbar's buttons are bare icons; only their hover tooltips (react-aria,
   * via aria-describedby) name them, and Clear Log sits beside Download Log. So each
   * candidate is hovered and clicked only when its own tooltip reads "Download Log".
   */
  async function findDownloadLogButton(): Promise<boolean> {
    const markIcons = () =>
      evaluate<number>(`(() => {
      document.querySelectorAll("[data-bb-sauce-probe],[data-bb-sauce-target]").forEach((e) => {
        e.removeAttribute("data-bb-sauce-probe");
        e.removeAttribute("data-bb-sauce-target");
      });
      const level = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.text === "VERBOSE"));
      let bar = level;
      while (bar && bar.querySelectorAll("button").length < 5) bar = bar.parentElement;
      if (!bar) return 0;
      const icons = [...bar.querySelectorAll("button")].filter((b) => !b.innerText.trim() && b.querySelector("svg"));
      icons.forEach((b, i) => b.setAttribute("data-bb-sauce-probe", String(i)));
      return icons.length;
    })()`);
    // The toolbar renders a moment after the Device Log tab opens.
    const count =
      (await poll(10_000, async () => ((await markIcons()) >= 5 ? markIcons() : null), 500)) ?? 0;
    const tooltipOf = async (probe: string) => {
      await browser.run(["hover", probe]);
      return poll(
        1500,
        () =>
          evaluate<string | null>(`(() => {
            const id = document.querySelector(${JSON.stringify(probe)})?.getAttribute("aria-describedby");
            const tip = id && document.getElementById(id);
            return tip ? tip.innerText.trim() : null;
          })()`),
        250,
      );
    };
    // Download Log has been the last icon; try it first, then the rest. On a freshly
    // opened page the first hover shows no tooltip; once another tooltip has opened
    // they all open at once, so buttons that showed none get a second hover.
    const order = Array.from({ length: count }, (_, i) => count - 1 - i);
    const silent: number[] = [];
    for (const index of order) {
      const probe = `[data-bb-sauce-probe="${index}"]`;
      const tooltip = await tooltipOf(probe);
      if (tooltip === null) silent.push(index);
      if (tooltip && /^download log$/i.test(tooltip)) return markTarget(probe);
    }
    for (const index of silent) {
      const probe = `[data-bb-sauce-probe="${index}"]`;
      const tooltip = await tooltipOf(probe);
      if (tooltip && /^download log$/i.test(tooltip)) return markTarget(probe);
    }
    return false;
  }

  async function markTarget(probe: string) {
    await evaluate(
      `document.querySelector(${JSON.stringify(probe)}).setAttribute("data-bb-sauce-target", "")`,
    );
    return true;
  }

  async function downloadLog(path: string) {
    await requireSession();
    await openDeveloperTab("Device Log");
    if (!(await findDownloadLogButton())) {
      throw new SauceError(
        "page_changed",
        "No button in the Device Log toolbar has a Download Log tooltip, so nothing was clicked.",
      );
    }
    await browser.run(["download", "[data-bb-sauce-target]", path], 90_000);
  }

  async function endSession(): Promise<boolean> {
    const current = await state();
    if (current.kind !== "session") return false;
    // A missing or covered button falls through to leaving the page below.
    if (await tryAction(["find", "role", "button", "click", "--name", "End Session", "--exact"])) {
      // Older layouts asked to confirm.
      await deps.sleep(1500);
      await evaluate(`(() => {
        const b = [...document.querySelectorAll("button")].filter((b) => /^(End Session|End|Yes|Confirm)$/i.test(b.innerText.trim()) && b.offsetParent);
        if (b.length > 1) b.at(-1).click();
        return b.length;
      })()`).catch(() => 0);
      const ended = await poll(20_000, async () => (await state()).kind !== "session", 1000);
      if (ended) return true;
    }
    // The End Session click missed or the page hung. Leaving the session page closes
    // its device connection, which Sauce treats as the end of the session (measured
    // 2026-11-13: the slot took a new session 30 s after the page was left).
    await open(LIVE_HOME);
    const left = await poll(20_000, async () => (await state()).kind !== "session", 1000);
    if (!left) {
      throw new SauceError(
        "timeout",
        "The live session did not end, and the browser could not leave its page.",
        "Run `bb sauce end` again; if it keeps failing, ask the user to check the sauce-live browser on the bb server machine.",
      );
    }
    return true;
  }

  return {
    state,
    home,
    signIn,
    listApps,
    listDevices,
    startSession,
    tap,
    drag,
    clickMenu,
    captureScreen,
    sampleScreen,
    requireSession,
    shell,
    downloadLog,
    endSession,
    abortStart,
  };
}

function cancelledError() {
  return new SauceError("cancelled", "The command was cancelled.");
}

export function capacityReached() {
  return new SauceError(
    "capacity_reached",
    "Sauce reports the account's one live-device slot is in use by another session.",
    "Another thread or person holds the device. Run `bb sauce status` to see whether a bb thread holds the lease.",
  );
}

export function notOnSauce(current: PageState) {
  return new SauceError(
    "page_changed",
    `The Sauce browser did not reach Sauce Live; it shows ${current.url.slice(0, 120)}.`,
    "The bb server machine may be offline, or Sauce may be down. Run `bb sauce status` again in a minute; if it persists, report it.",
  );
}

export type SaucePage = ReturnType<typeof createSaucePage>;

function countOf(text: string | null, needle: string): number {
  if (!text) return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length))
    count += 1;
  return count;
}

/**
 * Where a point given as fractions of the upright screenshot falls on the session
 * canvas, as fractions of the canvas. `rotation` is the clockwise turn from canvas
 * to upright.
 */
export function canvasFraction(point: Point, rotation: number): [number, number] {
  const { x: u, y: v } = point;
  return rotation === 90
    ? [v, 1 - u]
    : rotation === 180
      ? [1 - u, 1 - v]
      : rotation === 270
        ? [1 - v, u]
        : [u, v];
}

/**
 * The rotation a touch is mapped through, from the picture rotation a screenshot
 * measured. Measured live on an iPhone 13 (iOS 27.0), 2026-11-13:
 * - Portrait canvas, landscape app (picture reads 90): Sauce reads the pointer in a
 *   frame turned 180 degrees from the picture, so touches need 270.
 * - Portrait canvas with a portrait screen (0), and a canvas turned landscape by
 *   Rotate Device with a portrait (90) or landscape (0) screen: touches follow the picture.
 * Android follows the picture in every case measured.
 */
export function pointerRotation(rotation: number, device: string | null, canvas: Rect): number {
  const ios = device !== null && / - iOS /.test(`${device} `);
  const portraitCanvas = canvas.height > canvas.width;
  if (ios && portraitCanvas && (rotation === 90 || rotation === 270)) return (rotation + 180) % 360;
  return rotation;
}

/**
 * Maps a point given as fractions of the upright screenshot to viewport pixels on
 * the canvas. The canvas's right and bottom edges are exclusive, so fraction 1
 * lands on its last pixel rather than the first pixel outside it.
 */
export function toViewport(point: Point, rotation: number, rect: Rect): { x: number; y: number } {
  const [cx, cy] = canvasFraction(point, rotation);
  const clamp = (value: number, start: number, size: number) =>
    Math.min(Math.ceil(start + size) - 1, Math.max(Math.ceil(start), Math.round(value)));
  return {
    x: clamp(rect.left + cx * rect.width, rect.left, rect.width),
    y: clamp(rect.top + cy * rect.height, rect.top, rect.height),
  };
}
