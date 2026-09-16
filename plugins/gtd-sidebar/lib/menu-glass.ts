import type { GlassOptics } from "@samasante/liquid-glass";

/**
 * The look both thread menus share, after liquid-glass's `GlassContextMenu`
 * example: a milky veil, a backdrop blur, and a gentle rim bend, no bevel.
 * Material mode bends the live sidebar behind the menu in Chromium (bb
 * desktop); Safari and Firefox keep the frost, tint, and edge light.
 *
 * `frost` is the backdrop blur in px. 16px, not 24px: the compact sheet is
 * re-sampled every frame of its 280ms rise and blur over ~20px gets expensive
 * under transition, worst on mobile Safari.
 *
 * `specular`, `sheen` and `glow` are off. The DOM `<Glass>` hardcodes a 1px
 * top-only highlight at 0.55 × specular and the lens sheen pools toward one
 * angle, so any value lit the top edge and left the sides dark, and the item
 * inset read uneven. The menus draw their own uniform 1px ring instead.
 */
export const MENU_GLASS = {
  frost: 16,
  saturate: 1.8,
  depth: 0.65,
  curvature: 0.26,
  dispersion: 0.16,
  strength: 0.05,
  bend: 0.65,
  bendWidth: 0.07,
  specular: 0,
  sheen: 0,
  glow: 0,
} satisfies Partial<GlassOptics>;
