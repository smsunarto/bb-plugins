import { create } from "storybook/theming/create";
import type { PluginCodeThemeState } from "@get-bb/plugin-sdk";
import codeTheme from "../plugins/monokai/themes/bb-monokai-code.json";

export const monokaiCodeTheme = {
  mode: "dark",
  name: "bb-monokai",
  theme: {
    ...codeTheme,
    name: "bb-monokai",
    type: "dark",
    bg: codeTheme.colors["editor.background"],
    fg: codeTheme.colors["editor.foreground"],
  },
} satisfies PluginCodeThemeState;

/** Read the same installed stylesheet that paints previews, rather than copy its palette. */
export function monokaiStorybookTheme() {
  document.documentElement.classList.add("dark");
  document.documentElement.style.colorScheme = "dark";
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => {
    const value = css.getPropertyValue(`--${name}`).trim();
    if (!value) throw new Error(`Missing Monokai token: ${name}`);
    return value;
  };
  return create({
    base: "dark",
    brandTitle: "bb · Component Library",
    colorPrimary: token("primary"),
    colorSecondary: token("primary"),
    appBg: token("background"),
    appContentBg: token("background"),
    appPreviewBg: token("background"),
    appBorderColor: token("border"),
    textColor: token("foreground"),
    textInverseColor: token("primary-foreground"),
    barTextColor: token("muted-foreground"),
    barHoverColor: token("foreground"),
    barSelectedColor: token("primary"),
    barBg: token("sidebar"),
    buttonBg: token("secondary"),
    buttonBorder: token("border"),
    booleanBg: token("muted"),
    booleanSelectedBg: token("primary"),
    inputBg: token("secondary"),
    inputBorder: token("border"),
    inputTextColor: token("foreground"),
    fontBase: css.getPropertyValue("--font-sans").trim(),
    fontCode: css.getPropertyValue("--font-mono").trim(),
  });
}
