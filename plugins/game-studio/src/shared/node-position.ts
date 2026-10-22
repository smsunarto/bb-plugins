/** Find an open spot near the view, keeping existing cards in place. */
export function newNodePosition(
  center: { x: number; y: number },
  nodes: { position: { x: number; y: number }; measured?: { width?: number; height?: number } }[],
): { x: number; y: number } {
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
  const distance = (position: { x: number; y: number }) =>
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
