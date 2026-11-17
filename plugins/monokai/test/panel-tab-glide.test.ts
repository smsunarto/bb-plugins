import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
const { mountPanelTabGlide } = await import("../app/panel-tab-glide.ts");

const GLIDE = "[data-monokai-tab-glide]";
const TARGET = "data-monokai-tab-glide-target";
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

interface FakeAnimation {
  keyframes: Keyframe[];
  cancelled: boolean;
  finish: () => void;
}
let animations: FakeAnimation[];
const realAnimate = HTMLElement.prototype.animate;

beforeEach(() => {
  animations = [];
  HTMLElement.prototype.animate = function (keyframes) {
    let resolve!: () => void;
    const finished = new Promise<void>((r) => (resolve = r));
    const record: FakeAnimation = {
      keyframes: keyframes as Keyframe[],
      cancelled: false,
      finish: () => resolve(),
    };
    animations.push(record);
    return {
      finished,
      cancel: () => {
        record.cancelled = true;
      },
    } as unknown as Animation;
  };
});

afterEach(() => {
  HTMLElement.prototype.animate = realAnimate;
  document.body.replaceChildren();
});

/**
 * bb's right panel toolbar: pinned view pills, then the tab strip
 * (strip > scroll region > viewport > content row > tab wrappers).
 */
function strip(count: number, active = 0, pinned = 0) {
  const group = document.createElement("div");
  group.setAttribute("data-sidebar-split-tab-group", "pane-primary");
  const root = document.createElement("div");
  root.setAttribute("data-testid", "secondary-panel-tab-strip");
  const region = document.createElement("div");
  region.setAttribute("data-secondary-panel-tab-scroll-region", "true");
  const row = document.createElement("div");
  row.setAttribute("data-secondary-panel-tab-content", "");
  region.append(row);
  root.append(region);
  const buttons = Array.from({ length: count }, (_, index) => {
    const wrapper = document.createElement("div");
    const pill = document.createElement("div");
    pill.setAttribute("data-tab-pill", "");
    const button = document.createElement("button");
    button.setAttribute("aria-pressed", String(index === active));
    pill.append(button);
    wrapper.append(pill);
    (index < pinned ? group : row).append(wrapper);
    return button;
  });
  group.append(root);
  document.body.append(group);
  return { row: group, buttons };
}

function select(buttons: HTMLButtonElement[], index: number) {
  for (const [i, button] of buttons.entries()) {
    button.setAttribute("aria-pressed", String(i === index));
  }
}

function mount(options: { pointer?: boolean; reduced?: boolean } = {}) {
  const controller = new AbortController();
  const dispose = mountPanelTabGlide({
    signal: controller.signal,
    isPointerSwitch: () => options.pointer ?? true,
    reducedMotion: () => options.reduced ?? false,
  });
  return { controller, dispose };
}

test("slides a highlight to a clicked tab and lands it", async () => {
  const { row, buttons } = strip(3);
  const { dispose } = mount();
  select(buttons, 2);
  await frame();
  const ghost = row.querySelector(GLIDE);
  expect(row.firstElementChild).toBe(ghost);
  expect(ghost?.getAttribute("aria-hidden")).toBe("true");
  expect(buttons[2]!.parentElement!.hasAttribute(TARGET)).toBe(true);
  expect(animations).toHaveLength(1);

  expect(row.hasAttribute("data-monokai-tab-glide-host")).toBe(true);
  animations[0]!.finish();
  await frame();
  expect(row.querySelector(GLIDE)).toBeNull();
  expect(row.hasAttribute("data-monokai-tab-glide-host")).toBe(false);
  expect(buttons[2]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  dispose();
});

test("a keyboard switch, reduced motion, or a closed tab stays instant", async () => {
  const keyboard = strip(2);
  const first = mount({ pointer: false });
  select(keyboard.buttons, 1);
  await frame();
  expect(keyboard.row.querySelector(GLIDE)).toBeNull();
  first.dispose();

  const reduced = strip(2);
  const second = mount({ reduced: true });
  select(reduced.buttons, 1);
  await frame();
  expect(reduced.row.querySelector(GLIDE)).toBeNull();
  second.dispose();

  const closed = strip(2);
  const third = mount();
  closed.buttons[0]!.closest("[data-tab-pill]")!.parentElement!.remove();
  closed.buttons[1]!.setAttribute("aria-pressed", "true");
  await frame();
  expect(closed.row.querySelector(GLIDE)).toBeNull();
  third.dispose();
  expect(animations).toHaveLength(0);
});

test("a switch mid-flight replaces the flight with one highlight", async () => {
  const { row, buttons } = strip(3);
  const { dispose } = mount();
  select(buttons, 1);
  await frame();
  select(buttons, 2);
  await frame();
  expect(row.querySelectorAll(GLIDE)).toHaveLength(1);
  expect(animations[0]!.cancelled).toBe(true);
  expect(buttons[1]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  expect(buttons[2]!.parentElement!.hasAttribute(TARGET)).toBe(true);
  dispose();
});

test("slides between a pinned view and a strip tab", async () => {
  const { row, buttons } = strip(3, 0, 2);
  const { dispose } = mount();
  select(buttons, 2);
  await frame();
  expect(row.firstElementChild?.hasAttribute("data-monokai-tab-glide")).toBe(true);
  expect(buttons[2]!.parentElement!.hasAttribute(TARGET)).toBe(true);
  dispose();
});

test("lands when bb replaces the target pill mid-flight", async () => {
  const { row, buttons } = strip(2);
  const { dispose } = mount();
  select(buttons, 1);
  await frame();
  const pill = buttons[1]!.parentElement!;
  const replacement = pill.cloneNode(true) as HTMLElement;
  replacement.removeAttribute(TARGET);
  pill.replaceWith(replacement);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(row.querySelector(GLIDE)).toBeNull();
  expect(row.hasAttribute("data-monokai-tab-glide-host")).toBe(false);
  expect(replacement.hasAttribute(TARGET)).toBe(false);
  dispose();
});

test("works on a strip mounted after the script", async () => {
  const { dispose } = mount();
  const { row, buttons } = strip(2);
  select(buttons, 1);
  await frame();
  expect(row.querySelector(GLIDE)).not.toBeNull();
  dispose();
});

test("ignores the phone pager", async () => {
  const { row, buttons } = strip(2);
  const pager = document.createElement("div");
  pager.setAttribute("data-testid", "mobile-panel-tab-pager");
  pager.append(...row.children);
  row.append(pager);
  const { dispose } = mount();
  select(buttons, 1);
  await frame();
  expect(document.querySelector(GLIDE)).toBeNull();
  dispose();
});

test("disposal removes the highlight, the mark, and the style", async () => {
  const { row, buttons } = strip(2);
  const { controller } = mount();
  expect(document.querySelector("[data-monokai-tab-glide-style]")).not.toBeNull();
  select(buttons, 1);
  await frame();
  controller.abort();
  expect(row.querySelector(GLIDE)).toBeNull();
  expect(buttons[1]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  expect(document.querySelector("[data-monokai-tab-glide-style]")).toBeNull();
  select(buttons, 0);
  await frame();
  expect(row.querySelector(GLIDE)).toBeNull();
});
