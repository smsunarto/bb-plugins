// Shared by server.ts and host.ts: the one question the server asks each
// machine, "what are you and how busy are you right now?".
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const machineStatsSchema = z
  .object({
    platform: z.string(),
    arch: z.string(),
    osRelease: z.string(),
    cpuCount: z.number(),
    loadAverage1m: z.number().nullable(),
    memoryTotalBytes: z.number(),
    memoryFreeBytes: z.number(),
    diskTotalBytes: z.number().nullable(),
    diskFreeBytes: z.number().nullable(),
  })
  .strict();

export const hostContract = defineRpcContract({
  stats: {
    input: z.null(),
    output: machineStatsSchema,
  },
});
