import { defineCommand } from "@bb-kit/core/command";
import { overview } from "../rpc/overview.ts";
export const status = defineCommand({
  summary: "Show Cloudflare setup, account inventory and protected development shares",
  async execute(ctx) {
    return { exitCode: 0, stdout: JSON.stringify(await overview.execute(ctx), null, 2) };
  },
});
