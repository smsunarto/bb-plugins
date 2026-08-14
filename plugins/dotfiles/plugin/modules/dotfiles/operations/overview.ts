import { defineOperation, noInput } from "@smsunarto/bb-kit/operations";
import { overviewOutputSchema } from "../contract.js";

export default defineOperation({
  kind: "query",
  input: noInput,
  output: overviewOutputSchema,
});
