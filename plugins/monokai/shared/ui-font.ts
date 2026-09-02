export const UI_FONT_OPTIONS = ["Inter (Default)", "SF Pro"] as const;

export type UiFont = (typeof UI_FONT_OPTIONS)[number];

export const DEFAULT_UI_FONT: UiFont = "Inter (Default)";

export const UI_FONT_STACKS: Record<UiFont, string> = {
  "Inter (Default)": '"Inter Variable", Inter, sans-serif',
  "SF Pro": '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", sans-serif',
};

export function normalizeUiFont(value: string): UiFont {
  return value === "SF Pro" ? value : DEFAULT_UI_FONT;
}
