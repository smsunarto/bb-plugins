import { expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

import { mountThreadHeaderRows } from "../app/thread-header-rows.ts";

installDom();

test("marks zero-height header rows and clears the mark as rows gain height or unmount", async () => {
  const empty = "data-monokai-empty-thread-header-rows";
  const targets = new Set<Element>();
  let measure: (target: Element, height: number) => void = () => {};
  const original = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      constructor(
        callback: (entries: Pick<ResizeObserverEntry, "target" | "borderBoxSize">[]) => void,
      ) {
        measure = (target, blockSize) =>
          callback([{ target, borderBoxSize: [{ blockSize, inlineSize: 390 }] }]);
      }
      observe = (target: Element) => targets.add(target);
      unobserve = (target: Element) => targets.delete(target);
      disconnect = () => targets.clear();
    },
  });

  const pane = document.createElement("section");
  const existing = document.createElement("div");
  existing.setAttribute("data-thread-header-rows", "");
  pane.append(existing);
  document.body.append(pane);
  const controller = new AbortController();
  try {
    const dispose = mountThreadHeaderRows({ signal: controller.signal });
    expect(targets.has(existing)).toBe(true);
    measure(existing, 0);
    expect(existing.hasAttribute(empty)).toBe(true);
    measure(existing, 32);
    expect(existing.hasAttribute(empty)).toBe(false);
    measure(existing, 0);

    const late = document.createElement("div");
    late.setAttribute("data-thread-header-rows", "");
    existing.replaceWith(late);
    await Promise.resolve();
    expect(targets.has(existing)).toBe(false);
    expect(existing.hasAttribute(empty)).toBe(false);
    expect(targets.has(late)).toBe(true);
    measure(late, 0);
    expect(late.hasAttribute(empty)).toBe(true);
    controller.abort();
    dispose?.();
    expect(late.hasAttribute(empty)).toBe(false);
    expect(targets.size).toBe(0);
  } finally {
    controller.abort();
    pane.remove();
    if (original) Object.defineProperty(globalThis, "ResizeObserver", original);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});
