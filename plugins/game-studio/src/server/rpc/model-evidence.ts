import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { modelEvidenceInput } from "../../shared/model-review.ts";
import { saveModelEvidence } from "../lib/model-evidence.ts";

export const modelEvidence = defineMutation({
  input: modelEvidenceInput,
  output: z.object({ runId: z.string(), files: z.array(z.string()) }),
  execute: (ctx, input) => saveModelEvidence(ctx.bb, input),
});
