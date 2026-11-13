import { execFile } from "node:child_process";
import type { BrowserRunner } from "./browser.ts";

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
  | "session_active"
  | "not_found"
  | "unsupported"
  | "timeout"
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
  /** Raw 8-bit grayscale pixels of an image file resized to width x height, or null without ImageMagick. */
  grayThumbnail(path: string, width: number, height: number): Promise<Uint8Array | null>;
};

export const defaultPageDeps: SaucePageDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  grayThumbnail: (path, width, height) =>
    new Promise((resolve) => {
      execFile(
        "magick",
        [path, "-resize", `${width}x${height}!`, "-colorspace", "gray", "-depth", "8", "gray:-"],
        { encoding: "buffer", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => resolve(error ? null : new Uint8Array(stdout)),
      );
    }),
};

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

/** Non-empty cell texts of a device-table row: name, status, OS version, screen. */
const ROW_CELLS = `const rowCells = (r) => [...r.querySelectorAll("[role=gridcell],[role=rowheader]")].map((c) => c.innerText.trim()).filter(Boolean);`;

export function createSaucePage(browser: BrowserRunner, deps: SaucePageDeps = defaultPageDeps) {
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
    const signedIn = await poll(45_000, async () => {
      const next = await state();
      return next.kind === "signed_out" ? null : next;
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
        "Call sauce_status with sign_in: true.",
      );
    }
    if (current.kind === "session") {
      throw new SauceError(
        "session_active",
        `A live session on ${current.device ?? "a device"} is open in the Sauce browser.`,
        "End it with sauce_end before browsing apps or devices.",
      );
    }
    // Narrow windows collapse the device search box; a fresh browser starts narrow.
    await browser.run(["set", "viewport", "1600", "1000"]);
    if (!current.url.includes("/live/app-testing")) await open(LIVE_HOME);
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

  async function openAppPicker() {
    await browser.run(["click", "[data-qa=search-dialog-input-trigger]"]);
    const ready = await poll(
      15_000,
      () => evaluate<boolean>(`!!document.querySelector("[data-qa=search-dialog]")`),
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
      await browser.run(["fill", "[data-qa=search-dialog-input]", query]);
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
        "List builds with sauce_catalog kind: apps.",
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
    await browser.run(["find", "role", "tab", "click", "--name", "Mobile Real", "--exact"]);
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
        await browser.run(["fill", "[data-qa=device-filter-bar-search]", query]);
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

  async function deviceRows(): Promise<DeviceRow[]> {
    return evaluate<DeviceRow[]>(`(() => {
      ${ROW_CELLS}
      return [...document.querySelectorAll("[data-qa=device-table] [role=row]")]
        .map(rowCells)
        .filter((cells) => cells.length >= 4)
        .map(([name, status, os, ...screen]) => ({ name, status, os, screen: screen.join(" ") }));
    })()`);
  }

  async function listDevices(query: string): Promise<DeviceRow[]> {
    await requireLive();
    await showDeviceTable(query);
    return deviceRows();
  }

  function rowMatches(row: DeviceRow, device: string, os: string | undefined) {
    return (
      row.name.toLowerCase() === device.toLowerCase() &&
      (!os || row.os.toLowerCase().startsWith(os.toLowerCase()))
    );
  }

  /** Starts a live session; resolves with the Sauce device header once the session page shows. */
  async function startSession(input: {
    app?: string;
    device: string;
    os?: string;
  }): Promise<{ app: string; device: string; url: string }> {
    await requireLive();
    const app = await selectApp(input.app);
    await showDeviceTable(input.device);
    const rows = await deviceRows();
    const matching = rows.filter((row) => rowMatches(row, input.device, input.os));
    const available = matching.find((row) => /^available$/i.test(row.status));
    if (!available) {
      const seen = (matching.length > 0 ? matching : rows).slice(0, 12);
      throw new SauceError(
        "not_found",
        `No available real device named "${input.device}"${input.os ? ` on ${input.os}` : ""}. Seen: ${
          seen.map((row) => `${row.name} (${row.os}, ${row.status})`).join("; ") || "none"
        }.`,
        "Pick a name and os exactly as sauce_catalog kind: devices lists them.",
      );
    }
    const clicked = await evaluate<boolean>(`(() => {
      const want = ${JSON.stringify(available)};
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
    await deps.sleep(1200);
    await browser.run(["find", "role", "button", "click", "--name", "Start Test", "--exact"]);
    const started = await poll(
      150_000,
      async () => {
        const next = await state();
        if (next.capacityReached) return next;
        return next.kind === "session" && next.device ? next : null;
      },
      2500,
    );
    if (!started) throw new SauceError("timeout", "The live session did not start within 150 s.");
    if (started.capacityReached && started.kind !== "session") {
      throw new SauceError(
        "capacity_reached",
        "Sauce reports the account's one live-device slot is in use by another session.",
        "Another thread or person holds the device. Run sauce_status to see whether a bb thread holds the lease.",
      );
    }
    return { app, device: started.device ?? available.name, url: started.url };
  }

  async function requireSession(): Promise<PageState> {
    const current = await state();
    if (current.kind !== "session") {
      throw new SauceError(
        "no_session",
        current.kind === "session_ended"
          ? "The live session has ended (Sauce ends idle sessions after a few minutes)."
          : "No live session is open.",
        "Start one with sauce_start.",
      );
    }
    return current;
  }

  async function canvasRect(): Promise<Rect> {
    const rect = await evaluate<Rect | null>(`(() => {
      const c = document.querySelector(${JSON.stringify(CANVAS)});
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`);
    if (!rect || rect.width < 10)
      throw new SauceError("page_changed", "The device screen is not on the session page.");
    return rect;
  }

  async function mouse(...args: string[]) {
    await browser.run(["mouse", ...args]);
  }

  async function tap(point: Point, rotation: number) {
    await requireSession();
    const at = toViewport(point, rotation, await canvasRect());
    await mouse("move", `${at.x}`, `${at.y}`);
    await mouse("down");
    await mouse("up");
  }

  async function drag(
    from: Point,
    to: Point,
    rotation: number,
    durationMs: number,
    holdMs: number,
  ) {
    await requireSession();
    const rect = await canvasRect();
    const start = toViewport(from, rotation, rect);
    const end = toViewport(to, rotation, rect);
    const steps = Math.max(2, Math.min(20, Math.round(durationMs / 50)));
    await mouse("move", `${start.x}`, `${start.y}`);
    await mouse("down");
    try {
      for (let step = 1; step <= steps; step += 1) {
        const x = Math.round(start.x + ((end.x - start.x) * step) / steps);
        const y = Math.round(start.y + ((end.y - start.y) * step) / steps);
        await mouse("move", `${x}`, `${y}`);
        if (durationMs > 0) await deps.sleep(durationMs / steps);
      }
      if (holdMs > 0) await deps.sleep(holdMs);
    } finally {
      await mouse("up");
    }
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
    await browser.run(["download", "[data-ks-sauce-target]", path], 90_000);
  }

  async function nativeScreenshot(path: string) {
    await requireSession();
    await downloadMarked(
      `(() => {
        document.querySelectorAll("[data-ks-sauce-target]").forEach((e) => e.removeAttribute("data-ks-sauce-target"));
        const item = [...document.querySelectorAll('[role=menuitem]')].find((e) => e.innerText.trim() === "Take Screenshot");
        if (item) item.setAttribute("data-ks-sauce-target", "");
        return !!item;
      })()`,
      path,
      "Take Screenshot",
    );
  }

  /** Grayscale thumbnails of the live canvas turned by each candidate rotation, sized width x height. */
  async function canvasThumbnails(width: number, height: number, rotations: number[]) {
    return evaluate<Record<string, number[]> | null>(`(() => {
      const c = document.querySelector(${JSON.stringify(CANVAS)});
      if (!c) return null;
      const out = {};
      for (const r of ${JSON.stringify(rotations)}) {
        const o = document.createElement("canvas");
        o.width = ${width}; o.height = ${height};
        const g = o.getContext("2d");
        g.translate(${width} / 2, ${height} / 2);
        g.rotate((r * Math.PI) / 180);
        const [w, h] = r % 180 === 0 ? [${width}, ${height}] : [${height}, ${width}];
        g.drawImage(c, -w / 2, -h / 2, w, h);
        const d = g.getImageData(0, 0, ${width}, ${height}).data;
        const gray = [];
        for (let i = 0; i < d.length; i += 4) gray.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
        out[r] = gray;
      }
      return out;
    })()`);
  }

  /**
   * Finds the clockwise rotation that turns the session canvas into the upright
   * device screenshot. Sauce shows a landscape game sideways in a portrait canvas.
   */
  async function measureRotation(screenshotPath: string, size: { width: number; height: number }) {
    const rect = await canvasRect();
    const sameShape = rect.width >= rect.height === size.width >= size.height;
    const candidates = sameShape ? [0, 180] : [90, 270];
    const width = 48;
    const height = Math.max(8, Math.round((48 * size.height) / size.width));
    const native = await deps.grayThumbnail(screenshotPath, width, height);
    const thumbs = native ? await canvasThumbnails(width, height, candidates) : null;
    if (!native || !thumbs) return candidates[0] as number;
    let best = candidates[0] as number;
    let bestError = Number.POSITIVE_INFINITY;
    for (const rotation of candidates) {
      const pixels = thumbs[rotation];
      if (!pixels) continue;
      let error = 0;
      for (let i = 0; i < native.length; i += 1)
        error += ((pixels[i] ?? 0) - (native[i] ?? 0)) ** 2;
      if (error < bestError) {
        best = rotation;
        bestError = error;
      }
    }
    return best;
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
    await browser.run(["fill", "textarea", command]);
    await browser.run(["press", "Enter"]);
    const echo = `adb shell ${command}`;
    const output = await poll(
      timeoutMs,
      async () => {
        const text = await evaluate<string | null>(`(() => {
        let n = document.querySelector("textarea");
        for (let i = 0; i < 10 && n; i += 1) {
          n = n.parentElement;
          if (n && n.innerText.includes(${JSON.stringify(echo)})) return n.innerText;
        }
        return null;
      })()`);
        if (!text) return null;
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

  async function downloadLog(path: string) {
    await requireSession();
    await openDeveloperTab("Device Log");
    await downloadMarked(
      `(() => {
        document.querySelectorAll("[data-ks-sauce-target]").forEach((e) => e.removeAttribute("data-ks-sauce-target"));
        const level = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.text === "VERBOSE"));
        let bar = level;
        while (bar && bar.querySelectorAll("button").length < 5) bar = bar.parentElement;
        if (!bar) return false;
        // Toolbar order after the filters: Search, Pause, Wrap Text, Clear Log, Download Log.
        const icons = [...bar.querySelectorAll("button")].filter((b) => !b.innerText.trim() && b.querySelector("svg"));
        const download = icons[4];
        if (download) download.setAttribute("data-ks-sauce-target", "");
        return !!download;
      })()`,
      path,
      "Download Log",
    );
  }

  async function endSession(): Promise<boolean> {
    const current = await state();
    if (current.kind !== "session") return false;
    await browser.run(["find", "role", "button", "click", "--name", "End Session", "--exact"]);
    // Older layouts asked to confirm.
    await deps.sleep(1500);
    await evaluate(`(() => {
      const b = [...document.querySelectorAll("button")].filter((b) => /^(End Session|End|Yes|Confirm)$/i.test(b.innerText.trim()) && b.offsetParent);
      if (b.length > 1) b.at(-1).click();
      return b.length;
    })()`);
    const ended = await poll(20_000, async () => (await state()).kind !== "session", 1000);
    if (!ended) throw new SauceError("timeout", "The live session did not end within 20 s.");
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
    nativeScreenshot,
    measureRotation,
    shell,
    downloadLog,
    endSession,
  };
}

export type SaucePage = ReturnType<typeof createSaucePage>;

/**
 * Maps a point given as fractions of the upright screenshot to viewport pixels
 * on the session canvas. `rotation` is the clockwise turn from canvas to upright.
 */
export function toViewport(point: Point, rotation: number, rect: Rect): { x: number; y: number } {
  const { x: u, y: v } = point;
  const [cx, cy] =
    rotation === 90
      ? [v, 1 - u]
      : rotation === 180
        ? [1 - u, 1 - v]
        : rotation === 270
          ? [1 - v, u]
          : [u, v];
  return {
    x: Math.round(rect.left + cx * rect.width),
    y: Math.round(rect.top + cy * rect.height),
  };
}
