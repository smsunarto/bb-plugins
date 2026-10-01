// Vendored from dev.fast review/src/review-api/trace-schema.ts @4ecc570 (MIT).
import { z } from "zod";

export const traceSchema = z.strictObject({
  label: z.string(),
  events: z.array(
    z.strictObject({
      id: z.string().min(1),
      role: z.enum(["user", "assistant", "tool"]),
      text: z.string(),
    }),
  ),
  provenance: z.enum(["client_supplied", "legacy_import"]).optional(),
});
