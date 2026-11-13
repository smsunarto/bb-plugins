import { afterEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
const { mountContextCardState } = await import("../app/context-card-state.ts");

const ATTRIBUTE = "data-monokai-context-card";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.replaceChildren();
});

/** bb's thread pane: the window holds a scroll overlay with the floating card. */
function threadWindow({ card = true, hidden = false } = {}) {
  const window = document.createElement("div");
  window.setAttribute("data-thread-window", "");
  const overlay = document.createElement("div");
  overlay.setAttribute("data-scroll-overlay", "");
  window.append(overlay);
  document.body.append(window);
  if (card) overlay.append(contextCard(hidden));
  return { window, overlay };
}

function contextCard(hidden = false) {
  const card = document.createElement("div");
  card.setAttribute("data-thread-context-card", "");
  card.hidden = hidden;
  return card;
}

function mount() {
  const controller = new AbortController();
  const dispose = mountContextCardState({ signal: controller.signal } as never);
  return { controller, dispose };
}

test("marks cards present at mount", () => {
  const open = threadWindow();
  const closed = threadWindow({ hidden: true });
  const banner = threadWindow({ card: false });
  const { dispose } = mount();
  expect(open.window.getAttribute(ATTRIBUTE)).toBe("shown");
  expect(closed.window.getAttribute(ATTRIBUTE)).toBe("hidden");
  expect(banner.window.hasAttribute(ATTRIBUTE)).toBe(false);
  dispose();
});

test("follows a card that mounts late, toggles, and is replaced on re-render", async () => {
  const { window, overlay } = threadWindow({ card: false });
  const { dispose } = mount();

  overlay.append(contextCard());
  await flush();
  expect(window.getAttribute(ATTRIBUTE)).toBe("shown");

  overlay.querySelector<HTMLElement>("[data-thread-context-card]")!.hidden = true;
  await flush();
  expect(window.getAttribute(ATTRIBUTE)).toBe("hidden");

  overlay.replaceChildren(contextCard());
  await flush();
  expect(window.getAttribute(ATTRIBUTE)).toBe("shown");
  dispose();
});

test("clears the mark when the card unmounts, so no stale shift remains", async () => {
  const { window, overlay } = threadWindow();
  const { dispose } = mount();
  overlay.replaceChildren();
  await flush();
  expect(window.hasAttribute(ATTRIBUTE)).toBe(false);
  dispose();
});

test("ignores the portaled popover card and unrelated hidden changes", async () => {
  const { window } = threadWindow({ card: false });
  const { dispose } = mount();
  document.body.append(contextCard());
  const other = document.createElement("div");
  window.append(other);
  other.hidden = true;
  await flush();
  expect(window.hasAttribute(ATTRIBUTE)).toBe(false);
  dispose();
});

test("disposal removes every mark and stops observing", async () => {
  const { window, overlay } = threadWindow();
  const { controller } = mount();
  controller.abort();
  expect(window.hasAttribute(ATTRIBUTE)).toBe(false);
  overlay.replaceChildren(contextCard());
  await flush();
  expect(window.hasAttribute(ATTRIBUTE)).toBe(false);
});
