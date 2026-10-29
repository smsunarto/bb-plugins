/**
 * `src/host-contract.ts` — what the plugin server asks the Amp host entry
 * (`host.ts`), which runs on every host daemon. The provider bridge writes
 * Oracle reports and finds the Amp CLI on the thread's host, so the server
 * asks that host instead of reading its own disk.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const statusSchema = z.enum(["running", "completed", "error"]);

export const oracleReportSchema = z.object({
  id: z.string(),
  request: z.string().nullable(),
  response: z.string(),
  status: statusSchema,
  createdAt: z.string(),
});

export const ampHostContract = defineRpcContract({
  oracleReport: {
    experimental_retryable: true,
    input: z.object({ reportId: z.string().uuid() }).strict(),
    output: z.object({ report: oracleReportSchema.nullable() }).strict(),
  },
  cliStatus: {
    experimental_retryable: true,
    input: z.object({}).strict(),
    output: z.object({ path: z.string().nullable() }).strict(),
  },
});
