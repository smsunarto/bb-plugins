import { defineCommand } from "@bb-kit/core/command";

import { status as statusRpc } from "../rpc/status.ts";

export const status = defineCommand({
  summary: "Show the BB renderer notification settings",
  async execute(ctx) {
    const s = await statusRpc.execute(ctx);
    const lines = [
      "delivery:   open BB desktop window",
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
