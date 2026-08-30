import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  commitIntentSchema,
  commitSelectionOutputSchema,
  threadIdSchema,
} from "../../shared/domain.ts";
import { commitRepositorySelection } from "../workflow.ts";

export const commitSelection = defineMutation({
  input: z.object({ threadId: threadIdSchema, intent: commitIntentSchema }).strict(),
  output: commitSelectionOutputSchema,
  async execute({ bb }, { threadId, intent }) {
    return commitRepositorySelection(bb, threadId, intent);
  },
});
