import { expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import { mountBbDomStyles } from "../app/bb-dom-styles.ts";

installDom();

test("mounts one marked stylesheet and removes it on disposal", () => {
  const controller = new window.AbortController();
  const selector = "style[data-monokai-bb-dom-styles]";
  const dispose = mountBbDomStyles({ signal: controller.signal, document });
  try {
    const [style] = document.querySelectorAll(selector);
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(style?.textContent).toContain("[data-t3-model-search]");
    expect(style?.textContent).toContain('[aria-label="Recent"]');
  } finally {
    controller.abort();
    dispose();
  }
  expect(document.querySelector(selector)).toBeNull();
  mountBbDomStyles({ signal: controller.signal, document });
  expect(document.querySelector(selector)).toBeNull();
});
