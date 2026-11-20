import { expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

import { mountBbDomStyles } from "../app/bb-dom-styles.ts";

installDom();

test("short launcher labels inherit visibility from the shelf", () => {
  const dispose = mountBbDomStyles({ signal: new AbortController().signal, document });
  try {
    const style = document.querySelector<HTMLStyleElement>("style[data-monokai-bb-dom-styles]");
    if (!style?.sheet) throw new Error("Launcher styles did not mount");
    const rules = Array.from(style.sheet.cssRules).filter(
      (rule) => rule instanceof window.CSSStyleRule,
    );

    for (const [id, label] of [
      ["file-search-result-start-terminal", "Terminal"],
      ["plugin-action:side-chat:side-chat", "Side chat"],
    ] as const) {
      const button = document.createElement("button");
      button.id = id;
      const span = document.createElement("span");
      button.append(document.createElement("span"), span);
      const source = rules.filter((rule) => span.matches(rule.selectorText));
      const generated = rules.filter(
        (rule) =>
          rule.selectorText.includes("::after") &&
          span.matches(rule.selectorText.replaceAll("::after", "")),
      );

      // A visible override on a pseudo-element paints even when its shelf is hidden.
      expect(generated.map((rule) => rule.style.getPropertyValue("visibility"))).not.toContain(
        "visible",
      );
      expect(source.map((rule) => rule.style.getPropertyValue("visibility"))).not.toContain(
        "hidden",
      );
      expect(
        source.map((rule) => rule.style.getPropertyValue("-webkit-text-fill-color")),
      ).toContain("transparent");
      expect(generated.map((rule) => rule.style.getPropertyValue("content"))).toContain(
        `"${label}" / ""`,
      );
      expect(
        generated.map((rule) => rule.style.getPropertyValue("-webkit-text-fill-color")),
      ).toContain("currentColor");
    }
  } finally {
    dispose();
  }
});
