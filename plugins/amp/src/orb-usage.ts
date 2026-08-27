import type { AmpThreadLinkState } from "../lib/declaration.ts";

/** What the composer banner renders. The server derives it from the thread's
 *  latest `amp/thread-link` extension state. */
export type OrbUsageView =
  | Readonly<{ state: "hidden" }>
  | Readonly<{ state: "starting" }>
  | Readonly<{
      state: "active";
      ampThreadId: string;
      syncCommand: string;
    }>;

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
