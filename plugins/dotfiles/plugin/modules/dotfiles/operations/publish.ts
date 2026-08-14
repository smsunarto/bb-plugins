import { defineOperation, noInput } from "@smsunarto/bb-kit/operations";
import { taskResultSchema } from "../contract.js";

export default defineOperation({
  kind: "command",
  risk: "destructive",
  input: noInput,
  output: taskResultSchema,
});
