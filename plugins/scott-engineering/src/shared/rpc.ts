import { defineRpcContract } from "@get-bb/plugin-sdk";
import { cardOutputSchema, scopedLookupSchema, runOutputSchema } from "./arena.ts";

export const rpcContract = defineRpcContract({
  get: { input: scopedLookupSchema, output: cardOutputSchema },
  stop: { input: scopedLookupSchema, output: runOutputSchema },
});
