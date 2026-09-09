/**
 * User-approved DOM integration for BB 0.42.1. Only inspect row identifiers.
 * The owned node is a sibling of message content, outside selectable prose,
 * message actions, and the composer. Never serialize or modify host text.
 */
export function mountDiffPortal(
  scope: ParentNode,
  anchorId: string,
  onTarget: (target: HTMLElement) => void,
): () => void {
  const document = scope instanceof Document ? scope : scope.ownerDocument;
  if (!document) return () => {};
  const target = document.createElement("div");
  target.dataset.lastTurnDiffPortal = "";
  const attach = () => {
    const row = Array.from(scope.querySelectorAll<HTMLElement>("[data-timeline-row-id]")).find(
      (element) => element.dataset.timelineRowId === anchorId,
    );
    if (row) {
      // Append to the row wrapper, never to the assistant's markdown element.
      if (target.parentElement !== row) row.append(target);
    } else target.remove();
  };
  const observer = new MutationObserver(attach);
  observer.observe(scope, { childList: true, subtree: true });
  attach();
  onTarget(target);
  return () => {
    observer.disconnect();
    target.remove();
  };
}
