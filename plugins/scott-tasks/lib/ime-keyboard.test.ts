// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isImeComposing, isNonImeKey } from "./ime-keyboard.js";

describe("ime-keyboard", () => {
  it("detects Chromium isComposing and Safari post-compositionend keyCode 229", () => {
    expect(isImeComposing({ key: "Enter", isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposing({ key: "Enter", isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(false);
    expect(
      isImeComposing({ key: "Escape", nativeEvent: { isComposing: false, keyCode: 229 } }),
    ).toBe(true);
  });

  it("matches non-IME keys and rejects composing ones", () => {
    expect(isNonImeKey({ key: "Enter", isComposing: false, keyCode: 13 }, "Enter")).toBe(true);
    expect(isNonImeKey({ key: "Enter", isComposing: true, keyCode: 13 }, "Enter")).toBe(false);
    expect(isNonImeKey({ key: "Enter", isComposing: false, keyCode: 229 }, "Enter")).toBe(false);
    expect(isNonImeKey({ key: "Escape", isComposing: false, keyCode: 27 }, "Enter")).toBe(false);
  });
});
