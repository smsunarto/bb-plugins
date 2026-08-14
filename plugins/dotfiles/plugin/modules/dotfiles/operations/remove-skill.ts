import { defineOperation } from "@smsunarto/bb-kit/operations";
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
