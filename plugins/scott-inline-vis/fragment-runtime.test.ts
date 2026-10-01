// @vitest-environment jsdom
import { JSDOM, type DOMWindow } from "jsdom";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import {
  injectFragmentRuntime,
  isFragment,
  LUCIDE_URL,
  MAX_WIDGET_STATE_BYTES,
  parseFrameMessage,
  type TweakGroup,
  type HostTheme,
} from "./fragment-runtime.ts";

const TOKEN = "token-1";
const THEME: HostTheme = {
  scheme: "dark",
  tokens: { "--background": "#181818", "--foreground": "#e3e3dd" },
};

/** Serialize the runtime into a fragment and run it in a separate window, like the frame. */
function runFragment(
  html: string,
  state: string | null = null,
  tweaks: string | null = null,
  inject = injectFragmentRuntime,
) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  inject(parsed, { token: TOKEN, theme: THEME, state, tweaks });
  const posted: Record<string, unknown>[] = [];
  // jsdom has no layout. Tests set the body height and fire the observer.
  const geometry = { bodyHeight: 0, resize: () => {} };
  const dom = new JSDOM(`<!doctype html>${parsed.documentElement.outerHTML}`, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // The frame's parent is the app. A top-level test window is its own parent.
      window.postMessage = ((data: Record<string, unknown>) => posted.push(data)) as never;
      window.ResizeObserver = class {
        constructor(callback: () => void) {
          geometry.resize = callback;
        }
        observe() {}
        disconnect() {}
      } as never;
      const rect = window.HTMLElement.prototype.getBoundingClientRect;
      window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        if (this !== window.document.body) return rect.call(this);
        const height = geometry.bodyHeight;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          width: 0,
          right: 0,
          height,
          bottom: height,
        } as DOMRect;
      };
    },
  });
  const { window } = dom;
  const sent = (type: string) => posted.filter((message) => message.type === type);
  const fromParent = (
    data: Record<string, unknown>,
    source: Window = window as unknown as Window,
  ) => window.dispatchEvent(new window.MessageEvent("message", { data, source }));
  return { window, document: window.document, sent, fromParent, geometry };
}

const frames = () => new Promise((resolve) => setTimeout(resolve, 40));

const tweakFragment = `
  <div id="card" aria-label="Card settings"><output></output></div>
  <script>
    window.values = {radius: 18, color: "#aabbcc", shadow: true, layout: "compact"};
    function render() {
      document.querySelector("output").textContent = JSON.stringify(values);
      document.getElementById("card").style.borderRadius = values.radius + "px";
    }
    window.tweak = new Tweak({container: document.getElementById("card"), onChange: render});
    tweak.addSlider(values, "radius", {label: "Corner radius", min: 0, max: 32, step: 2, unit: "px", reference: "--radius"});
    tweak.addColorPicker(values, "color", {label: "Accent"});
    tweak.addToggle(values, "shadow", {label: "Shadow"});
    tweak.addSelect(values, "layout", {label: "Layout", options: ["compact", {label: "Roomy", value: "roomy"}]});
    render();
  </script>`;

