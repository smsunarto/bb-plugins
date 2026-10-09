import { defineCommand, PluginCliError } from "@bb-kit/core/command";
import type { CommentOp } from "../../shared/comments.ts";
import { newId } from "../../shared/ids.ts";
import { applyCommentOp, CommentsError } from "../comments-store.ts";
import { cliSource, hostOption } from "../lib/cli-source.ts";

export const comment = defineCommand({
  summary: "Reply to, resolve, or reopen a comment thread on a .canvas.mdx file as the agent",
  positionals: [
    { name: "path", description: "Canvas file, absolute or relative to the cwd", required: true },
    { name: "threadId", description: "Thread id, cmt_...", required: true },
  ],
  options: {
    reply: { type: "string", description: "Reply text", placeholder: "text" },
    resolve: { type: "boolean", description: "Mark the thread resolved" },
    reopen: { type: "boolean", description: "Reopen a resolved thread" },
    host: hostOption,
  },
  constraints: [
    { kind: "at-least-one", options: ["reply", "resolve", "reopen"] },
    { kind: "at-most-one", options: ["resolve", "reopen"] },
  ],
  async execute(ctx, { positionals: { path, threadId }, options }) {
    const { reply, resolve: markResolved, reopen, host } = options;
    if (reply === "") {
      throw new PluginCliError("--reply needs text", { code: "invalid_value" });
    }
    const source = await cliSource(ctx, path, host);
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
    if (markResolved)
      ops.push({ op: { op: "resolve", threadId, resolved: true }, did: "resolved" });
    if (reopen) ops.push({ op: { op: "resolve", threadId, resolved: false }, did: "reopened" });
    try {
      for (const { op } of ops) await applyCommentOp(ctx.bb, source, op);
    } catch (error) {
      if (error instanceof CommentsError) throw new PluginCliError(`${path}: ${error.message}`);
      throw error;
    }
    return { exitCode: 0, stdout: `${threadId}: ${ops.map((entry) => entry.did).join(", ")}\n` };
  },
});
