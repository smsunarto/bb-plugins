import { threadLinkStateSchema, type AmpThreadLinkState } from "./thread-link.ts";

/** What the composer banner renders, derived from the thread's latest
 *  `amp/thread-link` extension state. `hidden` never shows: an Amp thread that
 *  runs locally, or a state that fails the schema. `unlinked` is a thread with
 *  no link yet, which is also every other provider's thread: only Amp's
 *  bridge publishes this kind. */
export type OrbUsageView =
  | Readonly<{ state: "hidden" }>
  | Readonly<{ state: "unlinked" }>
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

/** The banner view for whatever `experimental_useThreadExtensionState`
 *  reports. bb validated the payload against the declared schema at ingest;
 *  a miss here means the schemas drifted, and hiding is the safe answer. */
export function orbUsageFromThreadLinkState(state: unknown): OrbUsageView {
  if (state === null || state === undefined) return { state: "unlinked" };
  const link = threadLinkStateSchema.safeParse(state);
  return link.success ? threadLinkToOrbUsageView(link.data) : { state: "hidden" };
}
