// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppBlock } from "./AppBlock";
import { APPS_STORAGE_BUDGET, parseAppMessage, parseStorageItems, readAppStorage, saveAppStorage } from "./appBridge";
import { APP_STORAGE_CAP, appFileName, buildSrcdoc, resolveTheme, themeCss } from "./appDocument";

/** Vitest's jsdom environment exposes the JSDOM instance; only its window is used here. */
declare const jsdom: { window: Window & typeof globalThis };

const openUrl = vi.hoisted(() => vi.fn(() => true));

// BB's runtime is replaced by a thread with no composer on screen.
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  useComposers: () => [],
  useSdk: () => ({}),
  useBbNavigate: () => ({ openUrl }),
  useRpc: () => ({ call: vi.fn() }),
  useSettings: () => ({ values: { animations: true }, isLoading: false }),
  experimental_Icon: () => <span aria-hidden="true" />,
}));

const HOST: Record<string, string> = {
  "--background": " #fff ",
  "--foreground": "oklch(0.2 0 0)",
  "--surface-recessed": "#f4f4f4",
  "--primary": "#111",
  "--warning": "orange",
  "font-family": '"Inter Variable", sans-serif',
  "color-scheme": "light",
};

describe("resolveTheme", () => {
  const theme = resolveTheme((property) => HOST[property] ?? "");

  it("maps host properties onto the app's variable names, with fallbacks", () => {
    expect(theme["--background"]).toBe("#fff");
    expect(theme["--muted"]).toBe("#f4f4f4");
    expect(theme["--card"]).toBe("#fff");
    expect(theme["--accent"]).toBe("#111");
    expect(theme["--warning-text"]).toBe("orange");
    expect(theme["--font-sans"]).toBe('"Inter Variable", sans-serif');
    expect(theme["color-scheme"]).toBe("light");
  });

  it("prefers the timeline accent and omits unset variables", () => {
    const accented: Record<string, string> = { ...HOST, "--color-timeline-accent": "teal" };
    expect(resolveTheme((property) => accented[property] ?? "")["--accent"]).toBe("teal");
    expect("--font-mono" in theme).toBe(false);
  });

  it("drops values that could escape the theme style element", () => {
    const hostile = resolveTheme((property) =>
      property === "--foreground" ? "red}</style><script>alert(1)</script>" : (HOST[property] ?? ""),
    );
    expect("--foreground" in hostile).toBe(false);
  });
});

describe("buildSrcdoc", () => {
  const html = "<!doctype html><html><body><canvas></canvas><script>start()</script></body></html>";
  const theme = { "--background": "#fff", "color-scheme": "dark" };
  const srcdoc = buildSrcdoc(html, { theme, motionOff: false, storage: {} });

  it("puts our doctype and the CSP before anything else, and the model's HTML last", () => {
    expect(srcdoc.startsWith("<!doctype html>\n<meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(srcdoc).toContain("default-src 'none'; script-src 'unsafe-inline'");
    expect(srcdoc.endsWith(html)).toBe(true);
    expect(srcdoc.indexOf("<script>(function(config){")).toBeLessThan(srcdoc.indexOf(html));
  });

  it("bakes the theme into the replaceable theme style", () => {
    expect(srcdoc).toContain(`<style id="genui-theme">${themeCss(theme)}</style>`);
    expect(themeCss(theme)).toBe(":root{--background:#fff;color-scheme:dark}");
  });

  it("hands restored storage to the page intact, even values that look like markup", () => {
    const storage: Record<string, string> = JSON.parse('{"__proto__":"kept","note":"</script><script>alert(1)</script>"}');
    const restored = buildSrcdoc("", { theme, motionOff: true, storage });
    expect(restored).not.toContain("</script><script>alert(1)");
    const config = /\}\)\((JSON\.parse\(.*\))\);<\/script>/.exec(restored)?.[1];
    const value = new Function(`return ${config}`)() as { storage: Record<string, string>; motionOff: boolean };
    expect(Object.entries(value.storage)).toEqual([
      ["__proto__", "kept"],
      ["note", "</script><script>alert(1)</script>"],
    ]);
    expect(value.motionOff).toBe(true);
  });
});

describe("appFileName", () => {
  it("names the download from the document's title", () => {
    expect(appFileName("<head><title> Orbit: launch / plan </title></head>")).toBe("Orbit launch plan.html");
    expect(appFileName("<title></title><p>x</p>")).toBe("app.html");
    expect(appFileName("<p>no title</p>")).toBe("app.html");
  });
});

