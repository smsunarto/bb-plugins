import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { repositoryOutputSchema, threadIdSchema } from "../../shared/domain.ts";
import { readRepository } from "../workflow.ts";

export const repository = defineQuery({
  input: z.object({ threadId: threadIdSchema }).strict(),
  output: repositoryOutputSchema,
  async execute({ bb }, { threadId }) {
    return { repository: await readRepository(bb, threadId) };
  },
});
