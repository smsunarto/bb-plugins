import "./dom.ts";
import { expect, test } from "bun:test";
import { keepInView, scrollingAncestor } from "../src/app/lib/utils.ts";

/** Give `node` a layout jsdom cannot compute: its box, and how tall its content is. */
function layout(
  node: HTMLElement,
  box: { top: number; height: number },
  scrollHeight = box.height,
) {
  Object.defineProperty(node, "clientHeight", { configurable: true, value: box.height });
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: scrollHeight });
  node.getBoundingClientRect = () =>
    ({ top: box.top - node.scrollTop, bottom: box.top - node.scrollTop + box.height }) as DOMRect;
}

test("a selected row below bb's sidebar fold scrolls the sidebar, not the grown inbox list", () => {
  // bb's sidebar scrolls; the inbox list inside it grows with its rows.
  const sidebar = document.createElement("div");
  sidebar.style.overflowY = "auto";
  const list = document.createElement("div");
  list.style.overflowY = "auto";
  const row = document.createElement("button");
  list.append(row);
  sidebar.append(list);
  document.body.append(sidebar);
  layout(sidebar, { top: 0, height: 600 }, 2000);
  layout(list, { top: 0, height: 2000 });
  row.getBoundingClientRect = () =>
    ({ top: 1500 - sidebar.scrollTop, bottom: 1530 - sidebar.scrollTop }) as DOMRect;

  const area = scrollingAncestor(row);
  expect(area).toBe(sidebar);
  keepInView(area!, row);
  expect(sidebar.scrollTop).toBe(930);
  sidebar.remove();
});

test("a row with no scrolling ancestor has nothing to reveal", () => {
  const row = document.createElement("button");
  document.body.append(row);
  expect(scrollingAncestor(row)).toBeNull();
  row.remove();
});