/** jsdom has no PointerEvent. The runtime reads only `pointerType`. */
function pointer(window: DOMWindow, type: string, pointerType: string) {
  const event = new window.MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

describe("isFragment", () => {
  test("treats markup without document tags as a fragment", () => {
    expect(isFragment('<div id="viz"></div><script>draw()</script>')).toBe(true);
    expect(isFragment("<!doctype html><p>x</p>")).toBe(false);
    expect(isFragment("<HTML lang=en><p>x</p></HTML>")).toBe(false);
    expect(isFragment("<body>\n<p>x</p>")).toBe(false);
    expect(isFragment("<header>Title</header>")).toBe(true);
    expect(isFragment('<div></div><script>el.innerHTML = "<body>"</script>')).toBe(true);
    expect(isFragment("<!-- <html> --><div></div><style>/* <head> */</style>")).toBe(true);
  });
});

describe("parseFrameMessage", () => {
  test("accepts only known messages carrying the frame token", () => {
    expect(
      parseFrameMessage({ type: "bb:inline-vis:resize", token: TOKEN, height: 10.2 }, TOKEN),
    ).toEqual({
      type: "resize",
      height: 11,
    });
    expect(
      parseFrameMessage({ type: "bb:inline-vis:resize", token: "x", height: 10 }, TOKEN),
    ).toBeNull();
    expect(
      parseFrameMessage({ type: "bb:inline-vis:resize", token: TOKEN, height: "10" }, TOKEN),
    ).toBeNull();
    expect(
      parseFrameMessage({ type: "bb:inline-vis:follow-up", token: TOKEN, prompt: "  " }, TOKEN),
    ).toBeNull();
    expect(
      parseFrameMessage(
        {
          type: "bb:inline-vis:state",
          token: TOKEN,
          state: "x".repeat(MAX_WIDGET_STATE_BYTES + 1),
        },
        TOKEN,
      ),
    ).toBeNull();
    expect(parseFrameMessage("bb:inline-vis:resize", TOKEN)).toBeNull();
    expect(
      parseFrameMessage({ type: "bb:inline-vis:state", token: TOKEN, state: "undefined" }, TOKEN),
    ).toBeNull();
    expect(
      parseFrameMessage({ type: "bb:inline-vis:state", token: TOKEN, state: '{"a":1}' }, TOKEN),
    ).toEqual({ type: "state", state: '{"a":1}' });
  });

  test("validates optional model content independently from saved widget state", () => {
    const message = { type: "bb:inline-vis:state", token: TOKEN, state: '{"view":"a"}' };
    expect(parseFrameMessage({ ...message, modelContent: '{"selected":"Card A"}' }, TOKEN)).toEqual(
      { type: "state", state: '{"view":"a"}', modelContent: '{"selected":"Card A"}' },
    );
    expect(parseFrameMessage({ ...message, modelContent: null }, TOKEN)).toEqual({
      type: "state",
      state: '{"view":"a"}',
      modelContent: null,
    });
    for (const modelContent of [
      42,
      "invalid",
      JSON.stringify("x".repeat(16_384)),
      JSON.stringify("💡".repeat(4_097)),
    ]) {
      expect(parseFrameMessage({ ...message, modelContent }, TOKEN)).toBeNull();
    }
  });

  test("only accepts bounded typed Tweak descriptions and strips unrelated data", () => {
    const group: TweakGroup = {
      id: "tweak-card",
      title: "Card",
      variant: null,
      visible: true,
      controls: [
        {
          id: "slider:radius",
          label: "Radius",
          type: "slider",
          min: 0,
          max: 32,
          step: 1,
          value: 18,
          initialValue: 12,
          reference: "--radius",
        },
      ],
    };
    const message = {
      type: "bb:inline-vis:tweak",
      token: TOKEN,
      groups: [{ ...group, callback: "never trusted" }],
      original: false,
      changed: false,
    };
    expect(parseFrameMessage(message, TOKEN)).toEqual({
      type: "tweak",
      groups: [group],
      original: false,
      changed: false,
    });
    const slider = group.controls[0]!;
    for (const controls of [
      [{ ...slider, value: 40 }],
      [{ ...slider, initialValue: "12" }],
      [{ ...slider, min: 40 }],
      [{ ...slider, step: 0 }],
      [{ ...slider, type: "unknown" }],
      [{ ...slider, reference: 1 }],
      [{ ...slider, type: "color", value: "red", initialValue: "#ffffff" }],
      [{ ...slider, type: "toggle", value: "true", initialValue: false }],
      [
        {
          ...slider,
          type: "select",
          value: "b",
          initialValue: "a",
          options: [{ label: "A", value: "a" }],
        },
      ],
      [
        {
          ...slider,
          type: "select",
          value: "a",
          initialValue: "a",
          options: Array.from({ length: 13 }, (_, index) => ({
            label: String(index),
            value: String(index),
          })),
        },
      ],
      [slider, slider],
      Array.from({ length: 13 }, (_, index) => ({ ...slider, id: String(index) })),
    ])
      expect(parseFrameMessage({ ...message, groups: [{ ...group, controls }] }, TOKEN)).toBeNull();
    expect(parseFrameMessage({ ...message, groups: [group, group] }, TOKEN)).toBeNull();
    expect(parseFrameMessage({ ...message, changed: "true" }, TOKEN)).toBeNull();
    expect(parseFrameMessage({ ...message, changed: true, reset: null }, TOKEN)).toEqual({
      type: "tweak",
      groups: [group],
      original: false,
      changed: true,
      reset: null,
    });
    expect(parseFrameMessage({ ...message, changed: true, reset: "tweak-card" }, TOKEN)).toEqual({
      type: "tweak",
      groups: [group],
      original: false,
      changed: true,
      reset: "tweak-card",
    });
    for (const reset of [false, 1, "", "x".repeat(161)])
      expect(parseFrameMessage({ ...message, changed: true, reset }, TOKEN)).toBeNull();
    expect(parseFrameMessage({ ...message, reset: null }, TOKEN)).toBeNull();
    expect(
      parseFrameMessage(
        {
          ...message,
          groups: Array.from({ length: 25 }, (_, index) => ({ ...group, id: String(index) })),
        },
        TOKEN,
      ),
    ).toBeNull();
  });
});

describe("fragment runtime", () => {
  test("defines window.bb before fragment scripts run and applies the host theme", () => {
    const { window, document } = runFragment(
      "<p>x</p><script>window.seen = typeof bb.setWidgetState</script>",
      '{"tab":"b"}',
    );
    expect((window as unknown as { seen: string }).seen).toBe("function");
    expect((window as unknown as { bb: { widgetState: unknown } }).bb.widgetState).toEqual({
      tab: "b",
    });
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#181818");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  test("updates the theme from a parent message with the frame token", () => {
    const { document, fromParent } = runFragment("<p>x</p>");
    const theme = { scheme: "light", tokens: { "--background": "#ffffff" } };
    fromParent({ type: "bb:inline-vis:theme", token: "other", theme });
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#181818");
    fromParent({ type: "bb:inline-vis:theme", token: TOKEN, theme });
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#ffffff");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  test("saves widget state and sends follow-up prompts to the parent", async () => {
    const { window, sent } = runFragment("<p>x</p>");
    const bb = (
      window as unknown as {
        bb: {
          widgetState: unknown;
          setWidgetState(state: unknown): Promise<void>;
          sendFollowUp(prompt: string): Promise<void>;
        };
      }
    ).bb;
    await bb.setWidgetState({ selected: [1, 2] });
    expect(bb.widgetState).toEqual({ selected: [1, 2] });
    expect(sent("bb:inline-vis:state")).toEqual([
      { type: "bb:inline-vis:state", token: TOKEN, state: '{"selected":[1,2]}' },
    ]);
    await expect(bb.setWidgetState("x".repeat(MAX_WIDGET_STATE_BYTES))).rejects.toThrow(/exceeds/u);

    await bb.sendFollowUp("Explain region 3");
    expect(sent("bb:inline-vis:follow-up")).toEqual([
      { type: "bb:inline-vis:follow-up", token: TOKEN, prompt: "Explain region 3" },
    ]);
    await expect(bb.sendFollowUp(" ")).rejects.toThrow(/non-empty/u);
  });

  test("publishes model content only when requested and keeps rejected updates atomic", async () => {
    const { window, sent } = runFragment("<p>x</p>");
    const bb = (
      window as unknown as {
        bb: {
          widgetState: unknown;
          setWidgetState(next: unknown, options?: { modelContent?: unknown }): Promise<void>;
        };
      }
    ).bb;
    await bb.setWidgetState({ radius: 8 }, { modelContent: { summary: "Radius set to 8px" } });
    expect(sent("bb:inline-vis:state").at(-1)).toEqual({
      type: "bb:inline-vis:state",
      token: TOKEN,
      state: '{"radius":8}',
      modelContent: '{"summary":"Radius set to 8px"}',
    });
    await expect(
      bb.setWidgetState({ radius: 99 }, { modelContent: "x".repeat(16_384) }),
    ).rejects.toThrow(/exceeds/u);
    await expect(bb.setWidgetState({ radius: 99 }, { modelContent: () => {} })).rejects.toThrow(
      /serializable/u,
    );
    expect(bb.widgetState).toEqual({ radius: 8 });
    await bb.setWidgetState({ radius: 12 }, { modelContent: null });
    expect(sent("bb:inline-vis:state").at(-1)).toEqual({
      type: "bb:inline-vis:state",
      token: TOKEN,
      state: '{"radius":12}',
      modelContent: null,
    });
  });

  test("reports the body height after load and on resize", async () => {
    const { sent, geometry } = runFragment("<p>x</p>");
    geometry.bodyHeight = 180;
    await frames();
    expect(sent("bb:inline-vis:resize").at(-1)).toEqual({
      type: "bb:inline-vis:resize",
      token: TOKEN,
      height: 180,
    });

    geometry.bodyHeight = 260;
    geometry.resize();
    await frames();
    expect(sent("bb:inline-vis:resize").at(-1)?.height).toBe(260);
  });

  test("starts with null state when the saved snapshot is malformed", () => {
    const { window } = runFragment(
      "<p>x</p><script>window.ok = bb.widgetState</script>",
      "undefined",
    );
    expect((window as unknown as { ok: unknown }).ok).toBeNull();
  });

  test("enhances a carousel only after a mid-fragment script finishes parsing", async () => {
    const { document } = runFragment(`
      <div class="viz-carousel" aria-label="Designs">
        <section data-variant="A"><script>void 0</script></section>
        <section data-variant="B" hidden></section>
      </div>`);
    await frames();
    expect(document.querySelectorAll(".viz-carousel-nav")).toHaveLength(1);
    expect(document.querySelector(".viz-carousel-nav output")!.textContent).toBe("1 / 2");
  });

  test("wires tabs with click and arrow keys", async () => {
    const { window, document } = runFragment(`
      <div class="nav nav-pills" role="tablist" aria-label="Platform">
        <button class="nav-link active" id="a" role="tab" aria-controls="a-panel" aria-selected="true" type="button">A</button>
        <button class="nav-link" id="b" role="tab" aria-controls="b-panel" aria-selected="false" type="button">B</button>
      </div>
      <div id="a-panel" role="tabpanel" aria-labelledby="a">A content</div>
      <div id="b-panel" role="tabpanel" aria-labelledby="b">B content</div>`);
    await frames();
    const panel = (id: string) => document.getElementById(id)!;
    expect(panel("b-panel").hidden).toBe(true);

    document.getElementById("b")!.click();
    expect(document.getElementById("b")!.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("a")!.classList.contains("active")).toBe(false);
    expect([panel("a-panel").hidden, panel("b-panel").hidden]).toEqual([true, false]);

    document
      .getElementById("b")!
      .dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.getElementById("a")!.getAttribute("aria-selected")).toBe("true");
    expect(panel("a-panel").hidden).toBe(false);
  });

  test("adds navigation to a variant carousel and keeps each design's DOM", async () => {
    const { document } = runFragment(`
      <div class="viz-carousel" aria-label="Player designs">
        <section data-variant="Minimal"><input id="kept"></section>
        <section data-variant="Editorial" hidden></section>
        <section data-variant="Studio" hidden></section>
      </div>`);
    await frames();
    const nav = document.querySelector(".viz-carousel-nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Player designs navigation");
    expect(nav.querySelector("output")!.textContent).toBe("1 / 3");
    (document.getElementById("kept") as HTMLInputElement).value = "typed";

    nav.querySelector<HTMLButtonElement>('[aria-label="Next design"]')!.click();
    const sections = [...document.querySelectorAll("section")];
    expect(sections.map((section) => section.hidden)).toEqual([true, false, true]);
    expect(nav.querySelector("output")!.textContent).toBe("2 / 3");
    expect(nav.querySelector("select")!.value).toBe("1");

    nav.querySelector<HTMLButtonElement>('[aria-label="Previous design"]')!.click();
    nav.querySelector<HTMLButtonElement>('[aria-label="Previous design"]')!.click();
    expect(sections.map((section) => section.hidden)).toEqual([true, true, false]);
    expect((document.getElementById("kept") as HTMLInputElement).value).toBe("typed");
  });

  test("opens a touch tooltip on the first tap", () => {
    const { window, document } = runFragment(
      '<button type="button" data-tooltip="Reset view">Reset</button>',
    );
    const button = document.querySelector("button")!;
    button.dispatchEvent(pointer(window, "pointerover", "touch"));
    button.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Reset view");
  });

  test("forwards unhandled Escape with its frame token after author handlers finish", async () => {
    const { window, document, sent } = runFragment('<button id="focus">Focus</button>');
    const button = document.getElementById("focus")!;
    button.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await frames();
    expect(sent("bb:inline-vis:escape")).toEqual([{ type: "bb:inline-vis:escape", token: TOKEN }]);
    expect(parseFrameMessage(sent("bb:inline-vis:escape")[0], TOKEN)).toEqual({ type: "escape" });
    expect(parseFrameMessage(sent("bb:inline-vis:escape")[0], "other")).toBeNull();
    // A window listener registered by the author runs after the bridge's listener.
    window.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    button.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    button.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await frames();
    expect(sent("bb:inline-vis:escape")).toEqual([{ type: "bb:inline-vis:escape", token: TOKEN }]);
  });

  test("Escape dismisses an open tooltip before it forwards a subsequent Escape", async () => {
    const { window, document, sent } = runFragment('<button data-tooltip="Details">Focus</button>');
    const button = document.querySelector("button")!;
    button.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')!.textContent).toBe("Details");
    button.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await frames();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(sent("bb:inline-vis:escape")).toEqual([]);
    button.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await frames();
    expect(sent("bb:inline-vis:escape")).toEqual([{ type: "bb:inline-vis:escape", token: TOKEN }]);
  });

  test.each([
    "dialog:modal",
    'dialog[open][closedby="closerequest" i]',
    'dialog[open][closedby="any" i]',
    ":popover-open",
  ])("Escape lets native %s close before forwarding another Escape", async (selector) => {
    const { window, document, sent } = runFragment(
      '<button>Focus</button><dialog id="dialog"></dialog><div id="popover" popover></div>',
    );
    const originalQuery = document.querySelector.bind(document);
    const originalQueryAll = document.querySelectorAll.bind(document);
    const overlay = document.getElementById(selector.startsWith("dialog") ? "dialog" : "popover")!;
    let nativeOpen = true;
    vi.spyOn(document, "querySelector").mockImplementation((query) =>
      query === selector && nativeOpen
        ? overlay
        : originalQuery(query === "dialog:modal" ? "#absent" : query),
    );
    vi.spyOn(document, "querySelectorAll").mockImplementation((query) =>
      originalQueryAll(
        query === ":popover-open"
          ? selector === query && nativeOpen
            ? "#popover"
            : "#absent"
          : query,
      ),
    );
    const button = document.querySelector("button")!;
    button.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    // Native dismissal occurs after keydown, before the bridge's next task.
    nativeOpen = false;
    await frames();
    expect(sent("bb:inline-vis:escape")).toEqual([]);
    button.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await frames();
    expect(sent("bb:inline-vis:escape")).toEqual([{ type: "bb:inline-vis:escape", token: TOKEN }]);
  });

  test("Escape forwards with a persistent manual popover or ordinary non-modal dialog", async () => {
    const { window, document, sent } = runFragment(
      '<button>Focus</button><dialog open>Panel</dialog><div id="hud" popover="MANUAL">Legend</div>',
    );
    const queryAll = document.querySelectorAll.bind(document);
    const overlay = document.getElementById("hud")!;
    // jsdom does not implement native popover state or its reflected property.
    Object.defineProperty(overlay, "popover", { value: "manual" });
    vi.spyOn(document, "querySelectorAll").mockImplementation((query) =>
      queryAll(query === ":popover-open" ? "#hud" : query),
    );
    document
      .querySelector("button")!
      .dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    await frames();
    expect(sent("bb:inline-vis:escape")).toEqual([{ type: "bb:inline-vis:escape", token: TOKEN }]);
    expect(document.querySelector("dialog")!.open).toBe(true);
  });

  test("does not show a pending tooltip after its trigger is removed", async () => {
    const { window, document } = runFragment(
      '<button type="button" data-tooltip="Gone">Gone</button>',
    );
    const button = document.querySelector("button")!;
    button.dispatchEvent(pointer(window, "pointerover", "mouse"));
    button.remove();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  test("shows a data-tooltip on focus and links it for screen readers", () => {
    const { window, document } = runFragment(
      '<button type="button" data-tooltip="Reset view">Reset</button>',
    );
    const button = document.querySelector("button")!;
    button.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
    const tooltip = document.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toBe("Reset view");
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);

    button.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  test("loads Lucide only when the fragment uses an icon", async () => {
    const plain = runFragment("<p>x</p>");
    await frames();
    expect(plain.document.querySelector(`script[src="${LUCIDE_URL}"]`)).toBeNull();

    const icons = runFragment('<i data-lucide="search"></i>');
    await frames();
    expect(icons.document.querySelector(`script[src="${LUCIDE_URL}"]`)).not.toBeNull();
  });
});

describe("Tweak runtime", () => {
  test("distinguishes user edits from registration, Original, and disposal publications", async () => {
    const { window, sent, fromParent } = runFragment(tweakFragment);
    await frames();
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 8,
    });
    await frames();
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: true });
    await frames();
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: false });
    await frames();
    fromParent({ type: "bb:inline-vis:tweak-reset", token: TOKEN, groupId: "tweak-card" });
    await frames();
    (window as unknown as { tweak: { dispose(): void } }).tweak.dispose();
    await frames();
    expect(sent("bb:inline-vis:tweak").map((message) => message.changed)).toEqual([
      false,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(sent("bb:inline-vis:tweak").at(-1)!.groups).toEqual([]);
  });

  test("preserves an edit's cause when a passive publication batches with it", async () => {
    const { sent, fromParent } = runFragment(tweakFragment);
    await frames();
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 8,
    });
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: true });
    await frames();
    const message = sent("bb:inline-vis:tweak").at(-1)!;
    expect(message.changed).toBe(true);
    expect(message.original).toBe(true);
    expect((message.groups as TweakGroup[])[0]!.controls[0]!.value).toBe(8);
  });
  test("authors can alias the provided globals with top-level lexical bindings", async () => {
    const { document, sent, fromParent } = runFragment(`
      <div id="card"><output></output></div>
      <script>
        const Tweak = window.Tweak;
        const bb = window.bb;
        const values = {radius: 18};
        const panel = new Tweak({container: document.getElementById("card"), onChange: () => {
          document.querySelector("output").textContent = String(values.radius);
          bb.setWidgetState({...values});
        }});
        panel.addSlider(values, "radius", {min: 0, max: 32});
      </script>`);
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 8,
    });
    await frames();
    expect(document.querySelector("output")!.textContent).toBe("8");
    expect(sent("bb:inline-vis:state").at(-1)!.state).toBe('{"radius":8}');
  });

  test.each(["class Tweak { }", "function Tweak() { }"])(
    "authors can define their own helper: %s",
    async (helper) => {
      const { document } = runFragment(
        `<p id="result"></p><script>${helper}; document.getElementById("result").textContent = "Author script ran";</script>`,
      );
      await frames();
      expect(document.getElementById("result")!.textContent).toBe("Author script ran");
    },
  );

  test("registers typed controls and applies host changes to the bound model and rendering", async () => {
    const { document, sent, fromParent } = runFragment(tweakFragment);
    await frames();
    const initial = sent("bb:inline-vis:tweak").at(-1)!;
    expect(parseFrameMessage(initial, TOKEN)).toEqual({
      type: "tweak",
      original: false,
      changed: false,
      groups: [
        {
          id: "tweak-card",
          title: "Card settings",
          variant: null,
          visible: true,
          controls: [
            {
              type: "slider",
              id: "slider:radius",
              label: "Corner radius",
              min: 0,
              max: 32,
              step: 2,
              unit: "px",
              reference: "--radius",
              value: 18,
              initialValue: 18,
            },
            {
              type: "color",
              id: "color:color",
              label: "Accent",
              value: "#aabbcc",
              initialValue: "#aabbcc",
            },
            {
              type: "toggle",
              id: "toggle:shadow",
              label: "Shadow",
              value: true,
              initialValue: true,
            },
            {
              type: "select",
              id: "select:layout",
              label: "Layout",
              value: "compact",
              initialValue: "compact",
              options: [
                { label: "compact", value: "compact" },
                { label: "Roomy", value: "roomy" },
              ],
            },
          ],
        },
      ],
    });
    for (const [controlId, value] of [
      ["slider:radius", 8],
      ["color:color", "#123456"],
      ["toggle:shadow", false],
      ["select:layout", "roomy"],
    ]) {
      fromParent({
        type: "bb:inline-vis:tweak-change",
        token: TOKEN,
        groupId: "tweak-card",
        controlId,
        value,
      });
    }
    expect(document.querySelector("output")!.textContent).toBe(
      '{"radius":8,"color":"#123456","shadow":false,"layout":"roomy"}',
    );
    expect(document.getElementById("card")!.style.borderRadius).toBe("8px");
    await frames();
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.controls.map(
        (control) => control.value,
      ),
    ).toEqual([8, "#123456", false, "roomy"]);
  });

  test("rejects forged sources, stale tokens, and malformed control values", async () => {
    const { document, fromParent } = runFragment(tweakFragment);
    const change = {
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 8,
    };
    fromParent(change, {} as Window);
    fromParent({ ...change, token: "other" });
    for (const value of ["8", null, Infinity, -1, 40]) fromParent({ ...change, value });
    fromParent({ ...change, controlId: "color:color", value: "red" });
    fromParent({ ...change, controlId: "toggle:shadow", value: 1 });
    fromParent({ ...change, controlId: "select:layout", value: "unknown" });
    expect(document.getElementById("card")!.style.borderRadius).toBe("18px");
    fromParent(change);
    expect(document.getElementById("card")!.style.borderRadius).toBe("8px");
    await frames();
  });

  test("Original previews page defaults without replacing edits and Reset discards edits", async () => {
    const { document, sent, fromParent } = runFragment(tweakFragment);
    const change = {
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 8,
    };
    fromParent(change);
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: true });
    expect(document.getElementById("card")!.style.borderRadius).toBe("18px");
    await frames();
    const original = sent("bb:inline-vis:tweak").at(-1)!;
    expect(original.original).toBe(true);
    expect((original.groups as TweakGroup[])[0]!.controls[0]!.value).toBe(8);
    fromParent({ ...change, value: 12 });
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: false });
    expect(document.getElementById("card")!.style.borderRadius).toBe("8px");
    fromParent({ type: "bb:inline-vis:tweak-reset", token: TOKEN, groupId: "tweak-card" });
    expect(document.getElementById("card")!.style.borderRadius).toBe("18px");
    await frames();
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.controls[0]!.value,
    ).toBe(18);
  });

  test("Original rendering callbacks cannot overwrite widget state or model content", async () => {
    const savesWhileRendering = tweakFragment.replace(
      "function render() {",
      "function render() { window.renderSave = bb.setWidgetState({...values}, {modelContent: {radius: values.radius}});",
    );
    const { window, document, sent, fromParent } = runFragment(savesWhileRendering);
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 8,
    });
    expect(sent("bb:inline-vis:state").at(-1)!.modelContent).toBe('{"radius":8}');
    const saveCount = sent("bb:inline-vis:state").length;
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: true });
    await expect(
      (window as unknown as { renderSave: Promise<void> }).renderSave,
    ).resolves.toBeUndefined();
    expect(document.getElementById("card")!.style.borderRadius).toBe("18px");
    expect((window as unknown as { bb: { widgetState: unknown } }).bb.widgetState).toEqual({
      radius: 8,
      color: "#aabbcc",
      shadow: true,
      layout: "compact",
    });
    expect(sent("bb:inline-vis:state")).toHaveLength(saveCount);
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: false });
    expect(document.getElementById("card")!.style.borderRadius).toBe("8px");
    expect(sent("bb:inline-vis:state").at(-1)!.modelContent).toBe('{"radius":8}');
    await frames();
  });

  test("unrelated widget interactions still save while Original is displayed", async () => {
    const { window, sent, fromParent } = runFragment(tweakFragment, '{"selectedTab":"a"}');
    const bb = (
      window as unknown as {
        bb: { widgetState: unknown; setWidgetState(next: unknown): Promise<void> };
      }
    ).bb;
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: true });
    await expect(bb.setWidgetState({ selectedTab: "b" })).resolves.toBeUndefined();
    expect(bb.widgetState).toEqual({ selectedTab: "b" });
    expect(sent("bb:inline-vis:state").at(-1)).toEqual({
      type: "bb:inline-vis:state",
      token: TOKEN,
      state: '{"selectedTab":"b"}',
    });
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: false });
    expect(bb.widgetState).toEqual({ selectedTab: "b" });
    await frames();
  });
});

