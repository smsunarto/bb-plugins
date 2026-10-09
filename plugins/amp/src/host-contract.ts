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
  trace: z.array(
    z.object({
      id: z.string(),
      toolCallId: z.string().nullable(),
      kind: z.enum(["thinking", "message", "tool"]),
      title: z.string(),
      content: z.string().nullable(),
      status: statusSchema.nullable(),
      createdAt: z.string(),
    }),
  ),
  createdAt: z.string(),
});

export const ampHostContract = defineRpcContract({
  oracleReport: {
    input: z.object({ reportId: z.string().uuid() }).strict(),
    output: z.object({ report: oracleReportSchema.nullable() }).strict(),
  },
  cliStatus: {
    input: z.object({}).strict(),
    output: z.object({ path: z.string().nullable() }).strict(),
  },
});
