import { definePlugin } from "@bb-kit/core/plugin";
import { check } from "./command/check.ts";
import { comment as commentCommand } from "./command/comment.ts";
import { comments as commentsCommand } from "./command/comments.ts";
import { commentsInstructions } from "./comments-store.ts";
import { comment } from "./rpc/comment.ts";
import { comments } from "./rpc/comments.ts";
import { render } from "./rpc/render.ts";
import { resetState } from "./rpc/reset-state.ts";
import { setState } from "./rpc/set-state.ts";
import { state } from "./rpc/state.ts";

export default definePlugin({
  pluginId: "canvas",
  rpc: { render, state, setState, resetState, comments, comment },
  command: { check, comments: commentsCommand, comment: commentCommand },
  agents: {
    tools: {},
    instructions(_ctx, { threadId }) {
      return commentsInstructions(threadId);
    },
  },
});
