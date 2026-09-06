import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { shareIdSchema } from "./schema.ts";
const status = z.object({ running: z.boolean(), connectorId: z.string().optional() }).strict();
export const cloudflareHostContract = defineRpcContract({
  probe: {
    input: z
      .object({ port: z.number().int().min(1).max(65535), executable: z.string().min(1).max(1024) })
      .strict(),
    output: z
      .object({ available: z.boolean(), originReachable: z.boolean(), message: z.string() })
      .strict(),
  },
  status: { input: z.object({ id: shareIdSchema }).strict(), output: status },
  start: {
    input: z
      .object({
        id: shareIdSchema,
        token: z.string().min(1),
        executable: z.string().min(1).max(1024),
      })
      .strict(),
    output: status,
  },
  stop: { input: z.object({ id: shareIdSchema }).strict(), output: status },
});
