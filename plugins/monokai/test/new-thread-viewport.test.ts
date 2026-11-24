import { afterEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import { mountNewThreadLayout } from "../app/new-thread-layout.ts";

installDom();
afterEach(() => document.body.replaceChildren());

const marker = "data-monokai-compose-viewport";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function viewport() {
  const node = document.createElement("div");
  node.innerHTML = '<div data-testid="root-compose-compact-home"></div>';
  document.body.append(node);
  return node;
}

test("marks only mounted home wrappers and releases them on replacement or disposal", async () => {
  const first = viewport();
  const controller = new AbortController();
  mountNewThreadLayout({ signal: controller.signal });
  expect(first.hasAttribute(marker)).toBe(true);

  const late = viewport();
  first.replaceChildren();
  await flush();
  expect(first.hasAttribute(marker)).toBe(false);
  expect(late.hasAttribute(marker)).toBe(true);

  const replacement = viewport();
  const home = replacement.firstElementChild;
  if (!home) throw new Error("Missing home");
  late.replaceChildren(home);
  await flush();
  expect(late.hasAttribute(marker)).toBe(true);
  expect(replacement.hasAttribute(marker)).toBe(false);

  controller.abort();
  expect(late.hasAttribute(marker)).toBe(false);
  const after = viewport();
  await flush();
  expect(after.hasAttribute(marker)).toBe(false);
});
