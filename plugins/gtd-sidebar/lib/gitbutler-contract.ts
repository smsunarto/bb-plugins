import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const gitButlerHostContract = defineRpcContract({
  branchSummary: {
    experimental_retryable: true,
    input: z.object({ cwd: z.string().trim().min(1) }),
    output: z.object({
      label: z.string().nullable(),
    }),
  },
});
