import { afterEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
const { isToolbarChrome, toolbarIsBusy } = await import("../lib/toolbar.ts");

afterEach(() => {
  document.body.replaceChildren();
});

/** Agentation 3.1 renders its UI into an open shadow root on this host. */
function mountToolbar(): ShadowRoot {
  const host = document.createElement("agentation-toolbar");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.append(document.createElement("div"));
  return root;
}

function addField(root: ShadowRoot, options: { value?: string; readOnly?: boolean } = {}) {
  const field = document.createElement("textarea");
  field.value = options.value ?? "";
  field.readOnly = options.readOnly ?? false;
  // jsdom does no layout; give the field the box a rendered popup has.
  field.getBoundingClientRect = () => ({ width: 248, height: 57 }) as DOMRect;
  root.firstElementChild!.append(field);
  return field;
}

test("clicks inside the toolbar's shadow root count as toolbar chrome", () => {
  mountToolbar();
  const host = document.querySelector("agentation-toolbar");
  const tooltip = document.createElement("div");
  tooltip.setAttribute("data-feedback-toolbar", "");
  const page = document.createElement("button");
  document.body.append(tooltip, page);

  expect(isToolbarChrome(host)).toBe(true);
  expect(isToolbarChrome(tooltip)).toBe(true);
  expect(isToolbarChrome(page)).toBe(false);
});

test("a draft or caret inside the shadow root keeps the toolbar busy", () => {
  const root = mountToolbar();
  const field = addField(root);
  expect(toolbarIsBusy()).toBe(false);

  field.focus();
  expect(toolbarIsBusy()).toBe(true);

  field.blur();
  field.value = "Make the send button primary";
  expect(toolbarIsBusy()).toBe(true);
});

test("a hidden marker preview with a saved comment does not keep the toolbar busy", () => {
  addField(mountToolbar(), { value: "Make the send button primary", readOnly: true });
  expect(toolbarIsBusy()).toBe(false);
});
