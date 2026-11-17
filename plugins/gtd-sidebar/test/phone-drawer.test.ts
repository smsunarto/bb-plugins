import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
const { mountPhoneDrawer } = await import("../lib/phone-drawer.ts");

// Each step is one task of bb's sidebar code; the observer sees its batch after.
const task = (mutate: () => void) => {
  mutate();
  return new Promise((resolve) => setTimeout(resolve, 0));
};

let inset: HTMLElement;
let openings: number;
let plays: number;
let controller: AbortController;

beforeEach(() => {
  inset = document.createElement("main");
  inset.setAttribute("data-sidebar", "inset");
  inset.setAttribute("data-sidebar-shelf", "closed");
  document.body.append(inset);
  openings = 0;
  plays = 0;
  controller = new AbortController();
  mountPhoneDrawer(document, controller.signal, {
    opening: () => openings++,
    opened: () => plays++,
  });
});

afterEach(() => {
  controller.abort();
  inset.remove();
});

const startSlide = () => inset.setAttribute("data-vaul-animate", "false");
// bb's inline styles: a finger drag, then a settle toward open (the drawer's width) or closed.
const drag = (px: number) => {
  inset.style.translate = `${px}px`;
  inset.style.transition = "none";
};
const settle = (px: number) => {
  inset.style.translate = `${px}px`;
  inset.style.transition = "translate 220ms ease";
};
const endSlide = () => inset.removeAttribute("data-vaul-animate");
const shelf = (state: "open" | "closed") => inset.setAttribute("data-sidebar-shelf", state);

it("starts opening when a tapped open starts sliding, and plays once it finishes", async () => {
  await task(startSlide);
  assert.deepEqual([openings, plays], [1, 0]);
  await task(() => {
    shelf("open");
    endSlide();
  });
  assert.deepEqual([openings, plays], [1, 1]);
});

it("starts opening when a swipe starts, and plays when it settles open", async () => {
  await task(() => {
    shelf("open");
    startSlide();
  });
  assert.deepEqual([openings, plays], [1, 0]);
  await task(endSlide);
  assert.deepEqual([openings, plays], [1, 1]);
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

it("does nothing more when the open drawer is dragged and springs back", async () => {
  await task(startSlide);
  await task(() => {
    shelf("open");
    endSlide();
  });
  await task(startSlide);
  await task(endSlide);
  assert.deepEqual([openings, plays], [1, 1]);
});

it("runs again on the next open after a close", async () => {
  await task(() => shelf("open"));
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
  assert.deepEqual([openings, plays], [2, 2]);
});

it("stops observing once disposed", async () => {
  controller.abort();
  await task(() => shelf("open"));
  assert.deepEqual([openings, plays], [0, 0]);
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

it("dismisses the keyboard of a field on the page as the drawer opens", async () => {
  controller.abort();
  const own = new AbortController();
  mountPhoneDrawer(document, own.signal);
  const composer = document.createElement("textarea");
  inset.append(composer);
  composer.focus();
  assert.equal(document.activeElement, composer);
  await task(startSlide);
  assert.notEqual(document.activeElement, composer);
  own.abort();
});

it("leaves a field outside the page focused", async () => {
  controller.abort();
  const own = new AbortController();
  mountPhoneDrawer(document, own.signal);
  const search = document.createElement("input");
  document.body.append(search);
  search.focus();
  await task(startSlide);
  assert.equal(document.activeElement, search);
  search.remove();
  own.abort();
});

it("plays as a tapped open starts settling, not when it lands", async () => {
  await task(() => {
    startSlide();
    settle(300);
  });
  assert.deepEqual([openings, plays], [1, 1]);
  await task(() => {
    shelf("open");
    endSlide();
  });
  assert.deepEqual([openings, plays], [1, 1]);
});

it("plays when a swipe is released toward open, not while it drags", async () => {
  await task(() => {
    shelf("open");
    startSlide();
    drag(40);
  });
  await task(() => drag(180));
  assert.equal(plays, 0);
  await task(() => settle(300));
  assert.equal(plays, 1);
  await task(endSlide);
  assert.equal(plays, 1);
});

it("stays silent for a swipe released back toward closed", async () => {
  await task(() => {
    shelf("open");
    startSlide();
    drag(60);
  });
  await task(() => settle(0));
  await task(() => {
    shelf("closed");
    endSlide();
  });
  assert.equal(plays, 0);
});
