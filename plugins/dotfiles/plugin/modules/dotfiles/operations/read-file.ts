import { defineOperation } from "../../../lib/bb-kit/operations.js";
import { readFileInputSchema, readFileOutputSchema } from "../contract.js";

export default defineOperation({
  kind: "query",
  input: readFileInputSchema,
  exampleInput: { path: "AGENTS.md" },
  output: readFileOutputSchema,
});
