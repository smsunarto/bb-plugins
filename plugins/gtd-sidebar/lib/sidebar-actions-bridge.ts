// The palette row is registered at app definition time, outside React, while
// bb's archive action and the list's advance only exist inside a mounted
// inbox. The mounted list publishes its settle and New Captain actions here so
// the palette and navigation drive the same mounted inbox.
import { useSyncExternalStore } from "react";

export interface PublishedSidebarActions {
  settle(threadId: string): void;
  /** False for a thread that stays open (lib/long-lived). */
  canSettle(threadId: string): boolean;
  /** Opens the New Captain dialog hosted by the mounted inbox. */
  openNewCaptain(): void;
}

let current: PublishedSidebarActions | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function publishSidebarActions(published: PublishedSidebarActions): void {
  current = published;
  notify();
}

export function forgetSidebarActions(published: PublishedSidebarActions): void {
  if (current === published) {
    current = null;
    notify();
  }
}

export function hasSidebarActions(): boolean {
  return current !== null;
}

export function canSettleThread(threadId: string): boolean {
  return current?.canSettle(threadId) ?? false;
}

export function settleThread(threadId: string): void {
  current?.settle(threadId);
}

export function openNewCaptain(): void {
  current?.openNewCaptain();
}

const subscribeBridge = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Whether a mounted inbox has published its actions (`settle`, `openNewCaptain`). */
export function useHasSidebarActions(): boolean {
  return useSyncExternalStore(subscribeBridge, hasSidebarActions, hasSidebarActions);
}

// The palette row still asks for archiveThread; a settle is an archive plus
// advancing to the next visible row.
export const archiveThread = settleThread;
