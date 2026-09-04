import { argv, CommandError, defineCommand } from "@bb-kit/core/command";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { CommentOp } from "../../shared/comments.ts";
import { newId } from "../../shared/ids.ts";
import { applyCommentOp, CommentsError } from "../comments-store.ts";

export const comment = defineCommand({
  summary: "Reply to, resolve, or reopen a comment thread on a .canvas.mdx file as the agent",
  input: z.object({
    path: argv.argument(z.string().min(1), {
      description: "Canvas file, absolute or relative to the cwd",
    }),
    threadId: argv.argument(z.string().min(1), { description: "Thread id, cmt_..." }),
    reply: argv.option(z.string().min(1).optional(), { description: "Reply text" }),
    resolve: argv.flag(z.boolean().optional(), { description: "Mark the thread resolved" }),
    reopen: argv.flag(z.boolean().optional(), { description: "Reopen a resolved thread" }),
  }),
  async execute(ctx, { path, threadId, reply, resolve: markResolved, reopen }) {
    if (reply === undefined && markResolved !== true && reopen !== true) {
      throw new CommandError("nothing to do; pass --reply <text>, --resolve, or --reopen");
    }
    if (markResolved === true && reopen === true) {
      throw new CommandError("--resolve and --reopen exclude each other");
    }
    const absolute = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
    const source = { kind: "host", hostId: null, path: absolute } as const;
    const ops: { op: CommentOp; did: string }[] = [];
    if (reply !== undefined) {
      const message = {
        id: newId("msg"),
        author: "agent",
        body: reply,
        createdAtMs: Date.now(),
      } as const;
      ops.push({ op: { op: "reply", threadId, message }, did: "replied" });
    }
    if (markResolved === true)
      ops.push({ op: { op: "resolve", threadId, resolved: true }, did: "resolved" });
    if (reopen === true)
      ops.push({ op: { op: "resolve", threadId, resolved: false }, did: "reopened" });
    try {
      for (const { op } of ops) await applyCommentOp(ctx.bb, source, op);
    } catch (error) {
      if (error instanceof CommentsError) throw new CommandError(`${path}: ${error.message}`);
      throw error;
    }
    return { exitCode: 0, stdout: `${threadId}: ${ops.map((entry) => entry.did).join(", ")}\n` };
  },
});
