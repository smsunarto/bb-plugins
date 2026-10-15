import type { Rect, Viewport, XYPosition } from "@xyflow/react";

/** Find an open spot near the view, keeping existing cards in place. */
export function newNodePosition(
  center: XYPosition,
  nodes: { position: XYPosition; measured?: { width?: number; height?: number } }[],
): XYPosition {
  // Reserve enough space for an expanded document before the new card is measured.
  const width = 280;
  const height = 300;
  const gap = 40;
  const origin = { x: center.x - width / 2, y: center.y - height / 2 };
  const occupied = nodes.map((node) => ({
    ...node.position,
    width: node.measured?.width ?? width,
    height: node.measured?.height ?? height,
  }));
  const candidates = [
    origin,
    ...occupied.flatMap((node) => [
      { x: node.x + node.width + gap, y: node.y },
      { x: node.x, y: node.y + node.height + gap },
      { x: node.x - width - gap, y: node.y },
      { x: node.x, y: node.y - height - gap },
    ]),
  ];
  const distance = (position: XYPosition) =>
    (position.x - origin.x) ** 2 + (position.y - origin.y) ** 2;
  candidates.sort((a, b) => distance(a) - distance(b));
  // The spot to the right of the rightmost card is always free.
  return candidates.find((position) =>
    occupied.every(
      (node) =>
        position.x + width + gap <= node.x ||
        position.x >= node.x + node.width + gap ||
        position.y + height + gap <= node.y ||
        position.y >= node.y + node.height + gap,
    ),
  )!;
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
