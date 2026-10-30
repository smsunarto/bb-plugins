// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rememberHeight, storedHeight, useReservedHeight } from "./reservedHeight";
import { useWidth } from "./components/chartKit";

const observers: ObservedSize[] = [];
class ObservedSize implements ResizeObserver {
  target: Element | null = null;
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(target: Element) {
    this.target = target;
  }
  unobserve() {}
  disconnect() {}
  emit(width: number, height: number) {
    if (this.target === null) throw new Error("Not observing");
    const size = { inlineSize: width, blockSize: height };
    this.callback(
      [
        {
          target: this.target,
          contentRect: new DOMRect(0, 0, width, height),
          borderBoxSize: [size],
          contentBoxSize: [size],
          devicePixelContentBoxSize: [size],
        },
      ],
      this,
    );
  }
}
let container: HTMLDivElement;
let root: Root;
function Block({
  blockKey,
  loading = false,
  provisional = false,
}: {
  blockKey: string;
  loading?: boolean;
  provisional?: boolean;
}) {
  const { content, minHeight } = useReservedHeight(blockKey, loading, provisional);
  return (
    <div style={{ minHeight }}>
      <div key={blockKey} ref={content}>
        Content
      </div>
    </div>
  );
}
function render(blockKey: string, loading = false, provisional = false) {
  act(() => root.render(<Block blockKey={blockKey} loading={loading} provisional={provisional} />));
}
const held = () => container.firstElementChild?.getAttribute("style") ?? "";
const resize = (width: number, height: number) => act(() => observers.at(-1)!.emit(width, height));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", ObservedSize);
  observers.length = 0;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => {
    throw new Error("Forced geometry read");
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("records an observed size without synchronous geometry reads", () => {
  render("observed");
  resize(720, 320);
  expect(storedHeight("observed", 720)).toBe(320);
});
it("drops a reservation from another width before recording shorter content", () => {
  rememberHeight("narrow", 720, 500);
  render("narrow");
  expect(held()).toContain("500px");
  resize(400, 120);
  expect(held()).not.toContain("500px");
  expect(storedHeight("narrow", 400)).toBe(120);
});
it("holds while loading then expires using the last observation without another resize", () => {
  rememberHeight("expiry", 720, 500);
  render("expiry", true);
  resize(720, 100);
  act(() => vi.advanceTimersByTime(6000));
  expect(held()).toContain("500px");
  render("expiry");
  act(() => vi.advanceTimersByTime(4000));
  expect(held()).not.toContain("500px");
  expect(storedHeight("expiry", 720)).toBe(100);
});
it("settles provisional content without needing another resize", () => {
  render("provisional", false, true);
  resize(720, 180);
  expect(storedHeight("provisional")).toBeNull();
  render("provisional");
  expect(storedHeight("provisional", 720)).toBe(180);
});
it("does not transfer a measurement to another block or accept a disconnected observer", () => {
  render("old", true);
  resize(720, 200);
  const old = observers.at(-1)!;
  rememberHeight("new", 400, 450);
  render("new");
  act(() => old.emit(720, 999));
  expect(storedHeight("old")).toBeNull();
  expect(storedHeight("new", 400)).toBe(450);
  act(() => vi.advanceTimersByTime(4000));
  expect(held()).not.toContain("450px");
  expect(storedHeight("new", 400)).toBe(450);
});

it("measures a chart frame that appears later without reading clientWidth on mount", () => {
  function ChartFrame({ visible }: { visible: boolean }) {
    const [ref, width] = useWidth<HTMLDivElement>();
    return (
      <section>
        <output>{width}</output>
        {visible ? <div ref={ref}>Chart</div> : null}
      </section>
    );
  }
  const read = vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(() => {
    throw new Error("Forced chart layout");
  });
  act(() => root.render(<ChartFrame visible={false} />));
  act(() => root.render(<ChartFrame visible />));
  expect(container.querySelector("output")?.textContent).toBe("0");
  resize(320, 180);
  expect(container.querySelector("output")?.textContent).toBe("320");
  expect(read).not.toHaveBeenCalled();
});
