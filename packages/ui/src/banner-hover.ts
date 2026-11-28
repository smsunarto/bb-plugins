/**
 * Canonical prompt-stack banner hover values shared by `@bb-plugins/ui`'s
 * `surface.bannerHover` class (`controls.css`) and `t3-composer`'s core
 * prompt-stack toggle stylesheet. Keyed on bb's `.dark` class, never OS media.
 */
export const BANNER_HOVER = {
  lightBg: "var(--background)",
  darkBg: "var(--state-hover)",
  lightShadow:
    "inset 0 0 0 var(--t3-composer-ring-width, var(--hairline-width, 1px)) var(--border)",
  darkShadow: "none",
  lightBorder: "var(--input)",
  lightPrimaryBg: "color-mix(in oklab, var(--foreground) 88%, var(--background))",
  darkPrimaryBg: "color-mix(in oklab, var(--foreground) 55%, white)",
} as const;
