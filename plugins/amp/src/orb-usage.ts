import type { AmpThreadLinkState } from "../lib/declaration.ts";

/** What the composer banner renders. The server derives it from the thread's
 *  latest `amp/thread-link` extension state. `hidden` never shows: another
 *  provider's thread, or an Amp thread that runs locally. `unlinked` is an
 *  Amp thread whose bridge has not published its link yet. */
export type OrbUsageView =
  | Readonly<{ state: "hidden" }>
  | Readonly<{ state: "unlinked" }>
  | Readonly<{ state: "starting" }>
  | Readonly<{
      state: "active";
      ampThreadId: string;
      syncCommand: string;
    }>;

/** True once no later thread event can change the view. A thread's provider
 *  and executor are fixed at creation, and its Amp thread id once revealed. */
export function orbUsageSettled(view: OrbUsageView): boolean {
  return view.state === "hidden" || view.state === "active";
}

/** Map the persisted thread-link state to the banner view. Local execution
 *  hides the banner; an orb run that has not revealed its Amp thread id yet
 *  is starting. The emitted `syncCommand` wins; the rebuild only covers a
 *  state written without one. */
export function threadLinkToOrbUsageView(link: AmpThreadLinkState): OrbUsageView {
  if (link.executionTarget !== "orb") return { state: "hidden" };
  if (link.ampThreadId === null) return { state: "starting" };
  return {
    state: "active",
    ampThreadId: link.ampThreadId,
    syncCommand: link.syncCommand ?? `amp sync ${link.ampThreadId}`,
  };
}
