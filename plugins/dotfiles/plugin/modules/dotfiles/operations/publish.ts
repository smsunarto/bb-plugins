import { defineOperation, noInput } from "@bb-kit/core/operations";
import { taskResultSchema } from "../contract.js";

export default defineOperation({
  kind: "command",
  risk: "destructive",
  input: noInput,
  output: taskResultSchema,
});
