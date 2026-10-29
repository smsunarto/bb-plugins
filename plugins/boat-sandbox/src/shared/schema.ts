import { z } from "zod";
import {
  SANDBOX_STATES,
  SANDBOX_TYPES,
  SAVED_SNAPSHOT_NAME_PATTERN,
  type SandboxPhase,
  type SandboxState,
} from "./constants.ts";

export const sandboxTypeSchema = z.enum(SANDBOX_TYPES);
export const sandboxStateSchema = z.enum(SANDBOX_STATES);
export const savedSnapshotNameSchema = z
  .string()
  .trim()
  .regex(
    SAVED_SNAPSHOT_NAME_PATTERN,
    "Saved snapshot names are lowercase letters, digits and dashes",
  );

/** Per-machine choices; persisted on the launch and readable by every plugin, so never secret. */
export const machineInputsSchema = z
  .object({
    type: sandboxTypeSchema.optional(),
    from: savedSnapshotNameSchema.optional(),
  })
  .strict();
export type MachineInputs = z.infer<typeof machineInputsSchema>;

/** What core persists for a machine. Boat keeps the sandbox id across stop and resume, so it is the whole identity. */
export const machineResourceSchema = z.object({
  key: z.string().min(1),
  sandboxId: z.string().min(1),
  /** SHA-256 of the Boat account id the sandbox belongs to; lifecycle refuses another account. */
  accountIdentity: z.string().min(1),
  type: sandboxTypeSchema,
  from: savedSnapshotNameSchema.nullable(),
  environment: z.string().min(1).nullable(),
});
export type MachineResource = z.infer<typeof machineResourceSchema>;
export function readMachineResource(value: unknown): MachineResource {
  return machineResourceSchema.parse(value);
}

export const connectionStatusSchema = z.object({
  available: z.boolean(),
  message: z.string(),
});
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/** Phases Boat still reports a sandbox in; `gone` is answered as `missing` instead. */
const LIVE_PHASES = [
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
] as const satisfies readonly Exclude<SandboxPhase, "gone">[];

/** Boat's view of a machine. A sandbox deleted outside bb has nothing to report beyond its id. */
export const machineInspectionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing"), sandboxId: z.string(), summary: z.string() }),
  z.object({
    state: z.enum(LIVE_PHASES),
    sandboxId: z.string(),
    type: sandboxTypeSchema,
    /** Boat's auto-stop deadline as epoch milliseconds, or null when auto-stop is off. */
    archiveAfter: z.number().nullable(),
    hydrated: z.boolean().nullable(),
    /** True once Boat deleted the stopped sandbox's disk; it can no longer resume. */
    dataExpired: z.boolean(),
    /** Boat's reason when `state` is `error`. */
    error: z.string().nullable(),
    summary: z.string(),
  }),
]);
export type MachineInspection = z.infer<typeof machineInspectionSchema>;

export const launchOptionsSchema = z.object({
  defaultType: sandboxTypeSchema,
  types: z.array(
    z.object({
      type: sandboxTypeSchema,
      available: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  /** Ready saved snapshots a new sandbox may start from. */
  snapshots: z.array(z.string()),
});
export type LaunchOptions = z.infer<typeof launchOptionsSchema>;

export type { SandboxState };
