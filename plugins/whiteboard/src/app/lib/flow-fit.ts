/**
 * Viewport math for the vendored flow graph (flow-graph.tsx, an edit row).
 * Upstream fits the whole ELK drawing into a fixed box, so a deep flow lands
 * at 4px text inline and ~7px expanded. Inline, the box grows with the
 * drawing instead. Expanded, the fit stops at a readable floor and follows
 * the selected node.
 */

/** Room around the drawing on every side, in screen px. */
export const FLOW_PADDING = 24;

/** The expanded view never fits below this zoom; it centers the selected node instead. */
export const EXPANDED_ZOOM_FLOOR = 0.85;

/** Expanded, readers can zoom past 1:1 to read small text. */
export const EXPANDED_MAX_ZOOM = 2.5;

/** Past this, an inline figure scrolls with the document instead of growing. */
const INLINE_MAX_HEIGHT = 1400;

type Size = { width: number; height: number };
type Box = { x: number; y: number; w: number; h: number };
export type FlowViewport = { x: number; y: number; zoom: number };

/**
 * The inline frame's height: the drawing's height at the zoom its width
 * allows, between upstream's fixed box (`minHeight`) and 1400px.
 */
export function inlineFlowHeight({
  layoutWidth,
  layoutHeight,
  frameWidth,
  minHeight,
}: {
  layoutWidth: number;
  layoutHeight: number;
  frameWidth: number;
  minHeight: number;
}): number {
  const zoom = Math.min(1, (frameWidth - FLOW_PADDING * 2) / Math.max(1, layoutWidth));
  const natural = layoutHeight * zoom + FLOW_PADDING * 2;
  return Math.min(INLINE_MAX_HEIGHT, Math.max(minHeight, natural));
}

/** Upstream's fit: the whole drawing in the frame, never past 1:1. */
export function fitZoom(layout: Size, frame: Size): number {
  return Math.min(
    1,
    (frame.width - FLOW_PADDING * 2) / Math.max(1, layout.width),
    (frame.height - FLOW_PADDING * 2) / Math.max(1, layout.height),
  );
}

/**
 * The viewport at `zoom`: on each axis where the drawing fits the frame it
 * is centered, as upstream does; where it overflows, `focus` is centered,
 * clamped so the drawing's edge never pulls in past the padding.
 */
export function centerViewport(layout: Size, frame: Size, zoom: number, focus?: Box): FlowViewport {
  const axis = (layoutSize: number, frameSize: number, focusCenter: number | undefined) => {
    const drawn = layoutSize * zoom;
    // 1px of slack: at the fitted zoom the drawing fits exactly, give or take rounding.
    if (focusCenter === undefined || drawn <= frameSize - FLOW_PADDING * 2 + 1)
      return frameSize / 2 - (layoutSize / 2) * zoom;
    const centered = frameSize / 2 - focusCenter * zoom;
    return Math.min(FLOW_PADDING, Math.max(frameSize - FLOW_PADDING - drawn, centered));
  };
  return {
    x: axis(layout.width, frame.width, focus && focus.x + focus.w / 2),
    y: axis(layout.height, frame.height, focus && focus.y + focus.h / 2),
    zoom,
  };
}

/** True when any part of `node` (flow coordinates) is outside the visible frame. */
export function shouldPan(viewport: FlowViewport & Size, node: Box): boolean {
  const left = node.x * viewport.zoom + viewport.x;
  const top = node.y * viewport.zoom + viewport.y;
  return (
    left < 0 ||
    top < 0 ||
    left + node.w * viewport.zoom > viewport.width ||
    top + node.h * viewport.zoom > viewport.height
  );
}
