import { defineCommand } from "@bb-kit/core/command";
import { overview } from "../rpc/overview.ts";
import { quickList } from "../rpc/quick-list.ts";
export const status = defineCommand({
  summary: "Show Cloudflare setup, account inventory, quick shares and protected shares",
  async execute(ctx) {
    const [account, quick] = await Promise.all([overview.execute(ctx), quickList.execute(ctx)]);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ ...account, quickShares: quick.shares }, null, 2),
    };
  },
});
