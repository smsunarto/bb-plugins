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
 * bb's desktop right panel toolbar: pinned view pills, then the tab strip
 * (strip > scroll region > content row > tab wrappers).
 */
function strip(count: number, active = 0, pinned = 0) {
  const group = document.createElement("div");
  group.setAttribute("data-sidebar-split-tab-group", "pane-primary");
  const region = document.createElement("div");
  region.setAttribute("data-secondary-panel-tab-scroll-region", "true");
  group.append(region);
  const buttons = Array.from({ length: count }, (_, index) => {
    const pill = document.createElement("div");
    pill.setAttribute("data-tab-pill", "");
    const button = document.createElement("button");
    button.setAttribute("aria-pressed", String(index === active));
    pill.append(button);
    (index < pinned ? group : region).append(pill);
    return button;
  });
  document.body.append(group);
  return { group, buttons };
}

/** Moves the selection the way bb does: both buttons flip in one commit. */
function select(from: HTMLButtonElement, to: HTMLButtonElement) {
  from.setAttribute("aria-pressed", "false");
  to.setAttribute("aria-pressed", "true");
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

test("the desktop toolbar switches instantly, icon and labeled tabs alike", async () => {
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

test("slides the highlight to a tapped tab and lands it", async () => {
  const { root, pins, chips } = pager(2, 0);
  const { dispose } = mount();
  select(chips[0]!, pins[0]!);
  await frame();
  const ghost = root.querySelector(GLIDE);
  expect(root.lastElementChild).toBe(ghost);
  expect(ghost?.getAttribute("aria-hidden")).toBe("true");
  expect(pins[0]!.parentElement!.hasAttribute(TARGET)).toBe(true);
  expect(root.hasAttribute("data-monokai-tab-glide-host")).toBe(true);
  animations[0]!.finish();
  await frame();
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(root.hasAttribute("data-monokai-tab-glide-host")).toBe(false);
  expect(pins[0]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  dispose();
});

test("a keyboard switch, reduced motion, or a closed tab stays instant", async () => {
  const keyboard = pager(2, 0);
  const first = mount({ pointer: false });
  select(keyboard.chips[0]!, keyboard.pins[0]!);
  await frame();
  expect(keyboard.root.querySelector(GLIDE)).toBeNull();
  first.dispose();

  const reduced = pager(2, 0);
  const second = mount({ reduced: true });
  select(reduced.chips[0]!, reduced.pins[0]!);
  await frame();
  expect(reduced.root.querySelector(GLIDE)).toBeNull();
  second.dispose();

  const closed = pager(2, 0);
  const third = mount();
  closed.chips[0]!.closest("[data-tab-pill]")!.parentElement!.remove();
  closed.chips[1]!.setAttribute("aria-pressed", "true");
  await frame();
  expect(closed.root.querySelector(GLIDE)).toBeNull();
  third.dispose();
  expect(animations).toHaveLength(0);
});

test("a switch mid-flight replaces the flight with one highlight", async () => {
  const { root, pins, chips } = pager(2, 0);
  const { dispose } = mount();
  select(chips[0]!, pins[0]!);
  await frame();
  select(pins[0]!, chips[0]!);
  await frame();
  expect(root.querySelectorAll(GLIDE)).toHaveLength(1);
  expect(animations[0]!.cancelled).toBe(true);
  expect(pins[0]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  expect(chips[0]!.parentElement!.hasAttribute(TARGET)).toBe(true);
  dispose();
});

test("lands when bb replaces the target pill mid-flight", async () => {
  const { root, pins, chips } = pager(2, 0);
  const { dispose } = mount();
  select(chips[0]!, pins[0]!);
  await frame();
  const pill = pins[0]!.parentElement!;
  const replacement = pill.cloneNode(true) as HTMLElement;
  replacement.removeAttribute(TARGET);
  pill.replaceWith(replacement);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(root.hasAttribute("data-monokai-tab-glide-host")).toBe(false);
  expect(replacement.hasAttribute(TARGET)).toBe(false);
  dispose();
});

test("works on a pager mounted after the script", async () => {
  const { dispose } = mount();
  const { root, pins, chips } = pager(2, 0);
  select(chips[0]!, pins[0]!);
  await frame();
  expect(root.querySelector(GLIDE)).not.toBeNull();
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
  const { root, pins, chips } = pager(2, 0);
  const { controller } = mount();
  expect(document.querySelector("[data-monokai-tab-glide-style]")).not.toBeNull();
  select(chips[0]!, pins[0]!);
  await frame();
  controller.abort();
  expect(root.querySelector(GLIDE)).toBeNull();
  expect(pins[0]!.parentElement!.hasAttribute(TARGET)).toBe(false);
  expect(document.querySelector("[data-monokai-tab-glide-style]")).toBeNull();
  select(pins[0]!, chips[0]!);
  await frame();
  expect(root.querySelector(GLIDE)).toBeNull();
});
