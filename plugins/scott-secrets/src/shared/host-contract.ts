import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { sudoRunResultSchema } from "./schema.ts";

/**
 * Host methods: the sudo password cache lives in the host worker on the
 * machine that runs sudo, one entry per thread.
 */
const threadId = z.string().min(1);

export const hostContract = defineRpcContract({
  sudoRun: {
    input: z.object({
      threadId,
      argv: z.array(z.string()).min(1),
      cwd: z.string().min(1),
      /** Present only right after the user typed it; otherwise the cache is used. */
      password: z.string().optional(),
      cacheMs: z.number().int().positive(),
      timeoutMs: z.number().int().positive(),
    }),
    output: sudoRunResultSchema,
  },
  sudoForget: {
    input: z.object({ threadId }),
    output: z.object({ forgotten: z.boolean() }),
  },
});
