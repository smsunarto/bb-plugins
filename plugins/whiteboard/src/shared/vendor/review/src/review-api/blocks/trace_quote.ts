// Vendored from dev.fast review/src/review-api/blocks/trace_quote.ts @4ecc570 (MIT).
import { defineBlock, label } from "./definition.ts";

export const trace_quote = {
  type: "trace_quote",
  schema: defineBlock("trace_quote", {
    traceId: label,
    eventId: label,
    text: label,
  }),
} as const;
