import { defineOperation, noInput } from "../../../lib/bb-kit/operations.js";
import { taskResultSchema } from "../contract.js";

export default defineOperation({
  kind: "command",
  risk: "destructive",
  input: noInput,
  output: taskResultSchema,
});
