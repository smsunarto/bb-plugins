import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  generatedOutput,
  generationId,
  generationJob,
  generationTarget,
  mediaRequest,
} from "./generation.ts";

import { unityHostContract } from "./unity-editor-contract.ts";

const credentials = z.strictObject({
  vertexProject: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)
    .optional(),
  falAccessToken: z.string().optional(),
});
const target = z.strictObject({ rootPath: z.string().min(1), jobId: generationId });
export const studioHostContract = defineRpcContract({
  ...unityHostContract,
  start: {
    input: target.extend({
      threadId: z.string().nullable(),
      origin: generationJob.shape.origin.optional(),
      request: mediaRequest,
      credentials: credentials.optional(),
      target: generationTarget.optional(),
    }),
    output: z.strictObject({ created: z.boolean(), job: generationJob }),
  },
  status: { input: target, output: generationJob },
  reconcileMissing: { input: target, output: z.strictObject({ missing: z.boolean() }) },
  stagedOutputs: { input: target, output: z.array(generatedOutput).max(20) },
  list: {
    input: z.strictObject({ rootPath: z.string() }),
    output: z.array(generationJob).max(100),
  },
  cancel: { input: target, output: generationJob },
  resume: { input: target.extend({ credentials: credentials.optional() }), output: generationJob },
});
