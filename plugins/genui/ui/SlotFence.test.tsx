// @vitest-environment jsdom
import { act, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalCodeFenceRendererProps, PluginSettingsState } from "@get-bb/plugin-sdk/app";
import { takePullRequestReviews, type PullRequestReviewRequest } from "@bb-plugins/review-request";
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

/** Source Control's rows as `statusForThread` serves them to a keyed read, by thread id. */
const sourceControl = vi.hoisted(() => ({ rows: {} as Record<string, unknown> }));
const openUrl = vi.hoisted(() => vi.fn((_url: string) => true));

// Only BB's runtime is replaced; compilation, Fence, AppBlock and diagnostics are real.
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  useComposers: () => [],
  useSdk: () => ({}),
  useBbNavigate: () => ({ openUrl }),
  useRpc: () => ({ call: vi.fn() }),
  useSettings: () => useSyncExternalStore(settings.subscribe, settings.get),
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
  experimental_Icon: () => <span aria-hidden="true" />,
  UrlLink: ({ href, className, children }: { href: string; className?: string; children: ReactNode }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
  experimental_useRpcKeyedQuery: ({ keys, enabled }: { keys: readonly string[]; enabled?: boolean }) => ({
    data: enabled === false ? undefined : Object.fromEntries(keys.flatMap((key) => (key in sourceControl.rows ? [[key, sourceControl.rows[key]]] : []))),
  }),
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

/** A rendered block: no entrance to play, and jsdom's missing observers stubbed. */
function renderedBlocks() {
  beforeEach(() => {
    settings.set({ animations: false });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: () => ({ cancel() {}, finished: Promise.resolve() }) });
  });
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "animate");
  });
}

describe("a block that doesn't compile", () => {
  renderedBlocks();
  // A Decision option with too few scores; before the fix the compiling start of it rendered as a question.
  const DECISION = 'Decision("Which?", [{name: "A", scores: [4]}])';

  it("says so once its fence closes, instead of rendering the part that compiles", () => {
    render("ui", "closed", DECISION, "broken:assistant:1");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("This UI couldn't be rendered");
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("keeps the part that compiles when the reply ended before the fence closed", () => {
    render("ui", "unclosed", 'Card("Plan", [Text("Kept")])\nCard("x", [Choice(', "cut:assistant:1");
    expect(container.textContent).toContain("Kept");
  });
});

describe("an Input bound to a number", () => {
  renderedBlocks();
  it("keeps the state a number while its text reads as one, so the arithmetic on it keeps working", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      "ui",
      "closed",
      '$ee = 750\n$n = 2\nCard("Cost", [Input($ee, label: "Premium"), Metric("Total", "$" + fmt($ee * $n))])',
      "number:assistant:1",
    );
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => fireEvent.change(input, { target: { value: "1,250" } }));
    expect(input.value).toBe("1,250");
    expect(container.textContent).toContain("$2,500");
    expect(container.textContent).not.toContain("needs a number");
  });
});

describe("the retired PullRequest", () => {
  renderedBlocks();
  it("shows Source Control's state on the ref that is this thread's pull request, and the rest as links", () => {
    sourceControl.rows = {
      orbit: { state: "change", key: "gh:1", branch: "b", pullRequest: { number: 7, title: "Fix", url: "https://github.com/acme/client/pull/7", state: "open" }, line: "Checks failing", chips: [], tone: "error", sort: 0 },
    };
    render("ui", "closed", 'PullRequest(["acme/client#7", "acme/client#8"])', "pr:assistant:1");
    const items = [...container.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual(["acme/client#7Open · Checks failing", "acme/client#8"]);
    sourceControl.rows = {};
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

describe("a button opening a pull request", () => {
  const PR = "https://github.com/acme/api/pull/12";
  const code = `Button("Review it", OpenUrl("${PR}"))`;
  let asks: PullRequestReviewRequest[];
  let stop: AbortController;
  /** Source Control's content script, answering `taken` to every ask. */
  function sourceControl(taken: boolean) {
    stop = new AbortController();
    takePullRequestReviews((ask) => (asks.push(ask), taken), stop.signal);
  }
  beforeEach(() => {
    asks = [];
    openUrl.mockClear();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });
  afterEach(() => stop?.abort());
  const click = (init?: MouseEventInit) =>
    act(() => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    });

  it("asks Source Control for its Review beside the block's thread, and opens nothing when it takes it", async () => {
    sourceControl(true);
    render("ui", "closed", code, "pr-taken:assistant:1");
    click();
    await act(async () => undefined);
    expect(asks).toEqual([{ url: PR, threadId: "orbit", navigating: false }]);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens GitHub when Source Control doesn't take it", async () => {
    sourceControl(false);
    render("ui", "closed", code, "pr-declined:assistant:1");
    click();
    await act(async () => undefined);
    expect(asks).toHaveLength(1);
    expect(openUrl).toHaveBeenCalledWith(PR);
  });

  it("opens GitHub on a modified click without asking", async () => {
    sourceControl(true);
    render("ui", "closed", code, "pr-modified:assistant:1");
    click({ metaKey: true });
    await act(async () => undefined);
    expect(asks).toEqual([]);
    expect(openUrl).toHaveBeenCalledWith(PR);
  });
});
