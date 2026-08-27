import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";

import { deliver } from "../delivery.ts";
import { BODY_MAX_CHARS, isThreadId, oneLine, plainText } from "../format.ts";
import { projectName } from "../project-names.ts";

/** The public response keeps `listening` for compatibility. It means a renderer acknowledged the notification. */
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
    outcome: z.enum(["shown", "suppressed", "unavailable", "failed"]),
  }),
  async execute(ctx, { message, title, threadId, projectId }) {
    let resolvedProjectId = projectId;
    if (resolvedProjectId === undefined && threadId !== undefined) {
      try {
        const thread = await ctx.bb.sdk.threads.get({ threadId });
        resolvedProjectId = thread.projectId;
      } catch {
        // Thread lookup only supplies the project label. Its failure must not block delivery.
      }
    }
    const project =
      resolvedProjectId === undefined ? null : await projectName(ctx.bb, resolvedProjectId);
    const outcome = await deliver(ctx.bb, {
      project,
      heading: title ?? "bb",
      message: oneLine(plainText(message), BODY_MAX_CHARS),
      threadId: threadId ?? null,
    });
    return { listening: outcome === "shown" || outcome === "suppressed", outcome };
  },
});
