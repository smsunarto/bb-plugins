import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { approvalGrantSchema, gameInput } from "../../shared/schema.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const generationGrant = defineMutation({
  input: gameInput.extend({ enabled: z.boolean(), threadId: z.string().nullable() }).strict(),
  output: z.strictObject({ grant: approvalGrantSchema.nullable() }),
  description:
    "Approve a game's agent generations in advance until bb restarts, or go back to asking each time.",
  execute: (ctx: GenerationContext, input) => ({
    grant: ctx.generations.setGrant(
      input.gameId,
      input.enabled ? { threadId: input.threadId, at: Date.now() } : null,
    ),
  }),
});
