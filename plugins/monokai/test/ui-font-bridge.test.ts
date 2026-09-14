import { expect, test } from "bun:test";

import { applyUiFontPreference } from "../app/ui-font-bridge.ts";

class MemoryStyle {
  private readonly values = new Map<string, { value: string; priority: string }>();

  getPropertyPriority(name: string): string {
    return this.values.get(name)?.priority ?? "";
  }

  getPropertyValue(name: string): string {
    return this.values.get(name)?.value ?? "";
  }

  removeProperty(name: string): string {
    const previous = this.getPropertyValue(name);
    this.values.delete(name);
    return previous;
  }

  setProperty(name: string, value: string, priority = ""): void {
    this.values.set(name, { value, priority });
  }
}

test("applies the selected UI font and restores the prior property", () => {
  const style = new MemoryStyle();
  style.setProperty("--bb-monokai-ui-font", "prior-stack", "important");

  const restore = applyUiFontPreference(style, "SF Pro");

  expect(style.getPropertyValue("--bb-monokai-ui-font")).toBe(
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", sans-serif',
  );
  restore();
  expect(style.getPropertyValue("--bb-monokai-ui-font")).toBe("prior-stack");
  expect(style.getPropertyPriority("--bb-monokai-ui-font")).toBe("important");
});

test("normalizes an invalid value to Inter and removes an initially absent property", () => {
  const style = new MemoryStyle();
  const restore = applyUiFontPreference(style, false);

  expect(style.getPropertyValue("--bb-monokai-ui-font")).toBe(
    '"Inter Variable", Inter, sans-serif',
  );
  restore();
  expect(style.getPropertyValue("--bb-monokai-ui-font")).toBe("");
});
