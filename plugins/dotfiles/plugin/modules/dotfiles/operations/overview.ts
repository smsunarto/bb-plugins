import { defineOperation, noInput } from "@bb-kit/core/operations";
import { overviewOutputSchema } from "../contract.js";

export default defineOperation({
  kind: "query",
  input: noInput,
  output: overviewOutputSchema,
});
