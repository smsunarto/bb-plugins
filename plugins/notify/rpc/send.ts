import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";

import { BODY_MAX_CHARS, type Context } from "../server/context.ts";
import { isThreadId, oneLine, plainText } from "../server/format.ts";

/** Post a notification. `listening` reports whether a window will show it now. */
export const send = defineMutation({
  input: z.object({
    // Trim first so a whitespace-only message fails min(1) instead of
    // posting a notification with an empty body.
    message: z.string().trim().min(1),
    title: z.string().optional(),
    threadId: z
      .string()
      .refine((value) => isThreadId(value), "not a thread id")
      .optional(),
    projectId: z.string().optional(),
  }),
  output: z.object({
    listening: z.boolean(),
  }),
  handler: async (context: Context, input) => {
    // Same title shape as an event notification, so a scripted one does not
    // look like it came from somewhere else.
    const project = input.projectId ? await context.projectName(input.projectId) : null;
    const listening = await context.post(
      project,
      input.title ?? "bb",
      oneLine(plainText(input.message), BODY_MAX_CHARS),
      input.threadId ?? null,
    );
    return { listening };
  },
});
