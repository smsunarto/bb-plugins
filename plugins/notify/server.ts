// @smsunarto/bb-plugin-notify — desktop notifications for BB thread lifecycle events.
//
// BB notifies agents (parent threads, workflow completions) but never notifies
// the person. This plugin closes that gap: it listens to thread.idle and
// thread.failed and posts a native desktop notification, and it gives agents a
// `notify_user` tool plus a `bb notify` command for the same thing on demand.
//
// This file is the composition root only. The shared state lives in
// server/context.ts, the HTTP/event/agent registrations in their server/
// modules, and each procedure or command in its own file under rpc/ and cli/.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { definePlugin } from "@bb-kit/core/plugin";
import { defineRPC, type ClientFor } from "@bb-kit/core/rpc";

import { send as sendCommand } from "./cli/send.ts";
import { status as statusCommand } from "./cli/status.ts";
import { test as testCommand } from "./cli/test.ts";
import { send } from "./rpc/send.ts";
import { status } from "./rpc/status.ts";
import { registerAgentTool } from "./server/agent-tool.ts";
import { createContext } from "./server/context.ts";
import { registerEvents } from "./server/events.ts";
import { registerRoutes } from "./server/routes.ts";

export const rpc = defineRPC({
  namespace: "notify",
  procedures: { send, status },
});

export type RPC = typeof rpc;
export type Client = ClientFor<RPC>;

export default definePlugin({
  rpc,
  cli: {
    summary: "Post a desktop notification through the BB app window",
    commands: { send: sendCommand, status: statusCommand, test: testCommand },
  },
  context: createContext,
  async setup(bb: BbPluginApi, { context }) {
    registerRoutes(bb, context);
    registerEvents(bb, context);
    registerAgentTool(bb, context);
  },
});
