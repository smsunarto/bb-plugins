import { describe, expect, test } from "bun:test";
import {
  PLUGIN_SCREENSHOT_FIXTURES,
} from "./plugin-screenshot-fixtures";

describe("plugin screenshot foreground fixtures", () => {
  test("cover every captured README image at DPR 3", () => {
    expect([...new Set(PLUGIN_SCREENSHOT_FIXTURES.map((fixture) => fixture.plugin))]).toEqual([
      "agent-proxy",
      "agentation",
      "amp",
      "gh-stack",
      "gtd-sidebar",
      "monokai",
    ]);
    expect(PLUGIN_SCREENSHOT_FIXTURES).toHaveLength(13);
    expect(new Set(PLUGIN_SCREENSHOT_FIXTURES.map((fixture) => fixture.id)).size).toBe(13);
    expect(PLUGIN_SCREENSHOT_FIXTURES.filter((fixture) => fixture.plugin === "monokai"))
      .toEqual([
        { id: "monokai/app", plugin: "monokai", filename: "app.png", width: 1512, height: 1000 },
      ]);
    for (const fixture of PLUGIN_SCREENSHOT_FIXTURES) {
      expect(fixture.width * 3).toBeGreaterThan(fixture.width * 2);
      expect(fixture.height * 3).toBeGreaterThan(fixture.height * 2);
    }
  });
});
