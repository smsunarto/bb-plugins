import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  proposalsInputSchema,
  proposalsOutputSchema,
  decideProposalInputSchema,
  decideProposalOutputSchema,
} from "./proposals.ts";
import { canvasStateSchema, setStateInputSchema, stateInputSchema } from "./document.ts";
import {
  commentInputSchema,
  commentOutputSchema,
  commentsInputSchema,
  commentsOutputSchema,
} from "./comments.ts";
export { stateChannel, stateKeyOf } from "./source.ts";

// The Docs editor forwards these methods through BB's plugin RPC API. Canvas
// remains the owner of persisted controls and comment sidecars.
export const canvasEditorContract = defineRpcContract({
  state: { input: stateInputSchema, output: canvasStateSchema },
  setState: { input: setStateInputSchema, output: canvasStateSchema },
  resetState: { input: stateInputSchema, output: canvasStateSchema },
  comments: { input: commentsInputSchema, output: commentsOutputSchema },
  comment: { input: commentInputSchema, output: commentOutputSchema },
  proposals: { input: proposalsInputSchema, output: proposalsOutputSchema },
  decide: { input: decideProposalInputSchema, output: decideProposalOutputSchema },
});
