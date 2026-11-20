import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import { mountPanelDepth } from "../app/panel-depth.ts";

installDom();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const WIDTH = window.innerWidth * 0.9;

let inset: HTMLElement;
let controller: AbortController;
let escapes: number;
const onKey = (event: KeyboardEvent) => {
  if (event.key === "Escape") escapes++;
};

beforeEach(() => {
  inset = document.createElement("main");
  inset.setAttribute("data-sidebar", "inset");
  inset.setAttribute("data-panel-shelf", "closed");
  document.body.append(inset);
  escapes = 0;
  document.addEventListener("keydown", onKey);
  controller = new AbortController();
  mountPanelDepth({ signal: controller.signal });
});

afterEach(() => {
  controller.abort();
  document.removeEventListener("keydown", onKey);
  document.body.replaceChildren();
});

const washElement = () => inset.querySelector<HTMLElement>("[data-monokai-panel-wash]");
const wash = () => washElement()?.style.opacity ?? "";
const depth = () => inset.getAttribute("data-monokai-panel-depth");
const drag = (px: number) => {
  inset.style.translate = `${px}px`;
  inset.style.transition = "none";
};
const settle = (px: number) => {
  inset.style.translate = `${px}px`;
  inset.style.transition = "translate 220ms ease";
};

test("a tapped open washes and frames the page, and hides the left drawer behind it", async () => {
  inset.append(document.createElement("section"));
  inset.setAttribute("data-panel-shelf", "full");
  await flush();
  expect([wash(), depth()]).toEqual(["1", ""]);
  expect(inset.lastElementChild).toBe(washElement());
  expect(document.documentElement.getAttribute("data-monokai-panel-depth")).toBe("");
});

test("keeps one wash as the page's last child when the page re-renders", async () => {
  inset.setAttribute("data-panel-shelf", "full");
  await flush();
  inset.append(document.createElement("section"));
  inset.style.translate = "-10px";
  await flush();
  expect(inset.querySelectorAll("[data-monokai-panel-wash]").length).toBe(1);
  expect(inset.lastElementChild).toBe(washElement());
});

test("the wash follows a swipe, and the swipe stops at the drawer's width", async () => {
  drag(-WIDTH / 2);
  await flush();
  expect(Number(wash())).toBeCloseTo(0.5, 2);
  expect(depth()).toBe("dragging");
  settle(-window.innerWidth); // bb settles toward the full screen width.
  await flush();
  expect(Number.parseFloat(inset.style.translate)).toBeCloseTo(-WIDTH, 2);
  expect([wash(), depth()]).toEqual(["1", ""]);
});

test("a swipe released back closed fades the wash and drops the framing once it lands", async () => {
  drag(-60);
  await flush();
  settle(0);
  await flush();
  expect(wash()).toBe("0");
  expect(depth()).toBe(""); // still framed while it slides back, and the wash fades
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect([depth(), washElement()]).toEqual([null, null]);
  expect(document.documentElement.hasAttribute("data-monokai-panel-depth")).toBe(false);
});

test("a tap on the wash closes the panel through Escape", async () => {
  inset.setAttribute("data-panel-shelf", "full");
  await flush();
  washElement()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(escapes).toBe(1);
  const child = document.createElement("button");
  inset.append(child);
  child.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(escapes).toBe(1);
});

const touch = (target: Element, type: string, x: number, y: number) => {
  const point = { identifier: 1, target, clientX: x, clientY: y } as unknown as Touch;
  const event = new window.Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  const list = type === "touchend" ? [] : [point];
  Object.defineProperty(event, "touches", {
    value: Object.assign(list, { item: (i: number) => list[i] ?? null }),
  });
  Object.defineProperty(event, "changedTouches", { value: [point] });
  target.dispatchEvent(event);
};
const swipeAcross = (target: Element, dx: number, dy = 0) => {
  touch(target, "touchstart", 10, 300);
  touch(target, "touchend", 10 + dx, 300 + dy);
};

test("the wash opts out of bb's left drawer swipe, and a rightward swipe on it closes the panel", async () => {
  inset.setAttribute("data-panel-shelf", "full");
  await flush();
  const overlay = washElement()!;
  expect(overlay.hasAttribute("data-no-sidebar-swipe")).toBe(true);
  swipeAcross(overlay, 20);
  swipeAcross(overlay, -80);
  swipeAcross(overlay, 40, 60);
  expect(escapes).toBe(0);
  swipeAcross(overlay, 80, 10);
  expect(escapes).toBe(1);
  const child = document.createElement("section");
  inset.append(child);
  swipeAcross(child, 80);
  expect(escapes).toBe(1);
});

test("leaves the page alone when the panel is closed or the left drawer is open", async () => {
  inset.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(escapes).toBe(0);
  inset.setAttribute("data-panel-shelf", "full");
  await flush();
  inset.removeAttribute("data-panel-shelf");
  await flush();
  expect([wash(), depth()]).toEqual(["", null]);
});

test("removes what it added once disposed", async () => {
  inset.setAttribute("data-panel-shelf", "full");
  await flush();
  controller.abort();
  expect([washElement(), depth()]).toEqual([null, null]);
  expect(document.documentElement.hasAttribute("data-monokai-panel-depth")).toBe(false);
});
