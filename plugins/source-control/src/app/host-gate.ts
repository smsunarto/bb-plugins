/**
 * The one gate for writes that run on the checkout's host. Plan §3: with the
 * host offline, or no checkout to write to, each is disabled with the reason;
 * forge writes (Mark ready, Merge) stay enabled while a site is connected.
 *
 * Controls read the reason from `HostGate`, and `useVcsActions` refuses to
 * send while there is one, so a control that forgets to read it still
 * cannot write. The context defaults to "no checkout": a host-bound control
 * drawn anywhere the tab has not opened the gate is off.
 */
import { createContext, useContext } from "react";
import type { VcsAction } from "../core/change.ts";

/** Every host-bound write, as the reader names it. A new action must be listed here to compile. */
export const HOST_BOUND = {
  pull: "pull",
  commit: "commit",
  push: "push",
  land: "land",
  rename: "rename",
  delete: "delete",
  createPullRequest: "Create PR",
} as const satisfies Record<VcsAction["kind"] | "createPullRequest", string>;
export type HostBound = keyof typeof HOST_BOUND;

export const NO_CHECKOUT = "There is no checkout here to write to.";

const names = Object.values(HOST_BOUND);
const listed = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** "studio-mac is offline. Pull, commit, push, land, rename, delete and Create PR need it." */
export function offlineReason(host: string): string {
  return `${host} is offline. ${listed[0]!.toUpperCase()}${listed.slice(1)} need it.`;
}

/** Why host-bound writes are off here, or null when they may run. */
export const HostGate = createContext<string | null>(NO_CHECKOUT);

export const useHostGate = () => useContext(HostGate);
