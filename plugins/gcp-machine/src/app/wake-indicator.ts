import { createElement, useSyncExternalStore } from "react";
import { experimental_Icon } from "@get-bb/plugin-sdk/app";
import type { MachineIndicator } from "../shared/wake-contract.ts";

/** One icon state per app generation; no cross-window or DOM ownership. */
export function createWakeIndicator() {
  let state: MachineIndicator = "offline";
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const snapshot = () => state;
  function WakeIcon({ className }: { className?: string }) {
    const current = useSyncExternalStore(subscribe, snapshot, snapshot);
    const color =
      current === "awake" ? "var(--success)" : current === "waking" ? "var(--warning)" : "inherit";
    return createElement(
      "span",
      {
        className,
        "data-gcp-state": current,
        title: `GCP machine: ${current}`,
        style: { color, display: "inline-flex" },
      },
      createElement(experimental_Icon, { name: "ComputerCloud", className: "size-full" }),
    );
  }
  return {
    Icon: WakeIcon,
    set(next: MachineIndicator) {
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}
