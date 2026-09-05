import "./helpers/dom.ts";
import { afterEach, expect, mock, test } from "bun:test";
import { mountLinkHints } from "../app/link-hints.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  document.body.replaceChildren();
});

function mount() {
  const controller = new window.AbortController();
  const dispose = mountLinkHints({ pluginId: "vimium", generation: 1, signal: controller.signal });
  cleanup.push(() => {
    controller.abort();
    dispose?.();
  });
  return controller;
}

// BB's custom AppToastContent markup, including the thread title's own button.
function toast(title = "Thread Archived", threadTitle = "Archived thread") {
  const element = document.createElement("li");
  element.className = "bb-app-toast";
  element.setAttribute("data-sonner-toast", "");
  element.innerHTML = `<div><div><div></div><div><div><div></div></div><div><div data-testid="app-toast-description"><span><button title="Open thread"></button></span></div><button>Undo</button></div></div><button aria-label="Dismiss notification">×</button></div></div>`;
  element.querySelector("div > div > div:nth-child(2) > div > div")!.textContent = title;
  const open = element.querySelector<HTMLButtonElement>("button[title]")!;
  open.textContent = threadTitle;
  const undo = [...element.querySelectorAll("button")].find(
    (button) => button !== open && button.textContent === "Undo",
  )!;
  const restore = mock(() => {});
  const navigate = mock(() => expect(restore).toHaveBeenCalledTimes(1));
  undo.addEventListener("click", restore);
  open.addEventListener("click", navigate);
  document.body.prepend(element);
  return { element, open, undo, restore, navigate };
}

function press(target: EventTarget = window, extra: KeyboardEventInit = {}) {
  return target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "E",
      code: "KeyE",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...extra,
    }),
  );
}

test("clicking Undo restores then opens that exact thread, even when its title is Undo", () => {
  const archived = toast("Thread Archived", "Undo");
  mount();
  archived.undo.click();
  expect(archived.restore).toHaveBeenCalledTimes(1);
  expect(archived.navigate).toHaveBeenCalledTimes(1);
});

test("Shift+E chooses the newest archive and skips consumed and removed toasts", () => {
  const older = toast();
  const newest = toast();
  const removed = toast();
  removed.element.setAttribute("data-removed", "true");
  const unrelated = toast("File deleted");
  mount();
  expect(press()).toBe(false);
  expect(newest.navigate).toHaveBeenCalledTimes(1);
  expect(press(window, { repeat: true })).toBe(true);
  expect(older.restore).not.toHaveBeenCalled();
  expect(press()).toBe(false);
  expect(older.navigate).toHaveBeenCalledTimes(1);
  expect(removed.restore).not.toHaveBeenCalled();
  expect(unrelated.restore).not.toHaveBeenCalled();
  expect(press()).toBe(true);
});

test("Shift+E leaves editable fields and modified keys alone", () => {
  const archived = toast();
  const editor = document.createElement("textarea");
  document.body.append(editor);
  mount();
  expect(press(editor)).toBe(true);
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    expect(press(window, extra)).toBe(true);
  }
  expect(archived.restore).not.toHaveBeenCalled();
});

test("other Undo notifications and missing or disabled archive controls fall through", () => {
  const unrelated = toast("File deleted");
  const missing = toast();
  missing.open.remove();
  const disabled = toast();
  disabled.undo.disabled = true;
  mount();
  unrelated.undo.click();
  expect(unrelated.navigate).not.toHaveBeenCalled();
  expect(press()).toBe(true);
  expect(missing.restore).not.toHaveBeenCalled();
});

test("aborting the content script removes both mouse and keyboard behavior", () => {
  const archived = toast();
  mount().abort();
  expect(press()).toBe(true);
  archived.undo.click();
  expect(archived.restore).toHaveBeenCalledTimes(1);
  expect(archived.navigate).not.toHaveBeenCalled();
});
