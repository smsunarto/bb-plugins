import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { connectionStatusSchema, launchOptionsSchema, machineInspectionSchema } from "./schema.ts";

const empty = z.object({}).strict();

export const boatRpcContract = defineRpcContract({
  "account.inspect": { input: empty, output: connectionStatusSchema },
  "machine.inspect": {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: machineInspectionSchema,
  },
  "launch.options": { input: empty, output: launchOptionsSchema },
});
