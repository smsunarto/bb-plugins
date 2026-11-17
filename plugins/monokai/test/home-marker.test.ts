import { expect, test } from "bun:test";

import { markHome, markPage } from "../app/home-marker.ts";

class MemoryElement {
  readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

test("marks the page while any New thread screen is open", () => {
  const root = new MemoryElement();

  const leaveFirst = markHome(root);
  const leaveSecond = markHome(root);
  expect(root.attributes.has("data-monokai-home")).toBe(true);

  leaveFirst();
  expect(root.attributes.has("data-monokai-home")).toBe(true);

  leaveSecond();
  expect(root.attributes.has("data-monokai-home")).toBe(false);
});

test("counts each page mark separately", () => {
  const root = new MemoryElement();

  const leaveHome = markHome(root);
  const leaveThread = markPage(root, "data-monokai-thread");

  leaveHome();
  expect(root.attributes.has("data-monokai-home")).toBe(false);
  expect(root.attributes.has("data-monokai-thread")).toBe(true);

  leaveThread();
  expect(root.attributes.has("data-monokai-thread")).toBe(false);
});
