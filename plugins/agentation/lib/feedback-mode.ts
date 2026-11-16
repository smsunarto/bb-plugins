// Feedback mode belongs to this window; the toolbar visibility preference is
// persisted separately on the server.
let active = false;
const listeners = new Set<() => void>();
export const FEEDBACK_MODE_LABEL = "Toggle Agentation";

/**
 * The vendored toolbar's own toggle, Mod+Shift+F (it accepts Meta or Control
 * on every platform), in bb's macOS key symbols on every platform.
 */
export function feedbackModeShortcutLabel(platform: string): string {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⇧ ⌘ F" : "⌃ ⇧ F";
}

/** The footer button's tooltip and accessible label: the action and its shortcut. */
export function feedbackModeLauncherLabel(platform: string): string {
  return `${FEEDBACK_MODE_LABEL} (${feedbackModeShortcutLabel(platform)})`;
}

export function feedbackModeLauncher(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`button[aria-label^="${FEEDBACK_MODE_LABEL}"]`);
}

export function feedbackModeSnapshot() {
  return active;
}

export function setFeedbackModeActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener();
}

export function activateFeedbackMode(): void {
  setFeedbackModeActive(true);
}

export function subscribeFeedbackMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
