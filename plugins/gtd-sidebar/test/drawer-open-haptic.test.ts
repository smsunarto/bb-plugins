import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
const { mountDrawerOpenHaptic } = await import("../lib/drawer-open-haptic.ts");

// Each step is one task of bb's sidebar code; the observer sees its batch after.
const task = (mutate: () => void) => {
  mutate();
  return new Promise((resolve) => setTimeout(resolve, 0));
};

let inset: HTMLElement;
let plays: number;
let controller: AbortController;

beforeEach(() => {
  inset = document.createElement("main");
  inset.setAttribute("data-sidebar", "inset");
  inset.setAttribute("data-sidebar-shelf", "closed");
  document.body.append(inset);
  plays = 0;
  controller = new AbortController();
  mountDrawerOpenHaptic(document, controller.signal, () => plays++);
});

afterEach(() => {
  controller.abort();
  inset.remove();
});

const startSlide = () => inset.setAttribute("data-vaul-animate", "false");
const endSlide = () => inset.removeAttribute("data-vaul-animate");
const shelf = (state: "open" | "closed") => inset.setAttribute("data-sidebar-shelf", state);

it("plays once when a tapped open finishes sliding", async () => {
  await task(startSlide);
  assert.equal(plays, 0);
  await task(() => {
    shelf("open");
    endSlide();
  });
  assert.equal(plays, 1);
});

it("plays when a swipe settles open, not when the drag starts", async () => {
  await task(() => {
    shelf("open");
    startSlide();
  });
  assert.equal(plays, 0);
  await task(endSlide);
  assert.equal(plays, 1);
});

it("stays silent for a swipe that settles back closed", async () => {
  await task(() => {
    shelf("open");
    startSlide();
  });
  await task(() => {
    shelf("closed");
    endSlide();
  });
  assert.equal(plays, 0);
});

it("stays silent when the open drawer is dragged and springs back", async () => {
  await task(startSlide);
  await task(() => {
    shelf("open");
    endSlide();
  });
  await task(startSlide);
  await task(endSlide);
  assert.equal(plays, 1);
});

it("plays again on the next open after a close", async () => {
  await task(() => {
    shelf("open");
  });
  await task(startSlide);
  await task(() => {
    shelf("closed");
    endSlide();
  });
  await task(startSlide);
  await task(() => {
    shelf("open");
    endSlide();
  });
  assert.equal(plays, 2);
});

it("stops observing once disposed", async () => {
  controller.abort();
  await task(() => shelf("open"));
  assert.equal(plays, 0);
});

it("follows a page that mounts after the script", async () => {
  inset.remove();
  const late = document.createElement("main");
  late.setAttribute("data-sidebar", "inset");
  document.body.append(late);
  late.setAttribute("data-sidebar-shelf", "closed");
  await task(() => late.setAttribute("data-vaul-animate", "false"));
  await task(() => {
    late.setAttribute("data-sidebar-shelf", "open");
    late.removeAttribute("data-vaul-animate");
  });
  assert.equal(plays, 1);
  late.remove();
});
