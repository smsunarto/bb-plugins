import type { PluginCodeThemeState } from "@get-bb/plugin-sdk/app";
import type { Tone } from "../shared/registry.ts";

export interface Palette {
  readonly accent: string;
  readonly tone: Readonly<Record<Tone, string>>;
  readonly series: readonly string[];
  readonly stroke: string;
  readonly fallback: boolean;
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const fallbackRamp = {
  dark: {
    fg: "#c0caf5",
    accent: "#7aa2f7",
    success: "#9ece6a",
    danger: "#f7768e",
    warning: "#e0af68",
    info: "#7dcfff",
    series: [
      "#7aa2f7",
      "#9ece6a",
      "#f7768e",
      "#e0af68",
      "#bb9af7",
      "#7dcfff",
      "#ff9e64",
      "#73daca",
    ],
  },
  light: {
    fg: "#1f2328",
    accent: "#2f6fdd",
    success: "#2e8b57",
    danger: "#d1383d",
    warning: "#b8860b",
    info: "#1f7ac0",
    series: [
      "#2f6fdd",
      "#2e8b57",
      "#d1383d",
      "#b8860b",
      "#7a4bd6",
      "#1f7ac0",
      "#d9711c",
      "#1a9c8f",
    ],
  },
} as const;

const chartKeys = [
  "charts.blue",
  "charts.green",
  "charts.red",
  "charts.yellow",
  "charts.orange",
  "charts.purple",
] as const;

const tokenScopes = ["keyword", "string", "entity.name.function", "constant.numeric", "variable"];

const maxSeries = 8;
const minHueDistance = 25;

export function parseHex(color: string): Rgb | null {
  const hex = color.trim().replace(/^#/, "");
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const digits =
    hex.length === 3 || hex.length === 4
      ? hex
          .slice(0, 3)
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex.length === 6 || hex.length === 8
        ? hex.slice(0, 6)
        : null;
  if (digits === null) return null;
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

export function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color);
  if (rgb === null) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

export function hueOf(color: string): number | null {
  const rgb = parseHex(color);
  if (rgb === null) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  // Near-gray colors have no meaningful hue and vanish on a chart.
  if (delta < 0.08 || max === 0) return null;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

function firstColor(
  colors: Readonly<Record<string, string>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = colors[key];
    if (value !== undefined && parseHex(value) !== null) return value;
  }
  return null;
}

function scopeMatches(scope: string | readonly string[] | undefined, wanted: string): boolean {
  if (scope === undefined) return false;
  const list = typeof scope === "string" ? scope.split(",").map((part) => part.trim()) : scope;
  return list.some((entry) => entry === wanted || entry.startsWith(`${wanted}.`));
}

function tokenColor(
  rules: PluginCodeThemeState["theme"] extends infer T
    ? T extends { tokenColors: infer R }
      ? R
      : never
    : never,
  scope: string,
): string | null {
  for (const rule of rules) {
    const foreground = rule.settings.foreground;
    if (foreground === undefined || parseHex(foreground) === null) continue;
    if (scopeMatches(rule.scope, scope)) return foreground;
  }
  return null;
}

function dedupeByHue(candidates: readonly string[]): string[] {
  const kept: { color: string; hue: number }[] = [];
  for (const color of candidates) {
    const hue = hueOf(color);
    if (hue === null) continue;
    if (kept.every((entry) => hueDistance(entry.hue, hue) > minHueDistance)) {
      kept.push({ color, hue });
    }
    if (kept.length >= maxSeries) break;
  }
  return kept.map((entry) => entry.color);
}

function fallbackPalette(mode: "dark" | "light"): Palette {
  const ramp = fallbackRamp[mode];
  return {
    accent: ramp.accent,
    tone: {
      neutral: withAlpha(ramp.fg, 0.6),
      info: ramp.info,
      success: ramp.success,
      warning: ramp.warning,
      danger: ramp.danger,
    },
    series: [...ramp.series],
    stroke: withAlpha(ramp.fg, 0.15),
    fallback: true,
  };
}

export function derivePalette(state: PluginCodeThemeState): Palette {
  const { theme, mode } = state;
  if (theme === null) return fallbackPalette(mode);
  const ramp = fallbackRamp[theme.type];
  const colors = theme.colors;
  const accent =
    firstColor(colors, ["focusBorder", "textLink.foreground", "button.background"]) ?? ramp.accent;
  const success =
    firstColor(colors, ["charts.green", "gitDecoration.addedResourceForeground"]) ?? ramp.success;
  const danger = firstColor(colors, ["charts.red", "errorForeground"]) ?? ramp.danger;
  const warning = firstColor(colors, ["charts.yellow", "editorWarning.foreground"]) ?? ramp.warning;
  const info = firstColor(colors, ["charts.blue"]) ?? accent;
  const fg = parseHex(theme.fg) === null ? ramp.fg : theme.fg;

  const candidates: string[] = [];
  for (const key of chartKeys) {
    const value = colors[key];
    if (value !== undefined) candidates.push(value);
  }
  for (const scope of tokenScopes) {
    const value = tokenColor(theme.tokenColors, scope);
    if (value !== null) candidates.push(value);
  }
  let series = dedupeByHue(candidates);
  // A two-series chart needs at least two distinct colors even on a sparse theme.
  if (series.length < 3) series = dedupeByHue([...series, ...ramp.series]);

  return {
    accent,
    tone: { neutral: withAlpha(fg, 0.6), info, success, warning, danger },
    series,
    stroke: withAlpha(fg, 0.15),
    fallback: false,
  };
}
