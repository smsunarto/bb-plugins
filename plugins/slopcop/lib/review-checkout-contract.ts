import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const checkoutResource = z.object({
  source: z.string().min(1),
  path: z.string().min(1),
  ref: z.string().regex(/^refs\/slopcop\/thr_[a-zA-Z0-9]+$/),
});
export const reviewCheckoutContract = defineRpcContract({
  prepare: {
    input: checkoutResource.extend({
      number: z.number().int().positive(),
      head: z.string().regex(/^[a-f0-9]{40}$/),
    }),
    output: z.object({ path: z.string() }),
  },
  remove: { input: checkoutResource, output: z.object({}) },
});
