import { defineOperation } from "@smsunarto/bb-kit/operations";
import { runTaskInputSchema, taskResultSchema } from "../contract.js";

export default defineOperation({
  kind: "command",
  risk: "mutating",
  input: runTaskInputSchema,
  exampleInput: { task: "check" },
  output: taskResultSchema,
});
