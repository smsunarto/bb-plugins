import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accessSchema, inspectionSchema, powerResultSchema, targetSchema } from "./schema.ts";

const base = z.object({ target: targetSchema, access: accessSchema });
export const hostContract = defineRpcContract({
  inspect: { input: base.strict(), output: inspectionSchema, experimental_retryable: true },
  power: {
    input: base.extend({ action: z.enum(["start", "stop"]), requestId: z.uuid() }).strict(),
    output: powerResultSchema,
  },
  bootstrap: {
    input: base
      .extend({
        command: z.array(z.string().max(65536)).min(1).max(64),
        stdin: z.string().max(1024 * 1024),
        timeoutMs: z
          .number()
          .int()
          .min(1)
          .max(15 * 60_000),
      })
      .strict(),
    output: z.object({ exitCode: z.number().int(), output: z.string() }).strict(),
  },
});
