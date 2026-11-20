import assert from "node:assert/strict";
import { it } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
const { mountSearchCustomizeStyle } = await import("../components/nav/search-customize-style.ts");

const styles = () => document.head.querySelectorAll("style[data-gtd-search-customize-style]");

it("adds one rule that hides only Search's checkbox, and removes it on dispose", () => {
  const controller = new AbortController();
  const dispose = mountSearchCustomizeStyle(document, controller.signal);
  assert.equal(styles().length, 1);
  const rule = styles()[0]!.textContent ?? "";
  assert.match(rule, /data-plugin-nav-customize-checkbox="__bb__\/search-threads"/);
  assert.match(rule, /visibility: hidden/);
  dispose();
  assert.equal(styles().length, 0);
});

it("adds nothing once the content script is already stopped", () => {
  const controller = new AbortController();
  controller.abort();
  mountSearchCustomizeStyle(document, controller.signal)();
  assert.equal(styles().length, 0);
});
