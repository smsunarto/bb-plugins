// @vitest-environment jsdom
import { JSDOM, type DOMWindow } from "jsdom";
import { describe, expect, test } from "vitest";

import {
  injectFragmentRuntime,
  isFragment,
  LUCIDE_URL,
  MAX_WIDGET_STATE_BYTES,
  parseFrameMessage,
  type HostTheme,
} from "./fragment-runtime.ts";

const TOKEN = "token-1";
const THEME: HostTheme = {
  scheme: "dark",
  tokens: { "--background": "#181818", "--foreground": "#e3e3dd" },
};

/** Serialize the runtime into a fragment and run it in a separate window, like the frame. */
function runFragment(html: string, state: string | null = null) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  injectFragmentRuntime(parsed, { token: TOKEN, theme: THEME, state });
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
  const fromParent = (data: Record<string, unknown>) =>
    window.dispatchEvent(
      new window.MessageEvent("message", { data, source: window as unknown as Window }),
    );
  return { window, document: window.document, sent, fromParent, geometry };
}

const frames = () => new Promise((resolve) => setTimeout(resolve, 40));

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
