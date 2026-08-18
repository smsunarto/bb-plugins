import { defineOperation } from "../../../lib/bb-kit/operations.js";
import { saveFileInputSchema, saveFileOutputSchema } from "../contract.js";

export default defineOperation({
  kind: "command",
  risk: "mutating",
  input: saveFileInputSchema,
  exampleInput: {
    path: "AGENTS.md",
    content: "# Dotfiles\n",
    expectedSha256: "replace-with-current-sha256",
  },
  output: saveFileOutputSchema,
});
