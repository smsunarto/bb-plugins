import { defineOperation } from "../../../lib/bb-kit/operations.js";
import {
  removeSkillInputSchema,
  removeSkillOutputSchema,
} from "../contract.js";

export default defineOperation({
  kind: "command",
  risk: "destructive",
  input: removeSkillInputSchema,
  exampleInput: { name: "example-skill" },
  output: removeSkillOutputSchema,
});