describe("parseAppMessage", () => {
  it("accepts every message shape", () => {
    expect(parseAppMessage({ source: "genui-app", type: "height", height: 312.5 })).toEqual({ type: "height", height: 312.5 });
    expect(parseAppMessage({ source: "genui-app", type: "error", message: "boom" })).toEqual({ type: "error", message: "boom" });
    expect(parseAppMessage({ source: "genui-app", type: "storage", items: { best: "12" } })).toEqual({ type: "storage", items: { best: "12" } });
    expect(parseAppMessage({ source: "genui-app", type: "blocked", what: "alert" })).toEqual({ type: "blocked", call: "alert" });
    expect(parseAppMessage({ source: "genui-app", type: "answer", text: "  Plan B  " })).toEqual({ type: "answer", text: "Plan B" });
    expect(parseAppMessage({ source: "genui-app", type: "answer", text: null })).toEqual({ type: "answer", text: null });
    expect(parseAppMessage({ source: "genui-app", type: "openLink", url: "https://example.com/a b" })).toEqual({
      type: "openLink",
      url: "https://example.com/a%20b",
    });
    expect(parseAppMessage({ source: "genui-app", type: "escape" })).toEqual({ type: "escape" });
  });

  it("rejects anything else", () => {
    for (const data of [
      null,
      "height",
      [],
      { type: "height", height: 10 },
      { source: "other", type: "height", height: 10 },
      { source: "genui-app", type: "height", height: "10" },
      { source: "genui-app", type: "height", height: Number.NaN },
      { source: "genui-app", type: "height", height: -1 },
      { source: "genui-app", type: "height", height: 10, extra: true },
      { source: "genui-app", type: "error", message: 42 },
      { source: "genui-app", type: "theme", css: "" },
      { source: "genui-app", type: "storage", items: { best: 12 } },
      { source: "genui-app", type: "storage", items: ["12"] },
      { source: "genui-app", type: "storage", data: {} },
      { source: "genui-app", type: "blocked", what: "print" },
      { source: "genui-app", type: "answer", text: 3 },
      { source: "genui-app", type: "answer", value: "Plan B" },
      { source: "genui-app", type: "openLink", url: "http://example.com" },
      { source: "genui-app", type: "openLink", url: "javascript:alert(1)" },
      { source: "genui-app", type: "openLink", url: `https://example.com/${"x".repeat(2048)}` },
      { source: "genui-app", type: "escape", key: "Escape" },
    ]) {
      expect(parseAppMessage(data)).toBeNull();
    }
  });

  it("caps error messages and answers, and reads an empty answer as taking it back", () => {
    const error = parseAppMessage({ source: "genui-app", type: "error", message: "x".repeat(2000) });
    expect(error?.type === "error" && error.message.length).toBe(500);
    const answer = parseAppMessage({ source: "genui-app", type: "answer", text: "y".repeat(5000) });
    expect(answer?.type === "answer" && answer.text?.length).toBe(2000);
    expect(parseAppMessage({ source: "genui-app", type: "answer", text: "   " })).toEqual({ type: "answer", text: null });
  });
});

describe("app storage", () => {
  beforeEach(() => {
    // Node 25+ has its own global localStorage (undefined without --localstorage-file), which hides jsdom's.
    vi.stubGlobal("localStorage", jsdom.window.localStorage);
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("holds up to the cap, counting keys and values", () => {
    const key = "k";
    expect(parseStorageItems({ [key]: "v".repeat(APP_STORAGE_CAP - key.length) })).not.toBeNull();
    expect(parseStorageItems({ [key]: "v".repeat(APP_STORAGE_CAP - key.length + 1) })).toBeNull();
  });

  it("restores what an app saved, and nothing for a damaged copy", () => {
    saveAppStorage("app:1", { best: "12" });
    expect(readAppStorage("app:1")).toEqual({ best: "12" });
    localStorage.setItem("app:2:storage", "{not json");
    expect(readAppStorage("app:2")).toEqual({});
    saveAppStorage("app:1", {});
    expect(readAppStorage("app:1")).toEqual({});
  });

  it("drops the apps written longest ago once together they pass the budget", () => {
    const big = { data: "x".repeat(APP_STORAGE_CAP - 4) };
    const apps = Math.floor(APPS_STORAGE_BUDGET / APP_STORAGE_CAP) + 1;
    for (let app = 0; app < apps; app++) saveAppStorage(`app:${app}`, big);
    expect(readAppStorage("app:0")).toEqual({});
    for (let app = 1; app < apps; app++) expect(readAppStorage(`app:${app}`)).toEqual(big);
    // Writing again makes an app the newest: the next one over the budget goes instead.
    saveAppStorage("app:1", big);
    saveAppStorage("app:0", big);
    expect(readAppStorage("app:1")).toEqual(big);
    expect(readAppStorage("app:2")).toEqual({});
  });
});

describe("an app on screen", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    // jsdom has no Web Animations; the sent line's entrance needs one.
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: () => ({ cancel() {} }) });
    vi.stubGlobal("localStorage", jsdom.window.localStorage);
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(Element.prototype, "animate");
  });

  function mount(answers: Parameters<typeof AppBlock>[0]["answers"]) {
    act(() => root.render(<AppBlock html="<button>Pick</button>" ready stateKey={`app:${Math.random()}`} answers={answers} />));
    const frame = container.querySelector<HTMLIFrameElement>('iframe[title="App"]')!;
    return (data: Record<string, unknown>, source: Window | null = frame.contentWindow) =>
      act(() => window.dispatchEvent(new MessageEvent("message", { data: { source: "genui-app", ...data }, source })));
  }

  it("puts its answer where the user's message gets it, and takes it back", () => {
    const post = mount({ kind: "gallery" });
    post({ type: "answer", text: "Plan B" });
    expect(container.textContent).toContain("Would go in your message");
    post({ type: "answer", text: null });
    expect(container.textContent).not.toContain("Would go in your message");
    // Only the app's own frame is heard.
    post({ type: "answer", text: "Plan C" }, window);
    expect(container.textContent).not.toContain("Would go in your message");
  });

  it("sends the answer at once in a thread with no composer, then shows it sent", async () => {
    const send = vi.fn(async () => undefined);
    const post = mount({ kind: "thread", threadId: `thr_${Math.random()}`, messageId: "m", fence: 0, reply: 0, send });
    post({ type: "answer", text: "Plan B" });
    await act(async () => undefined);
    expect(send).toHaveBeenCalledWith("Plan B");
    expect(container.textContent).toContain("Plan B");
  });

  it("notes a dialog it can't show, and opens https links in BB", () => {
    const post = mount({ kind: "gallery" });
    post({ type: "blocked", what: "alert" });
    expect(container.textContent).toContain("alert()");
    post({ type: "openLink", url: "https://example.com/docs" });
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  });
});
