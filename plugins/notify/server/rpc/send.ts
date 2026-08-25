import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";

import type { Context } from "@bb-kit/core/plugin";
import { deliver } from "../delivery.ts";
import { BODY_MAX_CHARS, isThreadId, oneLine, plainText } from "../format.ts";
import { projectName } from "../project-names.ts";

/** Post a notification. `listening` reports whether a window will show it now. */
export const send = defineMutation({
  input: z.object({
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
    const project = input.projectId ? await projectName(context.bb, input.projectId) : null;
    const listening = await deliver(context.bb, {
      project,
      heading: input.title ?? "bb",
      message: oneLine(plainText(input.message), BODY_MAX_CHARS),
      threadId: input.threadId ?? null,
    });
    return { listening };
  },
});
