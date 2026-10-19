import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { integrationSchema, preparationResultSchema, commandResultSchema } from "./arena.ts";
const directory = z.string().min(1).max(16000);
const identity = z.object({ runId: z.uuid(), round: z.number().int().min(1).max(3) });
export const hostContract = defineRpcContract({
  snapshot: {
    input: z.object({ runId: z.uuid(), path: directory }).strict(),
    output: z.object({ root: directory, base: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict(),
  },
  prepare: {
    input: identity
      .extend({
        snapshotId: z.uuid(),
        root: directory,
        base: z.string().regex(/^[a-f0-9]{40,64}$/),
        synthesisPath: directory,
      })
      .strict(),
    output: preparationResultSchema,
  },
  integrate: {
    input: identity.extend({ checks: z.array(commandResultSchema).min(1).max(8) }).strict(),
    output: integrationSchema,
  },
  receipt: { input: identity.strict(), output: integrationSchema.nullable() },
});
