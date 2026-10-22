import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import type { Context } from "@bb-kit/core/plugin";
import type { Service } from "../lib/service.ts";
export const wake = defineCommand({
  summary: "Ask BB to resume the registered GCP machine",
  async execute({ gcp }: CommandContext<Context<{ gcp: Service }>>) {
    return { exitCode: 0, stdout: JSON.stringify(await gcp.wake(), null, 2) };
  },
});
