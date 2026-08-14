import { defineOperation } from "@bb-kit/core/operations";
import { readFileInputSchema, readFileOutputSchema } from "../contract.js";

export default defineOperation({
  kind: "query",
  input: readFileInputSchema,
  exampleInput: { path: "AGENTS.md" },
  output: readFileOutputSchema,
});
