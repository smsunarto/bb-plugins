import { z } from "zod";
import { accountSchema, branchIdSchema, parsePrReference, prKey } from "./schema.ts";

const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
export const reviewTargetSchema = z.union([
  z.strictObject({ branch: branchIdSchema, base: sha.optional(), head: sha.optional() }),
  z.strictObject({
    pr: z
      .string()
      .transform(parsePrReference)
      .refine((ref) => ref !== null),
    account: accountSchema.optional(),
  }),
]);

// Groups retain the exact checkout identity as well as the review range.
export const groupedTargetSchema = z.union([
  z.strictObject({
    branch: branchIdSchema,
    base: sha,
    head: sha,
    branchName: z.string().min(1),
    hostId: z.string().min(1),
    path: z.string().min(1),
  }),
  z.strictObject({
    pr: z.string().transform((value, ctx) => {
      const ref = parsePrReference(value);
      if (!ref) {
        ctx.addIssue({ code: "custom", message: "Not a GitHub pull request." });
        return z.NEVER;
      }
      return prKey(ref);
    }),
    account: accountSchema.optional(),
  }),
]);
export const reviewGroupSchema = z
  .array(groupedTargetSchema)
  .min(2)
  .max(25)
  .superRefine((targets, ctx) => {
    const identities = targets.map((target) =>
      "branch" in target ? target.branch : target.pr.toLowerCase(),
    );
    if (new Set(identities).size !== identities.length)
      ctx.addIssue({ code: "custom", message: "A review group must contain distinct targets." });
  });
export type ReviewGroup = z.infer<typeof reviewGroupSchema>;

export const reviewAttributesSchema = z.union([
  reviewTargetSchema,
  z.strictObject({
    targets: z
      .string()
      .max(200_000)
      .transform((value, ctx) => {
        try {
          return reviewGroupSchema.parse(JSON.parse(decodeURIComponent(value)));
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid review group" });
          return z.NEVER;
        }
      }),
  }),
]);
