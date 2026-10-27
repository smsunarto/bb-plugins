// Feedback mode belongs to this window; the toolbar visibility preference is
// persisted separately on the server.
let active = false;
const listeners = new Set<() => void>();
export const FEEDBACK_MODE_LABEL = "Toggle Agentation feedback mode";

export function feedbackModeLauncher(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`button[aria-label="${FEEDBACK_MODE_LABEL}"]`);
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
