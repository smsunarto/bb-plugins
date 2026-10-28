// Zod-free facts shared by the server, the app bundle, and the tests.

export const PROVIDER_ID = "boat-sandbox";

/** Boat machine sizes, in the order the composer chip lists them. */
export const SANDBOX_TYPES = ["small", "default", "large", "xlarge"] as const;
export type SandboxType = (typeof SANDBOX_TYPES)[number];

/**
 * Every state Boat reports for a sandbox, collapsed to the lifecycle this
 * plugin acts on. The API calls a stopped sandbox `archived`; `cancelled` is a
 * create that never got a machine and is about to answer 404.
 */
export const SANDBOX_PHASES = {
  init: "starting",
  provisioning: "starting",
  provisioned: "starting",
  cloning: "starting",
  ready: "running",
  idle: "running",
  running: "running",
  archiving: "stopping",
  archived: "stopped",
  error: "error",
  cancelled: "gone",
} as const;
export type SandboxState = keyof typeof SANDBOX_PHASES;
export type SandboxPhase = (typeof SANDBOX_PHASES)[SandboxState];
export const SANDBOX_STATES = Object.keys(SANDBOX_PHASES) as [SandboxState, ...SandboxState[]];

export function phaseOf(state: SandboxState): SandboxPhase {
  return SANDBOX_PHASES[state];
}

/** The label every sandbox this plugin creates carries; cleanup finds allocations by it. */
export const MACHINE_KEY_LABEL = "bbMachineKey";

export const SAVED_SNAPSHOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
