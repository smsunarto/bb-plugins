/**
 * Shared hover-motion heuristic for primitives, so the whole UI speaks one
 * timing language instead of ad-hoc per-component transitions:
 *
 * - CONTROL_HOVER_TRANSITION — interactive controls (buttons, icon buttons):
 *   the hover/active fill snaps IN instantly (0ms) and eases OUT lazily (150ms).
 *   Immediate feedback on the way in, never twitchy on the way out. The trick:
 *   CSS applies the *end state's* transition-duration for each direction, so a
 *   base `duration-150` governs hover-out while `hover:duration-0` makes
 *   hover-in instant.
 * - LIST_HOVER_TRANSITION — dense list/menu rows (menu items, list rows): no
 *   transition at all (instant both ways), so the highlight tracks the pointer
 *   and arrow keys exactly, with no lag during fast navigation.
 * - FLAT_ENTRANCE — surfaces that enter with `animate-in`: keeps the fade
 *   under `prefers-reduced-motion: reduce` and drops the travel.
 *
 * Reach for one of these rather than a bare `transition-colors` on anything with
 * a hover/active state.
 */
export const CONTROL_HOVER_TRANSITION =
  "transition-colors duration-150 hover:duration-0";

export const LIST_HOVER_TRANSITION = "transition-none";

/**
 * Respect `prefers-reduced-motion: reduce` on an entering surface.
 *
 * The `animate-in` keyframes read their distance from `--tw-enter-*` custom
 * properties, so pinning scale to 1 and translate to 0 removes the zoom and
 * the slide while leaving the cross-fade running. That is the setting's
 * intent: the trigger is vestibular motion — travel across the screen — not
 * a change of opacity.
 *
 * Deliberately not `animate-none`. Someone who asks for less motion still
 * needs to see that a surface arrived; teleporting it in is the jarring
 * change the animation was there to prevent. Reduce the motion, keep the
 * bridge.
 */
export const FLAT_ENTRANCE =
  "motion-reduce:[--tw-enter-scale:1]! motion-reduce:[--tw-exit-scale:1]! motion-reduce:[--tw-enter-translate-y:0]! motion-reduce:[--tw-exit-translate-y:0]!";
