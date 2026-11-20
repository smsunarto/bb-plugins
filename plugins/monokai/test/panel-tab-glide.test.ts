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

/** Every mount, so a failing test cannot leave its observer running into the next. */
const mounted: AbortController[] = [];

afterEach(() => {
  for (const controller of mounted.splice(0)) controller.abort();
  HTMLElement.prototype.animate = realAnimate;
  document.body.replaceChildren();
});

/** Gives an element a fixed layout box; the test DOM lays nothing out. */
function place(element: Element, left: number, top: number, width: number, height: number) {
  const box = {
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
  };
  element.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
}

/** The width a highlight keyframe's `inset(top right bottom left …)` leaves visible. */
function insetWidth(keyframe: Keyframe | undefined, hostWidth: number) {
  const [, right = 0, , left = 0] = /inset\(([^)]*?)\s+round/
    .exec(String(keyframe?.clipPath))![1]!
    .split(/\s+/)
    .map(Number.parseFloat);
  return hostWidth - right - left;
}

function pill(parent: Element, pressed: boolean) {
  const element = document.createElement("div");
  element.setAttribute("data-tab-pill", "");
  const button = document.createElement("button");
  button.setAttribute("aria-pressed", String(pressed));
  element.append(button);
  parent.append(element);
  return button;
}

/** Moves the selection the way bb does: both buttons flip in one commit. */
function select(from: HTMLButtonElement, to: HTMLButtonElement) {
  from.setAttribute("aria-pressed", "false");
  to.setAttribute("aria-pressed", "true");
}

function mount(options: { pointer?: boolean; reduced?: boolean } = {}) {
  const controller = new AbortController();
  mounted.push(controller);
  const dispose = mountPanelTabGlide({
    signal: controller.signal,
    isPointerSwitch: () => options.pointer ?? true,
    reducedMotion: () => options.reduced ?? false,
  });
  return { controller, dispose };
}

/**
 * bb's desktop right panel toolbar, as bb 0.50.1 renders it above 767px: pinned
 * view pills, then the tab strip (strip > scroll region > content row > tab
 * wrappers). Every pill is 28px square, so only the toolbar itself keeps a
 * switch from gliding.
 */
function strip(count: number, active: number, pinned: number) {
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
    const button = pill(wrapper, index === active);
    place(button.parentElement!, index * 32, 0, 28, 28);
    (index < pinned ? group : row).append(wrapper);
    return button;
  });
  group.append(root);
  document.body.append(group);
  return { group, buttons };
}

const PAGER_WIDTH = 400;

/**
 * bb's tab pager, shown at 767px and narrower: 44px pinned circles, then a
 * viewport sized to the visible chip, whose row bb steps with an inline
 * translateX, hiding the chips outside it. `active` indexes the chips; -1 is
 * the first pin.
 */
function pager(chipWidths: number[], active: number, pinCount = 2) {
  const root = document.createElement("div");
  root.setAttribute("data-testid", "mobile-panel-tab-pager");
  place(root, 0, 0, PAGER_WIDTH, 52);
  const pinned = document.createElement("div");
  const navigation = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.setAttribute("data-testid", "mobile-panel-tab-viewport");
  const shown = chipWidths[Math.max(active, 0)] ?? 0;
  viewport.setAttribute("style", `width: ${shown}px;`);
  place(viewport, 120, 0, shown, 52);
  const row = document.createElement("div");
  row.setAttribute("style", "transform: translateX(0px);");
  viewport.append(row);
  navigation.append(viewport);
  root.append(pinned, navigation);
  const pins = Array.from({ length: pinCount }, (_, index) => {
    const button = pill(pinned, active === -1 - index);
    place(button.parentElement!, 4 + index * 48, 4, 44, 44);
    return button;
  });
  let left = 120;
  const chips = chipWidths.map((width, index) => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-panel-tab-measure", "true");
    if (index !== active) wrapper.style.visibility = "hidden";
    row.append(wrapper);
    const button = pill(wrapper, index === active);
    place(button.parentElement!, left, 12, width, 28);
    left += width + 4;
    return button;
  });
  document.body.append(root);
  return { root, viewport, row, pins, chips };
}

