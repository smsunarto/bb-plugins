import { defineOperation } from "../../../lib/bb-kit/operations.js";
import { runTaskInputSchema, taskResultSchema } from "../contract.js";

export default defineOperation({
  kind: "command",
  risk: "mutating",
  input: runTaskInputSchema,
  exampleInput: { task: "check" },
  output: taskResultSchema,
});
