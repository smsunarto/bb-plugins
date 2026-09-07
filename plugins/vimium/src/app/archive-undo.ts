// BB 0.41–0.42 expose archive restoration and navigation only through these
// toast controls. Keep core responsible for restoring the thread and children.
const TOAST_SELECTOR = "[data-sonner-toast].bb-app-toast";

function archiveControls(toast: Element) {
  const content = toast.querySelector(":scope > div > div > div:nth-child(2)");
  if (content?.firstElementChild?.textContent?.trim() !== "Thread Archived") return null;
  const details = content.children[1];
  const open = details?.querySelector<HTMLButtonElement>(":scope > div button[title]");
  const undo = [...(details?.children ?? [])].find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement && element.textContent?.trim() === "Undo",
  );
  return open && undo && !undo.disabled ? { open, undo } : null;
}

export function mountArchiveUndo() {
  const consumed = new WeakSet<Element>();

  function onClick(event: MouseEvent): void {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    const toast = button?.closest(TOAST_SELECTOR);
    if (!toast || consumed.has(toast) || event.defaultPrevented) return;
    const controls = archiveControls(toast);
    if (!controls || button !== controls.undo) return;
    consumed.add(toast);
    // Bubble after React has run Undo. The same toast's title button owns the
    // exact thread route, including its project, and stays mounted during exit.
    controls.open.click();
  }

  document.addEventListener("click", onClick);
  return {
    undoLatest(): boolean {
      // Sonner renders newest first. Ignore notifications already leaving.
      for (const toast of document.querySelectorAll(TOAST_SELECTOR)) {
        if (consumed.has(toast) || toast.getAttribute("data-removed") === "true") continue;
        const controls = archiveControls(toast);
        if (!controls) continue;
        controls.undo.click();
        return true;
      }
      return false;
    },
    dispose(): void {
      document.removeEventListener("click", onClick);
    },
  };
}
