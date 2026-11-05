import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const checkoutResource = z.object({
  source: z.string().min(1),
  path: z.string().min(1),
  ref: z.string().regex(/^refs\/slopcop\/thr_[a-zA-Z0-9]+$/),
});
export const reviewTarget = z.object({
  number: z.number().int().positive(),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  // Optional so environments queued before this field existed still provision.
  base: z
    .string()
    .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/)
    .optional(),
});
export const reviewCheckoutContract = defineRpcContract({
  resolveSource: {
    input: z.object({ remote: z.string().min(1), preferred: z.string().min(1).nullable() }),
    output: z.object({ source: z.string() }),
  },
  prepare: {
    input: checkoutResource.extend(reviewTarget.shape),
    output: z.object({ path: z.string() }),
  },
  remove: { input: checkoutResource, output: z.object({}) },
});
