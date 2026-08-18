import { defineOperation, noInput } from "../../../lib/bb-kit/operations.js";
import { overviewOutputSchema } from "../contract.js";

export default defineOperation({
  kind: "query",
  input: noInput,
  output: overviewOutputSchema,
});
