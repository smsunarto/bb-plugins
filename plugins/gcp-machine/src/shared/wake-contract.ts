import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

export const machineIndicatorSchema = z.enum(["awake", "waking", "offline"]);
export type MachineIndicator = z.infer<typeof machineIndicatorSchema>;

const attempt = z.number().int().min(1).max(3);
export const wakeStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("waking"), attempt }),
  z.object({ kind: z.literal("retrying"), attempt, retryAt: z.number(), error: z.string() }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
  z.object({ kind: z.literal("unknown"), error: z.string() }),
]);
export type WakeState = z.infer<typeof wakeStateSchema>;
export const wakeSnapshotSchema = z.object({ jobId: z.string(), state: wakeStateSchema });
export const wakeContract = defineRpcContract({
  getIndicator: { input: z.null(), output: machineIndicatorSchema },
  startWake: {
    input: z.object({ requestId: z.string().min(1).max(128), requestedAt: z.number().finite() }),
    output: wakeSnapshotSchema,
  },
  getWake: { input: z.object({ jobId: z.string() }), output: wakeStateSchema },
});
