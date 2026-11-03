/**
 * Dense list rows do not transition their highlight, so it tracks the pointer
 * and the arrow keys exactly with no lag during fast navigation. This mirrors
 * `LIST_HOVER_TRANSITION` in the other plugins' `components/ui/motion.ts`; the
 * inbox is the densest, most keyboard-driven list in the product and had been
 * running a 150ms fade instead.
 */
export const LIST_HOVER_TRANSITION = "transition-none";
