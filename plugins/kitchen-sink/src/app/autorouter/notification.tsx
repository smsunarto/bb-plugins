import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { AutorouterRoute } from "../../shared/autorouter/contract.ts";
import "./autorouter.css";

type Notification = { title: string; detail: string };
let current: Notification | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => current;
function publish(value: Notification | null) {
  current = value;
  for (const listener of listeners) listener();
}
function dismiss() {
  clearTimeout(timer);
  publish(null);
}

export function notifyAutorouted(route: AutorouterRoute, followup: boolean) {
  clearTimeout(timer);
  publish({
    title: route.usedFallback ? "Autorouted · fallback used" : "Autorouted",
    detail: followup
      ? `${route.modelLabel} · ${route.reasoningLabel} reasoning${route.usedFallback ? " (kept current level)" : ""}`
      : `${route.projectName ? `${route.projectName} · ` : ""}${route.modelLabel} · ${route.reasoningLabel} reasoning`,
  });
  timer = setTimeout(dismiss, 8_000);
}

/** The SDK mounts this overlay once, so notifications survive composer navigation. */
export function AutorouterNotification() {
  const notification = useSyncExternalStore(subscribe, snapshot);
  if (!notification) return null;
  return createPortal(
    <output className="autorouter-notification" aria-live="polite" aria-atomic="true">
      <div>
        <strong>{notification.title}</strong>
        <div>{notification.detail}</div>
      </div>
      <button type="button" aria-label="Dismiss autorouting notification" onClick={dismiss}>
        ×
      </button>
    </output>,
    document.body,
  );
}
