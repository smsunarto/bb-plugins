// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalCodeFenceRendererProps, PluginSettingsState } from "@get-bb/plugin-sdk/app";
import { SlotFence } from "./SlotFence";

/** The plugin's settings as BB serves them: a store its subscribers re-render from, like BB's query. */
const settings = vi.hoisted(() => {
  let state: PluginSettingsState = { values: { animations: true }, isLoading: false };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(values: PluginSettingsState["values"]) {
      state = { values, isLoading: false };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

// Only BB's runtime is replaced; compilation, Fence, AppBlock and diagnostics are real.
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  useComposers: () => [],
  useSdk: () => ({}),
  useBbNavigate: () => ({}),
  useRpc: () => ({ call: vi.fn() }),
  useSettings: () => useSyncExternalStore(settings.subscribe, settings.get),
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
  experimental_Icon: () => <span aria-hidden="true" />,
}));
vi.mock("./useSuperseded", () => ({ useSuperseded: () => false, useReplyIndex: () => null }));

let container: HTMLDivElement;
let root: Root;
const message = { id: "orbit:assistant:1", threadId: "orbit", turnId: "turn", projectId: "project" };
const html = '<button onclick="this.textContent=\'Started\'">Start Orbit</button>';
const original = () => <pre>{html}</pre>;

function render(language: "ui" | "app", status: ExperimentalCodeFenceRendererProps["status"], code: string, id = message.id): void {
  act(() => root.render(<SlotFence language={language} status={status} code={code} index={0} message={{ ...message, id }} Original={original} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ addEventListener() {}, removeEventListener() {} }));
  settings.set({ animations: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SlotFence completion", () => {
  it("runs the app only after its fence closes, without restarting it on a repeated closed update", () => {
    render("app", "streaming", html);
    // While it streams, only the preview frame, which never runs the model's scripts.
    expect(container.querySelector('iframe[title="App"]')).toBeNull();
    expect(container.querySelector('iframe[title="App preview"]')?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    render("app", "closed", html);
    const frame = container.querySelector("iframe");
    expect(frame?.title).toBe("App");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(container.querySelector('[role="status"]')).toBeNull();
    render("app", "closed", html);
    expect(container.querySelector("iframe")).toBe(frame);
  });

  it("shows source instead of executing an app when a streaming reply ends without its closing fence", () => {
    render("app", "streaming", html);
    render("app", "unclosed", html);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it.each(["closed", "unclosed"] as const)("finalizes invalid UI diagnostics when the fence is %s", (status) => {
    render("ui", "streaming", "$seats = (");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    render("ui", status, "$seats = (");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe("the Animations setting", () => {
  // jsdom has no Web Animations or ResizeObserver; an entrance that plays is recorded here.
  const animate = vi.fn(() => ({ cancel() {} }));
  beforeEach(() => {
    animate.mockClear();
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "animate");
  });

  // Each test is its own reply: a block mounted before in this page doesn't replay its entrance (LiveUi's MOUNTED).
  it("plays a block's entrance while it is on", () => {
    render("ui", "closed", 'Text("Hello")', "moving:assistant:1");
    expect(container.querySelector("[data-genui-motion]")).toBeNull();
    expect(animate).toHaveBeenCalled();
  });

  it("marks a block and its placeholder still, and plays no entrance, while it is off", () => {
    settings.set({ animations: false });
    render("ui", "streaming", "$seats = (", "still:assistant:1");
    expect(container.querySelector('[role="status"]')?.getAttribute("data-genui-motion")).toBe("off");
    render("ui", "closed", 'Text("Hello")', "still:assistant:1");
    expect(container.querySelector('[data-genui-motion="off"]')?.textContent).toContain("Hello");
    expect(animate).not.toHaveBeenCalled();
  });

  it("follows the setting while the block is on screen", () => {
    render("ui", "closed", 'Text("Hello")', "live:assistant:1");
    expect(container.querySelector("[data-genui-motion]")).toBeNull();
    act(() => settings.set({ animations: false }));
    expect(container.querySelector('[data-genui-motion="off"]')).not.toBeNull();
    act(() => settings.set({ animations: true }));
    expect(container.querySelector("[data-genui-motion]")).toBeNull();
  });
});