describe("Tweak restoration", () => {
  test("two groups sharing one render restore coherently without cycling, including a late saved group", async () => {
    const { window, document, sent, fromParent } = runFragment(
      `
      <div id="root"></div><script>
        window.renders=0; window.includeLate=false;
        window.render=()=>{
          if(++renders>50)return;
          const root=document.getElementById("root");
          root.innerHTML='<div id="card"><output></output></div><div id="chart"><output></output></div>'+(includeLate?'<div id="late"><output></output></div>':'');
          for(const [id,property,initial] of [["card","radius",18],["chart","bars",6],...(includeLate?[["late","bars",6]]:[])]){
            const values={[property]:initial};
            const container=document.getElementById(id);
            new Tweak({container,onChange:render}).addSlider(values,property,{min:0,max:32});
            container.querySelector("output").textContent=String(values[property]);
          }
        }; render();
      </script>`,
      null,
      JSON.stringify([
        { groupId: "tweak-card", controlId: "slider:radius", value: 7 },
        { groupId: "tweak-chart", controlId: "slider:bars", value: 9 },
        { groupId: "tweak-late", controlId: "slider:bars", value: 10 },
      ]),
    );
    await frames();
    expect((window as unknown as { renders: number }).renders).toBe(2);
    expect([...document.querySelectorAll("output")].map((node) => node.textContent)).toEqual([
      "7",
      "9",
    ]);
    window.eval("includeLate=true;render();");
    await frames();
    expect((window as unknown as { renders: number }).renders).toBe(4);
    expect([...document.querySelectorAll("output")].map((node) => node.textContent)).toEqual([
      "7",
      "9",
      "10",
    ]);
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 12,
    });
    await frames();
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-chart",
      controlId: "slider:bars",
      value: 11,
    });
    await frames();
    expect((window as unknown as { renders: number }).renders).toBe(6);
    expect([...document.querySelectorAll("output")].map((node) => node.textContent)).toEqual([
      "12",
      "11",
      "10",
    ]);
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[]).map(
        (group) => group.controls[0]!.initialValue,
      ),
    ).toEqual([18, 6, 6]);
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: true });
    expect([...document.querySelectorAll("output")].map((node) => node.textContent)).toEqual([
      "18",
      "6",
      "6",
    ]);
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: false });
    expect([...document.querySelectorAll("output")].map((node) => node.textContent)).toEqual([
      "12",
      "11",
      "10",
    ]);
    fromParent({ type: "bb:inline-vis:tweak-reset", token: TOKEN, groupId: "tweak-chart" });
    expect([...document.querySelectorAll("output")].map((node) => node.textContent)).toEqual([
      "12",
      "6",
      "10",
    ]);
    fromParent({ type: "bb:inline-vis:tweak-reset", token: TOKEN });
    expect([...document.querySelectorAll("output")].map((node) => node.textContent)).toEqual([
      "18",
      "6",
      "6",
    ]);
    await frames();
    expect((window as unknown as { renders: number }).renders).toBe(10);
  });

  test("deferred onChange rerenders restore an already-notified value without scheduling another callback", async () => {
    const { window, document, fromParent } = runFragment(`
      <div id="root"></div><script>
        window.renders=0;
        function render(){
          if(++renders>50)return;
          document.getElementById("root").innerHTML='<div id="card"><output></output></div>';
          const values={radius:18};
          new Tweak({container:document.getElementById("card"),onChange:()=>setTimeout(render,0)}).addSlider(values,"radius",{min:0,max:32});
          document.querySelector("output").textContent=String(values.radius);
        };render();
      </script>`);
    await frames();
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 7,
    });
    await frames();
    expect(document.querySelector("output")!.textContent).toBe("7");
    expect((window as unknown as { renders: number }).renders).toBe(2);
  });

  test("author mutations of a reused bound object survive re-registration and update the saved control", async () => {
    const { window, document, sent, fromParent } = runFragment(`
      <div id="root"></div><script>
        window.values={radius:18};
        window.render=()=>{
          document.getElementById("root").innerHTML='<div id="card"><output></output></div>';
          new Tweak({container:document.getElementById("card"),onChange:render}).addSlider(values,"radius",{min:0,max:32});
          document.querySelector("output").textContent=String(values.radius);
        };render();
      </script>`);
    await frames();
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 7,
    });
    await frames();
    window.eval("values.radius=30;render();");
    await frames();
    expect(document.querySelector("output")!.textContent).toBe("30");
    const message = sent("bb:inline-vis:tweak").at(-1)!;
    expect(message.changed).toBe(true);
    expect((message.groups as TweakGroup[])[0]!.controls[0]!.value).toBe(30);
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: true });
    expect(document.querySelector("output")!.textContent).toBe("18");
    fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: false });
    expect(document.querySelector("output")!.textContent).toBe("30");
    await frames();
    const restored = runFragment(
      tweakFragment,
      null,
      JSON.stringify([{ groupId: "tweak-card", controlId: "slider:radius", value: 30 }]),
    );
    await frames();
    expect(restored.document.getElementById("card")!.style.borderRadius).toBe("30px");
  });

  test("a preset can update another group's authored default while repeated fresh defaults retain edits", async () => {
    const { document, sent, fromParent } = runFragment(`
      <div id="root"></div><script>
        const state={preset:"light"};
        const presets={light:"#ffffff",dark:"#111111"};
        function render(){
          document.getElementById("root").innerHTML='<div id="theme"></div><div id="colors"><output></output></div>';
          new Tweak({container:document.getElementById("theme"),onChange:render}).addSelect(state,"preset",{options:["light","dark"]});
          const colors={background:presets[state.preset]};
          new Tweak({container:document.getElementById("colors"),onChange:render}).addColorPicker(colors,"background");
          document.querySelector("output").textContent=colors.background;
        };render();
      </script>`);
    await frames();
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-theme",
      controlId: "select:preset",
      value: "dark",
    });
    await frames();
    expect(document.querySelector("output")!.textContent).toBe("#111111");
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[1]!.controls[0]!.value,
    ).toBe("#111111");
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-colors",
      controlId: "color:background",
      value: "#123456",
    });
    await frames();
    expect(document.querySelector("output")!.textContent).toBe("#123456");
  });

  test("dependent control schemas use a valid current default and recover the first default when allowed again", async () => {
    const { document, sent, fromParent } = runFragment(`
      <div id="root"></div><script>
        const state={family:"Inter"};
        const weights={Inter:["400","700"],Mono:["300","400"]};
        function render(){
          document.getElementById("root").innerHTML='<div id="type"><output></output></div>';
          const values={weight:state.family==="Inter"?"700":"400"};
          new Tweak({container:document.getElementById("type"),onChange:render})
            .addSelect(state,"family",{options:["Inter","Mono"]})
            .addSelect(values,"weight",{options:weights[state.family]});
          document.querySelector("output").textContent=state.family+"/"+values.weight;
        };render();
      </script>`);
    await frames();
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-type",
      controlId: "select:family",
      value: "Mono",
    });
    await frames();
    expect(document.querySelector("output")!.textContent).toBe("Mono/400");
    const dynamic = sent("bb:inline-vis:tweak").at(-1)!;
    expect(parseFrameMessage(dynamic, TOKEN)?.type).toBe("tweak");
    expect(
      (dynamic.groups as TweakGroup[])[0]!.controls.map((control) => [
        control.value,
        control.initialValue,
      ]),
    ).toEqual([
      ["Mono", "Inter"],
      ["400", "400"],
    ]);
    fromParent({ type: "bb:inline-vis:tweak-reset", token: TOKEN });
    await frames();
    expect(document.querySelector("output")!.textContent).toBe("Inter/700");
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.controls.map(
        (control) => control.initialValue,
      ),
    ).toEqual(["Inter", "700"]);
  });
});

