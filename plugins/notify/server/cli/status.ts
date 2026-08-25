import { defineCommand } from "@bb-kit/core/cli";

import { status as statusRpc } from "../rpc/status.ts";
import type { Context } from "@bb-kit/core/plugin";

/** Print the listening state and every filter, one aligned line each. */
export const status = defineCommand({
  summary: "Show whether a BB window is listening, and the filters",
  run: async (context: Context) => {
    const s = await statusRpc.handler(context);
    const lines = [
      `window:     ${s.listening ? `listening (${s.polling} polling)` : "none open — notifications will wait"}`,
      `held:       ${s.held}`,
      `on idle:    ${s.notifyOnIdle}`,
      `on failed:  ${s.notifyOnFailed}`,
      `children:   ${s.includeChildThreads}`,
      `hidden:     ${s.includeHiddenThreads}`,
      `min run:    ${s.minRunSeconds}s`,
      `sound:      ${s.sound}`,
      `agent tool: ${s.agentTool ? "notify_user" : "disabled"}`,
    ];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  },
});
