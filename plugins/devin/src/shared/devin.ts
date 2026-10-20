/** Stable provider id. Threads persist it, so it never changes. */
export const DEVIN_PROVIDER_ID = "devin";

/** Where a Devin thread runs. Fixed at the thread's first command. */
export type DevinTarget = "local" | "cloud";

/** What the thread banner shows for a Devin Cloud thread. `hidden` is a
 *  thread that never runs on Cloud: another provider, or a Devin thread
 *  pinned to the local agent. `unclaimed` is a Devin thread whose first
 *  command has not yet picked its target. */
export type CloudSessionView =
  | Readonly<{ state: "hidden" }>
  | Readonly<{ state: "unclaimed" }>
  | Readonly<{ state: "starting" }>
  | Readonly<{ state: "active"; sessionId: string; url: string; attachCommand: string }>;

/** True once no later thread event can change the view: the provider and the
 *  target are fixed for the thread's life, and so is its Cloud session. */
export function cloudSessionSettled(view: CloudSessionView): boolean {
  return view.state === "hidden" || view.state === "active";
}

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