describe("Tweak registration lifecycle", () => {
  test.each(["fresh", "shared"])(
    "%s values keep the first defaults and rerender once per notification",
    async (allocation) => {
      const { window, document, sent, fromParent } = runFragment(
        `
      <div id="root"></div><script>
        const root = document.getElementById("root");
        const shared = {radius: 18};
        window.renders = 0;
        let tweak;
        function render() {
          if (++renders > 50) return;
          root.innerHTML = '<div id="card"><output></output></div>';
          tweak?.dispose();
          const values = ${allocation === "fresh" ? "{radius: 18}" : "shared"};
          const container = document.getElementById("card");
          tweak = new Tweak({container, onChange: render});
          tweak.addSlider(values, "radius", {min: 0, max: 32});
          container.querySelector("output").textContent = String(values.radius);
        }
        render();
      </script>`,
        null,
        '[{"groupId":"tweak-card","controlId":"slider:radius","value":7}]',
      );
      await frames();
      expect((window as unknown as { renders: number }).renders).toBe(2);
      expect(document.querySelector("output")!.textContent).toBe("7");
      fromParent({
        type: "bb:inline-vis:tweak-change",
        token: TOKEN,
        groupId: "tweak-card",
        controlId: "slider:radius",
        value: 12,
      });
      await frames();
      expect((window as unknown as { renders: number }).renders).toBe(3);
      const current = (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.controls[0]!;
      expect([current.value, current.initialValue]).toEqual([12, 18]);
      fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: true });
      expect(document.querySelector("output")!.textContent).toBe("18");
      fromParent({ type: "bb:inline-vis:tweak-original", token: TOKEN, active: false });
      expect(document.querySelector("output")!.textContent).toBe("12");
      fromParent({ type: "bb:inline-vis:tweak-reset", token: TOKEN, groupId: "tweak-card" });
      await frames();
      expect(document.querySelector("output")!.textContent).toBe("18");
      expect((window as unknown as { renders: number }).renders).toBe(6);
    },
  );

  test("re-registering the same connected container replaces its group without reaching the group limit", async () => {
    const { window, document, sent, fromParent } = runFragment(`
      <div id="root"></div><script>
        const root = document.getElementById("root");
        const values = {radius: 18};
        window.renders = 0;
        function render() {
          if (++renders > 50) return;
          root.innerHTML = '<output></output>';
          new Tweak({container:root,onChange:render}).addSlider(values,"radius",{min:0,max:32});
          root.querySelector("output").textContent = String(values.radius);
        }
        render();
      </script>`);
    await frames();
    for (let value = 1; value <= 25; value++)
      fromParent({
        type: "bb:inline-vis:tweak-change",
        token: TOKEN,
        groupId: "tweak-root",
        controlId: "slider:radius",
        value,
      });
    await frames();
    expect(document.querySelector("output")!.textContent).toBe("25");
    expect((window as unknown as { renders: number }).renders).toBe(26);
    const groups = sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[];
    expect(
      groups.map((group) => [group.id, group.controls[0]!.value, group.controls[0]!.initialValue]),
    ).toEqual([["tweak-root", 25, 18]]);
  });

  test("a replaced instance explains the one-group-per-container contract and cannot retire its replacement", async () => {
    const { window, sent } = runFragment(`
      <div id="root"></div><script>
        const container=document.getElementById("root");
        const colors=new Tweak({container,onChange(){}});
        const spacing=new Tweak({container,onChange(){}});
        try { colors.addColorPicker({accent:"#ff0000"},"accent"); }
        catch(error) { window.registrationError=error.message; }
        spacing.addSlider({gap:8},"gap",{min:0,max:32});
        colors.dispose();
      </script>`);
    await frames();
    expect((window as unknown as { registrationError: string }).registrationError).toBe(
      "This Tweak group was disposed or replaced. Register one Tweak group per container.",
    );
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[]).map((group) => [
        group.id,
        group.controls.map((control) => [control.id, control.value]),
      ]),
    ).toEqual([["tweak-root", [["slider:gap", 8]]]]);
  });

  test("detached registration requires an explicit identity while attached no-id groups remain supported", async () => {
    const { window, sent } = runFragment(`
      <div class="viz-carousel"><section data-variant="Compact"><div aria-label="Card"></div></section></div>
      <script>
        new Tweak({container:document.querySelector('[aria-label="Card"]'),onChange(){}}).addSlider({radius:18},"radius",{min:0,max:32});
        const replacement=document.createElement("div");
        replacement.setAttribute("aria-label","Card");
        try { new Tweak({container:replacement,onChange(){}}); } catch(error) { window.registrationError=error.message; }
      </script>`);
    await frames();
    expect((window as unknown as { registrationError: string }).registrationError).toBe(
      "A detached Tweak container needs a stable id before registration.",
    );
    const groups = sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[];
    expect(groups.map((group) => [group.id, group.variant, group.controls[0]!.value])).toEqual([
      ["tweak-Compact:Card", "Compact", 18],
    ]);
  });

  test("restores saved values by container and property identity despite registration order changes", async () => {
    const reordered = tweakFragment.replace(
      '    tweak.addColorPicker(values, "color", {label: "Accent"});',
      "",
    );
    const { document, sent } = runFragment(
      reordered,
      null,
      JSON.stringify([
        { groupId: "tweak-card", controlId: "slider:radius", value: 8 },
        { groupId: "tweak-card", controlId: "toggle:shadow", value: false },
        { groupId: "tweak-card", controlId: "select:layout", value: "unknown" },
      ]),
    );
    expect(document.querySelector("output")!.textContent).toBe(
      '{"radius":8,"color":"#aabbcc","shadow":false,"layout":"compact"}',
    );
    await frames();
    const groups = sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[];
    expect(
      groups[0]!.controls.map((control) => [control.id, control.value, control.initialValue]),
    ).toEqual([
      ["slider:radius", 8, 18],
      ["toggle:shadow", false, true],
      ["select:layout", "compact", "compact"],
    ]);
  });

  test("restored registration notifies once per group after all controls have restored", async () => {
    const { window, sent } = runFragment(
      `
      <div id="card"></div><div id="layout"></div>
      <script>
        window.restored = [];
        const values = {radius: 18, color: "#aabbcc", shadow: true};
        const card = new Tweak({container: document.getElementById("card"), onChange: () => {
          restored.push({group: "card", ...values});
          bb.setWidgetState({...values});
        }});
        card.addSlider(values, "radius", {min: 0, max: 32});
        card.addColorPicker(values, "color");
        const layout = new Tweak({container: document.getElementById("layout"), onChange: () => restored.push({group: "layout", ...values})});
        layout.addToggle(values, "shadow");
      </script>`,
      null,
      JSON.stringify([
        { groupId: "tweak-card", controlId: "slider:radius", value: 8 },
        { groupId: "tweak-card", controlId: "color:color", value: "#123456" },
        { groupId: "tweak-layout", controlId: "toggle:shadow", value: false },
      ]),
    );
    await frames();
    expect((window as unknown as { restored: unknown }).restored).toEqual([
      { group: "card", radius: 8, color: "#123456", shadow: false },
      { group: "layout", radius: 8, color: "#123456", shadow: false },
    ]);
    expect(sent("bb:inline-vis:state")).toEqual([
      {
        type: "bb:inline-vis:state",
        token: TOKEN,
        state: '{"radius":8,"color":"#123456","shadow":false}',
      },
    ]);
  });

  test.each(["disposed", "replaced"])(
    "a callback %s by another restoration callback never receives a stale notification",
    async (action) => {
      const { window } = runFragment(
        `
        <div id="card"></div><div id="chart"></div><script>
          window.notifications=[];
          let chart;
          new Tweak({container:document.getElementById("card"),onChange:()=>{
            notifications.push("card");
            chart.dispose();
            ${action === "replaced" ? `const values={bars:6};chart=new Tweak({container:document.getElementById("chart"),onChange:()=>notifications.push("new:"+values.bars)});chart.addSlider(values,"bars",{min:0,max:12});` : ""}
          }}).addSlider({radius:18},"radius",{min:0,max:32});
          chart=new Tweak({container:document.getElementById("chart"),onChange:()=>notifications.push("stale")});
          chart.addSlider({bars:6},"bars",{min:0,max:12});
        </script>`,
        null,
        JSON.stringify([
          { groupId: "tweak-card", controlId: "slider:radius", value: 7 },
          { groupId: "tweak-chart", controlId: "slider:bars", value: 9 },
        ]),
      );
      await frames();
      expect((window as unknown as { notifications: string[] }).notifications).toEqual(
        action === "replaced" ? ["card", "new:9"] : ["card"],
      );
    },
  );

  test("disposal cancels a pending restored notification", async () => {
    const { window, sent } = runFragment(
      `
      <div id="card"></div><div id="kept"></div>
      <script>
        window.restored = [];
        const values = {radius: 18};
        const card = new Tweak({container: document.getElementById("card"), onChange: () => restored.push("disposed")});
        card.addSlider(values, "radius", {min: 0, max: 32});
        card.dispose();
        const kept = new Tweak({container: document.getElementById("kept"), onChange: () => restored.push("kept")});
        kept.addSlider(values, "radius", {min: 0, max: 32});
      </script>`,
      null,
      JSON.stringify([
        { groupId: "tweak-card", controlId: "slider:radius", value: 8 },
        { groupId: "tweak-kept", controlId: "slider:radius", value: 12 },
      ]),
    );
    await frames();
    expect((window as unknown as { restored: unknown }).restored).toEqual(["kept"]);
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.controls[0]!.value,
    ).toBe(12);
  });

  test.each(["documentDOMContentLoaded", "windowDOMContentLoaded", "windowLoad"])(
    "initial publication waits for %s registration and contains all restored groups",
    async (trigger) => {
      const registration =
        trigger === "windowLoad"
          ? 'window.addEventListener("load", register);'
          : `${trigger === "documentDOMContentLoaded" ? "document" : "window"}.addEventListener("DOMContentLoaded", register);`;
      const { window, sent } = runFragment(
        `
        <div id="card"></div><div id="layout"></div>
        <script>
          window.restored = [];
          const values = {radius: 18, shadow: true};
          const card = new Tweak({container: document.getElementById("card"), onChange: () => restored.push({...values})});
          card.addSlider(values, "radius", {min: 0, max: 32});
          function register() {
            const layout = new Tweak({container: document.getElementById("layout"), onChange: () => restored.push({...values})});
            layout.addToggle(values, "shadow");
          }
          ${registration}
        </script>`,
        null,
        JSON.stringify([
          { groupId: "tweak-card", controlId: "slider:radius", value: 8 },
          { groupId: "tweak-layout", controlId: "toggle:shadow", value: false },
        ]),
      );
      await frames();
      expect((window as unknown as { restored: unknown }).restored).toEqual([
        { radius: 8, shadow: false },
        { radius: 8, shadow: false },
      ]);
      expect(
        sent("bb:inline-vis:tweak").map((message) =>
          (message.groups as TweakGroup[]).map((group) => [group.id, group.controls[0]!.value]),
        ),
      ).toEqual([
        [
          ["tweak-card", 8],
          ["tweak-layout", false],
        ],
      ]);
    },
  );

  test.each(["dispose", "replace container"])(
    "%s and re-register retains identity so later edits restore on reload",
    async (replace) => {
      const html = `
      <div id="card"><output></output></div>
      <script>
        window.values = {radius: 18};
        window.make = () => {
          window.tweak = new Tweak({container: document.getElementById("card"), onChange: () => document.querySelector("output").textContent = String(values.radius)});
          tweak.addSlider(values, "radius", {min: 0, max: 32});
        };
        make();
      </script>`;
      const first = runFragment(html);
      await frames();
      expect((first.sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.id).toBe(
        "tweak-card",
      );
      first.window.eval(
        replace === "dispose"
          ? "const old = tweak; old.dispose(); make(); old.dispose();"
          : 'const old = tweak; const replacement = document.createElement("div"); replacement.id = "card"; replacement.innerHTML = "<output></output>"; document.getElementById("card").replaceWith(replacement); make(); old.dispose();',
      );
      first.fromParent({
        type: "bb:inline-vis:tweak-change",
        token: TOKEN,
        groupId: "tweak-card",
        controlId: "slider:radius",
        value: 8,
      });
      await frames();
      const groups = first.sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[];
      expect(groups.map((group) => [group.id, group.controls[0]!.value])).toEqual([
        ["tweak-card", 8],
      ]);
      expect(first.document.querySelector("output")!.textContent).toBe("8");
      const saved = JSON.stringify(
        groups.flatMap((group) =>
          group.controls.map((control) => ({
            groupId: group.id,
            controlId: control.id,
            value: control.value,
          })),
        ),
      );
      const reloaded = runFragment(html, null, saved);
      await frames();
      expect(reloaded.document.querySelector("output")!.textContent).toBe("8");
      expect(
        (reloaded.sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.controls[0]!
          .value,
      ).toBe(8);
    },
  );

  test.each(["dispose", "replace container", "register detached replacement"])(
    "%s registration restores current edits instead of load-time values",
    async (replacement) => {
      const html = `
      <div id="card"><output></output></div>
      <script>
        window.make = () => {
          const values = {radius: 18};
          const render = () => document.querySelector("output").textContent = String(values.radius);
          window.tweak = new Tweak({container: document.getElementById("card"), onChange: render});
          tweak.addSlider(values, "radius", {min: 0, max: 32});
          render();
        };
        window.replace = () => {
          const replacement = document.createElement("div");
          replacement.id = "card";
          replacement.innerHTML = "<output></output>";
          document.getElementById("card").replaceWith(replacement);
          make();
        };
        window.prepareReplacement = () => {
          const replacement = document.createElement("div");
          replacement.id = "card";
          replacement.innerHTML = "<output></output>";
          const values = {radius: 18};
          const render = () => replacement.querySelector("output").textContent = String(values.radius);
          window.tweak = new Tweak({container: replacement, onChange: render});
          tweak.addSlider(values, "radius", {min: 0, max: 32});
          document.getElementById("card").replaceWith(replacement);
          render();
        };
        make();
      </script>`;
      const first = runFragment(
        html,
        null,
        '[{"groupId":"tweak-card","controlId":"slider:radius","value":7}]',
      );
      await frames();
      expect(first.document.querySelector("output")!.textContent).toBe("7");
      first.fromParent({
        type: "bb:inline-vis:tweak-change",
        token: TOKEN,
        groupId: "tweak-card",
        controlId: "slider:radius",
        value: 12,
      });
      const recreate =
        replacement === "dispose"
          ? "tweak.dispose(); make();"
          : replacement === "register detached replacement"
            ? "prepareReplacement();"
            : "replace();";
      first.window.eval(recreate);
      await frames();
      expect(first.document.querySelector("output")!.textContent).toBe("12");
      const groups = first.sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[];
      const saved = JSON.stringify(
        groups.flatMap((group) =>
          group.controls.map((control) => ({
            groupId: group.id,
            controlId: control.id,
            value: control.value,
          })),
        ),
      );
      const reloaded = runFragment(html, null, saved);
      await frames();
      expect(reloaded.document.querySelector("output")!.textContent).toBe("12");
      first.fromParent({ type: "bb:inline-vis:tweak-reset", token: TOKEN, groupId: "tweak-card" });
      first.window.eval(recreate);
      await frames();
      expect(first.document.querySelector("output")!.textContent).toBe("18");
    },
  );

  test("Reset all clears saved controls that register later and publishes explicit reset intent", async () => {
    const { window, document, sent, fromParent } = runFragment(
      `
      <div id="card"><output></output></div><div id="late"><output></output></div>
      <script>
        const cardValues = {radius: 18};
        new Tweak({container: document.getElementById("card"), onChange() {}}).addSlider(cardValues, "radius", {min: 0, max: 32});
        window.registerLate = () => {
          const values = {radius: 24};
          const render = () => document.querySelector("#late output").textContent = String(values.radius);
          new Tweak({container: document.getElementById("late"), onChange: render}).addSlider(values, "radius", {min: 0, max: 32});
          render();
        };
      </script>`,
      null,
      '[{"groupId":"tweak-late","controlId":"slider:radius","value":7}]',
    );
    await frames();
    fromParent({ type: "bb:inline-vis:tweak-reset", token: TOKEN });
    window.eval("registerLate();");
    await frames();
    expect(document.querySelector("#late output")!.textContent).toBe("24");
    expect(sent("bb:inline-vis:tweak").find((message) => message.reset === null)?.changed).toBe(
      true,
    );
  });

  test("two connected containers with the same ID retain separate groups", async () => {
    const { sent } = runFragment(`
      <div id="card"></div><div id="card"></div>
      <script>
        for (const [index, container] of [...document.querySelectorAll("#card")].entries()) {
          new Tweak({container, onChange() {}}).addSlider({radius: index === 0 ? 18 : 24}, "radius", {min: 0, max: 32});
        }
      </script>`);
    await frames();
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[]).map((group) => [
        group.id,
        group.controls[0]!.value,
      ]),
    ).toEqual([
      ["tweak-card", 18],
      ["tweak-card:2", 24],
    ]);
  });

  test("separate scoped resets retain their exact intent and preserve other late saved controls", async () => {
    const { window, document, sent, fromParent } = runFragment(
      `
      <div id="a"></div><div id="b"></div><div id="late"><output></output></div>
      <script>
        new Tweak({container: document.getElementById("a"), onChange() {}}).addSlider({radius: 18}, "radius", {min: 0, max: 32});
        new Tweak({container: document.getElementById("b"), onChange() {}}).addSlider({radius: 24}, "radius", {min: 0, max: 32});
        window.registerLate = () => {
          const values = {radius: 26};
          const render = () => document.querySelector("#late output").textContent = String(values.radius);
          new Tweak({container: document.getElementById("late"), onChange: render}).addSlider(values, "radius", {min: 0, max: 32});
          render();
        };
      </script>`,
      null,
      '[{"groupId":"tweak-late","controlId":"slider:radius","value":9}]',
    );
    await frames();
    fromParent({ type: "bb:inline-vis:tweak-reset", token: TOKEN, groupId: "tweak-a" });
    fromParent({ type: "bb:inline-vis:tweak-reset", token: TOKEN, groupId: "tweak-b" });
    window.eval("registerLate();");
    await frames();
    expect(document.querySelector("#late output")!.textContent).toBe("9");
    expect(
      sent("bb:inline-vis:tweak")
        .filter((message) => message.reset !== undefined)
        .map((message) => [message.reset, message.changed]),
    ).toEqual([
      ["tweak-a", true],
      ["tweak-b", true],
    ]);
    expect(sent("bb:inline-vis:tweak").at(-1)!.changed).toBe(false);
  });

  test("tracks carousel visibility while preserving each variant's independent changes", async () => {
    const { document, sent, fromParent } = runFragment(`
      <div class="viz-carousel">
        <section data-variant="A"><div id="a" aria-label="A settings"><output></output></div></section>
        <section data-variant="B" hidden><div id="b" aria-label="B settings"><output></output></div></section>
      </div>
      <script>
        for (const id of ["a", "b"]) {
          const values = {radius: id === "a" ? 18 : 24};
          const container = document.getElementById(id);
          const tweak = new Tweak({container, onChange: () => container.querySelector("output").textContent = String(values.radius)});
          tweak.addSlider(values, "radius", {min: 0, max: 32});
        }
      </script>`);
    await frames();
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[]).map((group) => [
        group.variant,
        group.visible,
      ]),
    ).toEqual([
      ["A", true],
      ["B", false],
    ]);
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-a",
      controlId: "slider:radius",
      value: 8,
    });
    document.querySelector<HTMLButtonElement>('[aria-label="Next design"]')!.click();
    await frames();
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[]).map((group) => [
        group.variant,
        group.visible,
        group.controls[0]!.value,
      ]),
    ).toEqual([
      ["A", false, 8],
      ["B", true, 24],
    ]);
    document.querySelector<HTMLButtonElement>('[aria-label="Previous design"]')!.click();
    await frames();
    expect(document.querySelector("#a output")!.textContent).toBe("8");
    expect((sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.visible).toBe(true);
  });

  test("removes disconnected or disposed groups from the host and rejects edits after disposal", async () => {
    const { window, document, sent, fromParent } = runFragment(tweakFragment);
    await frames();
    expect((sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.id).toBe("tweak-card");
    const container = document.getElementById("card")!;
    container.remove();
    await frames();
    expect(sent("bb:inline-vis:tweak").at(-1)!.groups).toEqual([]);
    document.body.append(container);
    await frames();
    expect((sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.id).toBe("tweak-card");
    (window as unknown as { tweak: { dispose(): void } }).tweak.dispose();
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 8,
    });
    await frames();
    expect(sent("bb:inline-vis:tweak").at(-1)!.groups).toEqual([]);
    expect(container.style.borderRadius).toBe("18px");
  });

  test("the runtime remains self-contained after production-style bundling", async () => {
    const source = execFileSync(
      "bun",
      [
        "build",
        resolve(dirname(fileURLToPath(import.meta.url)), "fragment-runtime.ts"),
        "--target=browser",
        "--format=esm",
        "--minify-whitespace",
      ],
      { encoding: "utf8" },
    );
    const bundled = (await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    )) as { injectFragmentRuntime: typeof injectFragmentRuntime };
    const { document, sent, fromParent } = runFragment(
      tweakFragment,
      null,
      null,
      bundled.injectFragmentRuntime,
    );
    fromParent({
      type: "bb:inline-vis:tweak-change",
      token: TOKEN,
      groupId: "tweak-card",
      controlId: "slider:radius",
      value: 8,
    });
    await frames();
    expect(document.getElementById("card")!.style.borderRadius).toBe("8px");
    expect(
      (sent("bb:inline-vis:tweak").at(-1)!.groups as TweakGroup[])[0]!.controls[0]!.value,
    ).toBe(8);
  });
});
