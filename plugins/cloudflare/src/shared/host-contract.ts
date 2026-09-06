import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { shareIdSchema } from "./schema.ts";
const executable = z.string().min(1).max(1024);
const port = z.number().int().min(1).max(65535);
const status = z
  .object({
    running: z.boolean(),
    connectorId: z.string().optional(),
    // Present only for quick tunnels once cloudflared reports the assigned hostname.
    url: z.url().optional(),
  })
  .strict();
export const cloudflareHostContract = defineRpcContract({
  probe: {
    input: z.object({ port, executable }).strict(),
    output: z
      .object({ available: z.boolean(), originReachable: z.boolean(), message: z.string() })
      .strict(),
  },
  status: { input: z.object({ id: shareIdSchema }).strict(), output: status },
  start: {
    input: z.object({ id: shareIdSchema, token: z.string().min(1), executable }).strict(),
    output: status,
  },
  startQuick: {
    input: z.object({ id: shareIdSchema, port, executable }).strict(),
    output: status,
  },
  stop: { input: z.object({ id: shareIdSchema }).strict(), output: status },
});
