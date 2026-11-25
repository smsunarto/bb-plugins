import { expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

import { mountThreadHeaderRows, registerThreadHeaderMarker } from "../app/thread-header-rows.ts";

installDom();

test("tracks invisible contributors and visible rows only while the viewport is compact", () => {
  const empty = "data-monokai-empty-thread-header-rows";
  const targets = new Set<Element>();
  const media = Object.assign(new window.EventTarget(), { matches: false });
  const setCompact = (matches: boolean) => {
    media.matches = matches;
    media.dispatchEvent(new window.Event("change"));
  };
  let observerCount = 0;
  let measure: (target: Element, height: number) => void = () => {};
  const original = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      expect(query).toBe("(max-width: 767px)");
      return media;
    },
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      constructor(
        callback: (entries: Pick<ResizeObserverEntry, "target" | "borderBoxSize">[]) => void,
      ) {
        observerCount++;
        measure = (target, blockSize) =>
          callback([{ target, borderBoxSize: [{ blockSize, inlineSize: 390 }] }]);
      }
      observe = (target: Element) => targets.add(target);
      unobserve = (target: Element) => targets.delete(target);
      disconnect = () => targets.clear();
    },
  });

  const fixture = document.createElement("div");
  fixture.innerHTML = `
    <section data-split-pane-id="one">
      <header></header>
      <div data-thread-header-rows>
        <div data-bb-plugin="monokai"><span hidden></span></div>
        <div data-bb-plugin="kitchen-sink"><span hidden></span></div>
      </div>
      <div data-thread-window></div>
    </section>
    <section data-split-pane-id="two">
      <header></header>
      <div data-thread-header-rows><div data-bb-plugin="monokai"><span hidden></span></div></div>
      <div data-thread-window></div>
    </section>
    <div data-thread-header-rows></div>`;
  document.body.append(fixture);
  const [first, second] = fixture.querySelectorAll("[data-thread-header-rows]");
  const kitchenSink = first?.querySelector<HTMLSpanElement>("[data-bb-plugin=kitchen-sink] span");
  if (!first || !second || !kitchenSink) throw new Error("Missing test header rows");
  const removeFirst = registerThreadHeaderMarker(
    first.querySelector("[data-bb-plugin=monokai] span"),
  );
  const removeSecond = registerThreadHeaderMarker(second.querySelector("span"));
  const controller = new AbortController();
  try {
    const dispose = mountThreadHeaderRows({ signal: controller.signal });
    expect(observerCount).toBe(0);
    setCompact(true);
    expect(targets).toEqual(new Set([first, second]));
    measure(first, 0);
    expect(first.hasAttribute(empty)).toBe(true);
    kitchenSink.hidden = false;
    measure(first, 32);
    expect(first.hasAttribute(empty)).toBe(false);
    kitchenSink.hidden = true;
    measure(first, 0);

    setCompact(false);
    expect(first.hasAttribute(empty)).toBe(false);
    expect(targets.size).toBe(0);
    setCompact(true);
    expect(observerCount).toBe(2);
    expect(targets).toEqual(new Set([first, second]));
    measure(first, 0);
    measure(second, 0);
    expect(first.hasAttribute(empty)).toBe(true);
    removeFirst?.();
    expect(targets.has(first)).toBe(false);
    expect(first.hasAttribute(empty)).toBe(false);
    controller.abort();
    dispose?.();
    expect(second.hasAttribute(empty)).toBe(false);
    expect(targets.size).toBe(0);
    setCompact(false);
    setCompact(true);
    expect(observerCount).toBe(2);
  } finally {
    controller.abort();
    removeFirst?.();
    removeSecond?.();
    fixture.remove();
    if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else Reflect.deleteProperty(window, "matchMedia");
    if (original) Object.defineProperty(globalThis, "ResizeObserver", original);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});
