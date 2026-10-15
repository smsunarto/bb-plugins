import { promptInput, requestDescriptorSchema } from "./schema.ts";

export const REQUEST_MENTION_PROVIDER = "request";

export const requestMentionSchema = promptInput
  .safeExtend({ request: requestDescriptorSchema })
  .refine(({ action, request }) => action === request.action, {
    error: "The context action must match its prepared request.",
  });
