import { defineRpcContract } from "@get-bb/plugin-sdk";
import { scopedLookupSchema, runOutputSchema } from "./arena.ts";

export const rpcContract = defineRpcContract({
  get: { input: scopedLookupSchema, output: runOutputSchema },
  stop: { input: scopedLookupSchema, output: runOutputSchema },
});