test("the desktop toolbar switches instantly, even between same-size tabs", async () => {
  const { group, buttons } = strip(3, 0, 2);
  const { dispose } = mount();
  select(buttons[0]!, buttons[1]!);
  await frame();
  select(buttons[1]!, buttons[2]!);
  await frame();
  expect(group.querySelector(GLIDE)).toBeNull();
  expect(group.hasAttribute("data-monokai-tab-glide-host")).toBe(false);
  expect(buttons[2]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  expect(animations).toHaveLength(0);
  dispose();
});

test("slides the highlight between same-size circles without resizing it, and lands it", async () => {
  const { root, pins } = pager([112], -1);
  const { dispose } = mount();
  select(pins[0]!, pins[1]!);
  await frame();
  const ghost = root.querySelector(GLIDE);
  expect(root.lastElementChild).toBe(ghost);
  expect(ghost?.getAttribute("aria-hidden")).toBe("true");
  expect(pins[1]!.parentElement!.hasAttribute(TARGET)).toBe(true);
  expect(root.hasAttribute("data-monokai-tab-glide-host")).toBe(true);
  expect(animations).toHaveLength(1);
  const [from, to] = animations[0]!.keyframes;
  expect(from?.clipPath).not.toBe(to?.clipPath);
  expect(insetWidth(from, PAGER_WIDTH)).toBe(44);
  expect(insetWidth(to, PAGER_WIDTH)).toBe(44);

  animations[0]!.finish();
  await frame();
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(root.hasAttribute("data-monokai-tab-glide-host")).toBe(false);
  expect(pins[1]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  dispose();
});

test("a circle and a chip of another size switch instantly, both ways", async () => {
  const { root, pins, chips } = pager([112], 0);
  const { dispose } = mount();
  select(chips[0]!, pins[0]!);
  await frame();
  expect(root.querySelector(GLIDE)).toBeNull();
  select(pins[0]!, chips[0]!);
  await frame();
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(root.hasAttribute("data-monokai-tab-glide-host")).toBe(false);
  expect(animations).toHaveLength(0);
  dispose();
});

test("a keyboard switch, reduced motion, or a closed tab stays instant", async () => {
  const keyboard = pager([112], -1);
  const first = mount({ pointer: false });
  select(keyboard.pins[0]!, keyboard.pins[1]!);
  await frame();
  expect(keyboard.root.querySelector(GLIDE)).toBeNull();
  first.dispose();

  const reduced = pager([112], -1);
  const second = mount({ reduced: true });
  select(reduced.pins[0]!, reduced.pins[1]!);
  await frame();
  expect(reduced.root.querySelector(GLIDE)).toBeNull();
  second.dispose();

  const closed = pager([112], -1);
  const third = mount();
  closed.pins[0]!.parentElement!.remove();
  closed.pins[1]!.setAttribute("aria-pressed", "true");
  await frame();
  expect(closed.root.querySelector(GLIDE)).toBeNull();
  third.dispose();
  expect(animations).toHaveLength(0);
});

test("a switch mid-flight replaces the flight with one highlight", async () => {
  const { root, pins } = pager([112], -1);
  const { dispose } = mount();
  select(pins[0]!, pins[1]!);
  await frame();
  select(pins[1]!, pins[0]!);
  await frame();
  expect(root.querySelectorAll(GLIDE)).toHaveLength(1);
  expect(animations).toHaveLength(2);
  expect(animations[0]!.cancelled).toBe(true);
  expect(pins[1]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  expect(pins[0]!.parentElement!.hasAttribute(TARGET)).toBe(true);
  dispose();
});

test("a switch mid-flight to a tab of another size lands at once", async () => {
  const { root, pins, chips } = pager([112], -1);
  const { dispose } = mount();
  select(pins[0]!, pins[1]!);
  await frame();
  select(pins[1]!, chips[0]!);
  await frame();
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(animations).toHaveLength(1);
  expect(animations[0]!.cancelled).toBe(true);
  expect(pins[1]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  expect(chips[0]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  dispose();
});

test("lands when bb replaces the target pill mid-flight", async () => {
  const { root, pins } = pager([112], -1);
  const { dispose } = mount();
  select(pins[0]!, pins[1]!);
  await frame();
  const target = pins[1]!.parentElement!;
  const replacement = target.cloneNode(true) as HTMLElement;
  replacement.removeAttribute(TARGET);
  target.replaceWith(replacement);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(root.hasAttribute("data-monokai-tab-glide-host")).toBe(false);
  expect(replacement.hasAttribute(TARGET)).toBe(false);
  dispose();
});

test("works on a pager mounted after the script", async () => {
  const { dispose } = mount();
  const { root, pins } = pager([112], -1);
  select(pins[0]!, pins[1]!);
  await frame();
  expect(root.querySelector(GLIDE)).not.toBeNull();
  dispose();
});

test("a swipe between chips of one width slides the row under the fill", async () => {
  const { root, viewport, row, chips } = pager([112, 112, 112], 0);
  const { dispose } = mount();
  // bb's step: flip the chips, move the row, hide the chip it left.
  select(chips[0]!, chips[1]!);
  row.setAttribute("style", "transform: translateX(-116px);");
  chips[0]!.parentElement!.parentElement!.style.visibility = "hidden";
  chips[1]!.parentElement!.parentElement!.style.visibility = "";
  await frame();
  expect(root.querySelector(GLIDE)).not.toBeNull();
  const of = (element: Element) => animations.find((animation) => animation.element === element);
  expect(of(row)?.keyframes.map((keyframe) => keyframe.transform)).toEqual([
    "translateX(0px)",
    "translateX(-116px)",
  ]);
  expect(of(chips[0]!.parentElement!.parentElement!)?.keyframes[0]?.visibility).toBe("visible");
  expect(of(viewport)).toBeUndefined();
  expect(animations).toHaveLength(3);

  animations[0]!.finish();
  await frame();
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(animations.every((animation) => animation.cancelled)).toBe(true);
  dispose();
});

test("a swipe between chips of different widths is instant", async () => {
  const { root, viewport, row, chips } = pager([112, 140], 0);
  const { dispose } = mount();
  select(chips[0]!, chips[1]!);
  row.setAttribute("style", "transform: translateX(-116px);");
  viewport.setAttribute("style", "width: 140px;");
  await frame();
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(animations).toHaveLength(0);
  dispose();
});

test("a pager step a frame after the switch joins the flight", async () => {
  const { root, row, chips } = pager([112, 112], 0);
  const { dispose } = mount();
  select(chips[0]!, chips[1]!);
  await frame();
  row.setAttribute("style", "transform: translateX(-116px);");
  await frame();
  expect(root.querySelectorAll(GLIDE)).toHaveLength(1);
  expect(animations[0]!.cancelled).toBe(true);
  expect(
    animations.find((animation) => animation.element === row)?.keyframes.map((k) => k.transform),
  ).toEqual(["translateX(0px)", "translateX(-116px)"]);
  expect(chips[1]!.parentElement!.hasAttribute(TARGET)).toBe(true);
  dispose();
});

test("a pager step without a switch is forgotten by the next switch", async () => {
  const { row, pins } = pager([112], -1);
  const { dispose } = mount();
  row.setAttribute("style", "transform: translateX(-50px);");
  await frame();
  await frame();
  select(pins[0]!, pins[1]!);
  await frame();
  expect(animations.some((animation) => animation.element === row)).toBe(false);
  dispose();
});

test("disposal removes the highlight, the mark, and the style", async () => {
  const { root, pins } = pager([112], -1);
  const { controller } = mount();
  expect(document.querySelector("[data-monokai-tab-glide-style]")).not.toBeNull();
  select(pins[0]!, pins[1]!);
  await frame();
  controller.abort();
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(pins[1]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  expect(document.querySelector("[data-monokai-tab-glide-style]")).toBeNull();
  select(pins[1]!, pins[0]!);
  await frame();
  expect(root.querySelector(GLIDE)).toBeNull();
});
