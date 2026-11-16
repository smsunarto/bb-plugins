// @vitest-environment jsdom
// The touch-sized action row is CSS in app.css. jsdom does no layout, so this reads the
// parsed rules for touch screens; the measured widths are in the browser evidence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function coarseRules(): CSSStyleRule[] {
  const style = document.createElement("style");
  style.textContent = readFileSync(join(__dirname, "../app.css"), "utf8");
  document.head.append(style);
  const out: CSSStyleRule[] = [];
  for (const rule of style.sheet!.cssRules) {
    if (rule instanceof CSSMediaRule && rule.media.mediaText === "(pointer: coarse)") {
      for (const inner of rule.cssRules) if (inner instanceof CSSStyleRule) out.push(inner);
    }
  }
  style.remove();
  return out;
}

/** The value the last touch-screen rule naming every `selectors` declares for `property`. */
function declared(selectors: string[], property: string): string {
  const rules = coarseRules().filter(
    (rule) =>
      selectors.every((selector) => rule.selectorText.includes(selector)) &&
      rule.style.getPropertyValue(property) !== "",
  );
  return rules.at(-1)?.style.getPropertyValue(property) ?? "";
}

const ICONS = [
  "[data-t3-composer-actions-menu]",
  "[data-t3-composer-voice]",
  "[data-promptbox-submit-action]",
];
const PILLS = ["[data-t3-composer-controls] button", "[data-t3-permission] button"];

describe("the action row on touch screens", () => {
  it("gives +, the microphone and Send a 44 by 48 target around a 40px circle", () => {
    expect(declared(ICONS, "height")).toBe("48px");
    expect(declared(ICONS, "width")).toBe("44px");
    expect(declared(ICONS, "min-width")).toBe("44px");
    expect(declared(ICONS, "flex-shrink")).toBe("0");
    // 4px top and bottom, 2px sides: a 40px square to paint.
    expect(declared(ICONS, "border-top")).toBe("4px solid transparent");
    expect(declared(ICONS, "border-left")).toBe("2px solid transparent");
    expect(declared(ICONS, "background-clip")).toBe("padding-box");
  });

  it("bounds the model, effort and permission pills", () => {
    expect(declared(PILLS, "height")).toBe("48px");
    expect(declared(PILLS, "min-width")).toBe("44px");
    expect(declared(PILLS, "max-width")).toBe("128px");
    expect(declared(PILLS, "flex-shrink")).toBe("0");
    const model = ["button[data-t3-model-picker-trigger]"];
    expect(declared(model, "min-width")).toBe("64px");
    expect(declared(model, "max-width")).toBe("200px");
    expect(declared(model, "flex-shrink")).toBe("1");
  });

  it("keeps the row on one line", () => {
    expect(declared(["[data-t3-composer-controls]"], "flex-wrap")).toBe("nowrap");
  });
});
