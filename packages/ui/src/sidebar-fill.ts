import { useEffect, type RefObject } from "react";

/**
 * workaround:scott-docs/sidebar-fill (manual removal; see workarounds.json)
 *
 * bb mounts a navPanel's `experimental_sidebar` in an auto-height block inside
 * its scrolling `[data-sidebar="content"]` column and offers no fill layout, so
 * a sidebar whose content sizes itself with `flex-1 min-h-0` collapses to 0px.
 * This sizes the plugin's own root to the column instead, leaving bb's DOM
 * untouched: root height = column height − (the column's child block − root),
 * which keeps anything bb draws above or below the root (a title, padding).
 *
 * Sizes come only from ResizeObserver entries; the one style write happens in
 * an animation frame, so a resize never re-enters the observer in the same pass.
 */
export function mountSidebarColumnFill(root: HTMLElement): () => void {
  const view = root.ownerDocument.defaultView;
  const column = root.closest<HTMLElement>('[data-sidebar="content"]');
  if (!view?.ResizeObserver || !column) return () => {};
  let block: HTMLElement = root;
  while (block.parentElement && block.parentElement !== column) block = block.parentElement;
  if (block.parentElement !== column) return () => {};

  const sizes = new Map<Element, number>();
  let frame = 0;
  let written = -1;
  function apply(): void {
    frame = 0;
    const columnHeight = sizes.get(column!);
    const blockHeight = sizes.get(block);
    const rootHeight = sizes.get(root);
    if (columnHeight === undefined || blockHeight === undefined || rootHeight === undefined) return;
    const height = Math.max(0, Math.floor(columnHeight - (blockHeight - rootHeight)));
    if (height === written) return;
    written = height;
    root.style.height = `${height}px`;
  }
  const observer = new view.ResizeObserver((entries) => {
    for (const entry of entries) {
      sizes.set(
        entry.target,
        // The column scrolls: its content box is the visible height.
        entry.target === column
          ? entry.contentRect.height
          : (entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height),
      );
    }
    if (!frame) frame = view.requestAnimationFrame(apply);
  });
  observer.observe(column);
  observer.observe(root);
  if (block !== root) observer.observe(block);
  return () => {
    observer.disconnect();
    if (frame) view.cancelAnimationFrame(frame);
    root.style.removeProperty("height");
  };
}

/** Fill bb's left sidebar column with `ref`'s element while it is mounted and `enabled`. */
export function useSidebarColumnFill(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const root = ref.current;
    return root && enabled ? mountSidebarColumnFill(root) : undefined;
  }, [ref, enabled]);
}
