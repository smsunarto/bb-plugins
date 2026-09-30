/** Stable provider id. Threads persist it, so it never changes. */
export const DEVIN_PROVIDER_ID = "devin";

/** Where a Devin thread runs. Fixed at the thread's first command. */
export type DevinTarget = "local" | "cloud";

/** What the thread banner shows for a Devin Cloud thread. */
export type CloudSessionView =
  | Readonly<{ state: "hidden" }>
  | Readonly<{ state: "starting" }>
  | Readonly<{ state: "active"; sessionId: string; url: string; attachCommand: string }>;

/** `devin acp --cloud` names sessions `devin-<hex>`; the web app keys them by
 *  the bare hex. */
export function cloudSessionView(sessionId: string): CloudSessionView {
  return {
    state: "active",
    sessionId,
    url: `https://app.devin.ai/sessions/${sessionId.replace(/^devin-/, "")}`,
    attachCommand: `devin --cloud -r ${sessionId}`,
  };
}
