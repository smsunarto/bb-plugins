import { expect, test } from "bun:test";
import { mountSidebarColumnFill } from "../src/sidebar-fill";

type Entry = {
  target: unknown;
  contentRect: { height: number };
  borderBoxSize: { blockSize: number }[];
};

/** bb's column > its block > the plugin root, with a fake observer and frame queue. */
function setup() {
  const observers: { callback: (entries: Entry[]) => void; observed: unknown[]; on: boolean }[] =
    [];
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  const view = {
    ResizeObserver: class {
      record: (typeof observers)[number];
      constructor(callback: (entries: Entry[]) => void) {
        this.record = { callback, observed: [], on: true };
        observers.push(this.record);
      }
      observe(target: unknown) {
        this.record.observed.push(target);
      }
      disconnect() {
        this.record.on = false;
      }
    },
    requestAnimationFrame(run: () => void) {
      frames.set(nextFrame, run);
      return nextFrame++;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
  };
  const style = new Map<string, string>();
  const column = { parentElement: null };
  const block = { parentElement: column };
  const root = {
    parentElement: block,
    ownerDocument: { defaultView: view },
    closest: (selector: string) => (selector === '[data-sidebar="content"]' ? column : null),
    style: {
      set height(value: string) {
        style.set("height", value);
      },
      removeProperty: (name: string) => style.delete(name),
    },
  };
  const resize = (sizes: [unknown, number][]) =>
    observers[0]!.callback(
      sizes.map(([target, height]) => ({
        target,
        contentRect: { height },
        borderBoxSize: [{ blockSize: height }],
      })),
    );
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const run of pending) run();
  };
  return { observers, frames, style, column, block, root, resize, flush };
}

test("the root takes the column's height less what bb draws around it, in one frame", () => {
  const s = setup();
  mountSidebarColumnFill(s.root as unknown as HTMLElement);
  expect(s.observers[0]!.observed).toEqual([s.column, s.root, s.block]);
  // A 20px title and 10px padding sit in the block beside a 100px root.
  s.resize([
    [s.column, 1032],
    [s.block, 130],
    [s.root, 100],
  ]);
  expect(s.style.get("height")).toBeUndefined();
  expect(s.frames.size).toBe(1);
  s.flush();
  expect(s.style.get("height")).toBe("1002px");
  // The write's own resize asks for the same height and writes nothing more.
  s.resize([
    [s.block, 1032],
    [s.root, 1002],
  ]);
  s.flush();
  expect(s.style.get("height")).toBe("1002px");
  s.resize([[s.column, 400.6]]);
  s.flush();
  expect(s.style.get("height")).toBe("370px");
});

test("disposal disconnects, cancels a pending frame, and clears the height", () => {
  const s = setup();
  const dispose = mountSidebarColumnFill(s.root as unknown as HTMLElement);
  s.resize([
    [s.column, 600],
    [s.block, 110],
    [s.root, 100],
  ]);
  s.flush();
  s.resize([[s.column, 500]]);
  dispose();
  expect(s.observers[0]!.on).toBe(false);
  expect(s.frames.size).toBe(0);
  expect(s.style.has("height")).toBe(false);
});

test("outside bb's sidebar column it does nothing", () => {
  const s = setup();
  const root = { ...s.root, closest: () => null };
  mountSidebarColumnFill(root as unknown as HTMLElement)();
  expect(s.observers).toHaveLength(0);
});
