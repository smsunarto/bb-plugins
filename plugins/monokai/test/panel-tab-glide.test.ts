import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
const { mountPanelTabGlide } = await import("../app/panel-tab-glide.ts");

const GLIDE = "[data-monokai-tab-glide]";
const TARGET = "data-monokai-tab-glide-target";
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

interface FakeAnimation {
  element: Element;
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
      element: this,
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
  expect(row.lastElementChild).toBe(ghost);
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
  expect(row.lastElementChild?.hasAttribute("data-monokai-tab-glide")).toBe(true);
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

/**
 * bb's phone pager: pinned circles, then a viewport sized to the visible chip
 * whose row bb steps with an inline translateX, hiding the chips outside it.
 */
function pager(count: number, active: number) {
  const root = document.createElement("div");
  root.setAttribute("data-testid", "mobile-panel-tab-pager");
  const pinned = document.createElement("div");
  const navigation = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.setAttribute("data-testid", "mobile-panel-tab-viewport");
  viewport.setAttribute("style", "width: 112px;");
  const row = document.createElement("div");
  row.setAttribute("style", "transform: translateX(0px);");
  viewport.append(row);
  navigation.append(viewport);
  root.append(pinned, navigation);
  const pill = (parent: Element, pressed: boolean) => {
    const element = document.createElement("div");
    element.setAttribute("data-tab-pill", "");
    const button = document.createElement("button");
    button.setAttribute("aria-pressed", String(pressed));
    element.append(button);
    parent.append(element);
    return button;
  };
  const pins = [pill(pinned, active === -1)];
  const chips = Array.from({ length: count }, (_, index) => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-panel-tab-measure", "true");
    if (index !== active) wrapper.style.visibility = "hidden";
    row.append(wrapper);
    return pill(wrapper, index === active);
  });
  document.body.append(root);
  return { root, viewport, row, pins, chips };
}

test("glides between a pinned circle and the pager's chip", async () => {
  const { root, pins, chips } = pager(2, 0);
  const { dispose } = mount();
  chips[0]!.setAttribute("aria-pressed", "false");
  pins[0]!.setAttribute("aria-pressed", "true");
  await frame();
  expect(root.lastElementChild?.hasAttribute("data-monokai-tab-glide")).toBe(true);
  expect(pins[0]!.parentElement!.hasAttribute(TARGET)).toBe(true);
  expect(animations).toHaveLength(1);
  dispose();
});

test("a swipe slides the pager's row under the fill", async () => {
  const { root, viewport, row, chips } = pager(3, 0);
  const { dispose } = mount();
  // bb's step: flip the chips, move the row, resize the viewport, hide the chip it left.
  chips[0]!.setAttribute("aria-pressed", "false");
  chips[1]!.setAttribute("aria-pressed", "true");
  row.setAttribute("style", "transform: translateX(-116px);");
  viewport.setAttribute("style", "width: 140px;");
  chips[0]!.parentElement!.parentElement!.style.visibility = "hidden";
  chips[1]!.parentElement!.parentElement!.style.visibility = "";
  await frame();
  expect(root.querySelector(GLIDE)).not.toBeNull();
  const of = (element: Element) => animations.find((animation) => animation.element === element);
  expect(of(row)?.keyframes.map((keyframe) => keyframe.transform)).toEqual([
    "translateX(0px)",
    "translateX(-116px)",
  ]);
  expect(of(viewport)?.keyframes.map((keyframe) => keyframe.width)).toEqual(["112px", "140px"]);
  expect(of(chips[0]!.parentElement!.parentElement!)?.keyframes[0]?.visibility).toBe("visible");

  animations[0]!.finish();
  await frame();
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(animations.every((animation) => animation.cancelled)).toBe(true);
  dispose();
});

test("a pager step a frame after the switch joins the flight", async () => {
  const { root, row, pins, chips } = pager(2, 0);
  const { dispose } = mount();
  chips[0]!.setAttribute("aria-pressed", "false");
  pins[0]!.setAttribute("aria-pressed", "true");
  await frame();
  row.setAttribute("style", "transform: translateX(40px);");
  await frame();
  expect(root.querySelectorAll(GLIDE)).toHaveLength(1);
  expect(animations[0]!.cancelled).toBe(true);
  expect(
    animations.find((animation) => animation.element === row)?.keyframes.map((k) => k.transform),
  ).toEqual(["translateX(0px)", "translateX(40px)"]);
  expect(pins[0]!.parentElement!.hasAttribute(TARGET)).toBe(true);
  dispose();
});

test("a pager step without a switch is forgotten by the next switch", async () => {
  const { row, pins, chips } = pager(2, 0);
  const { dispose } = mount();
  row.setAttribute("style", "transform: translateX(-50px);");
  await frame();
  await frame();
  chips[0]!.setAttribute("aria-pressed", "false");
  pins[0]!.setAttribute("aria-pressed", "true");
  await frame();
  expect(animations.some((animation) => animation.element === row)).toBe(false);
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
