const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export function hasOpenOverlay(): boolean {
  for (const overlay of document.querySelectorAll(OVERLAYS)) {
    // BB keeps closed phone drawers mounted, including their dialog roles.
    if (!overlay.closest('[inert], [hidden], [aria-hidden="true"], [data-state="closed"]'))
      return true;
  }
  return false;
}
