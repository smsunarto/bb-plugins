import { test } from "bun:test";
import assert from "node:assert/strict";
import type { PluginCodeThemeState } from "@get-bb/plugin-sdk/app";
import { derivePalette, hueOf, parseHex, withAlpha } from "./theme.ts";

const sparse: PluginCodeThemeState = {
  mode: "light",
  name: "sparse",
  theme: {
    name: "sparse",
    type: "light",
    fg: "#222222",
    bg: "#ffffff",
    colors: { "textLink.foreground": "#0055cc" },
    tokenColors: [{ scope: "keyword", settings: { foreground: "#aa00aa" } }],
  },
};

const full: PluginCodeThemeState = {
  mode: "dark",
  name: "full",
  theme: {
    name: "full",
    type: "dark",
    fg: "#c0caf5",
    bg: "#1a1b26",
    colors: {
      focusBorder: "#7aa2f7",
      "textLink.foreground": "#2ac3de",
      "charts.green": "#9ece6a",
      "charts.red": "#f7768e",
      "charts.yellow": "#e0af68",
      "charts.blue": "#7aa2f7",
      "charts.orange": "#ff9e64",
      "charts.purple": "#bb9af7",
    },
    tokenColors: [
      { scope: ["keyword.control", "storage"], settings: { foreground: "#bb9af7" } },
      { scope: "string", settings: { foreground: "#9ece6a" } },
      { scope: "entity.name.function", settings: { foreground: "#7aa2f7" } },
      { scope: "constant.numeric", settings: { foreground: "#ff9e64" } },
      { scope: "variable", settings: { foreground: "#c0caf5" } },
    ],
  },
};

test("null theme yields the fixed ramp for the mode", () => {
  const dark = derivePalette({ mode: "dark", name: "x", theme: null });
  const light = derivePalette({ mode: "light", name: "x", theme: null });
  assert.equal(dark.fallback, true);
  assert.equal(light.fallback, true);
  assert.notEqual(dark.accent, light.accent);
  assert.equal(dark.series.length, 8);
  assert.equal(light.series.length, 8);
  assert.equal(Object.keys(dark.tone).length, 5);
});

test("sparse theme falls back per key and pads the series", () => {
  const palette = derivePalette(sparse);
  assert.equal(palette.fallback, false);
  assert.equal(palette.accent, "#0055cc");
  assert.equal(palette.tone.info, "#0055cc");
  assert.equal(palette.tone.success, "#2e8b57");
  assert.equal(palette.tone.neutral, "rgba(34, 34, 34, 0.6)");
  assert.equal(palette.series[0], "#aa00aa");
  assert.ok(palette.series.length >= 3);
  assert.equal(new Set(palette.series).size, palette.series.length);
});

test("full theme uses charts keys first and dedupes token colors by hue", () => {
  const palette = derivePalette(full);
  assert.equal(palette.accent, "#7aa2f7");
  assert.deepEqual(
    { ...palette.tone, neutral: undefined },
    {
      info: "#7aa2f7",
      success: "#9ece6a",
      warning: "#e0af68",
      danger: "#f7768e",
      neutral: undefined,
    },
  );
  assert.equal(palette.series[0], "#7aa2f7");
  assert.equal(palette.series.length, 5);
  assert.ok(!palette.series.includes("#ff9e64"), "orange sits within 25 degrees of yellow");
  assert.ok(!palette.series.includes("#c0caf5"), "near-gray variable color has no hue");
  assert.equal(palette.stroke, "rgba(192, 202, 245, 0.15)");
});

test("color helpers parse short, long, and alpha hex forms", () => {
  assert.deepEqual(parseHex("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHex("#00ff0080"), { r: 0, g: 255, b: 0 });
  assert.equal(parseHex("red"), null);
  assert.equal(withAlpha("#000000", 0.5), "rgba(0, 0, 0, 0.5)");
  assert.equal(withAlpha("nope", 0.5), "nope");
  assert.equal(hueOf("#ff0000"), 0);
  assert.equal(hueOf("#00ff00"), 120);
  assert.equal(hueOf("#808080"), null);
});
