import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";

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
  async execute(ctx, { message, title, threadId, projectId }) {
    const project = projectId ? await projectName(ctx.bb, projectId) : null;
    const listening = await deliver(ctx.bb, {
      project,
      heading: title ?? "bb",
      message: oneLine(plainText(message), BODY_MAX_CHARS),
      threadId: threadId ?? null,
    });
    return { listening };
  },
});
