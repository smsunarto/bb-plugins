import type { Rect, Viewport, XYPosition } from "@xyflow/react";

/** Keep new cards near the current view, offsetting repeated additions. */
export function newNodePosition(center: XYPosition, nodes: { position: XYPosition }[]): XYPosition {
  const position = { x: center.x - 140, y: center.y - 90 };
  while (
    nodes.some(
      (node) =>
        Math.abs(node.position.x - position.x) < 24 && Math.abs(node.position.y - position.y) < 24,
    )
  ) {
    position.x += 32;
    position.y += 32;
  }
  return position;
}

/** Reveal an inspected card without changing the user's zoom. */
export function revealNode(
  view: Viewport,
  size: { width: number; height: number },
  node: Rect,
): Viewport {
  const reveal = (
    offset: number,
    start: number,
    length: number,
    available: number,
    before: number,
    after: number,
  ) => {
    const leading = before - start * view.zoom;
    if (length * view.zoom > available - before - after) return leading;
    return Math.max(leading, Math.min(offset, available - after - (start + length) * view.zoom));
  };
  return {
    x: reveal(view.x, node.x, node.width, size.width, 20, 20),
    y: reveal(view.y, node.y, node.height, size.height, 60, 88),
    zoom: view.zoom,
  };
}
