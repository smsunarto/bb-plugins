import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import type { Context } from "@bb-kit/core/plugin";
import type { Service } from "../lib/service.ts";
export const status = defineCommand({
  summary: "Show GCP VM state, BB registration, and the one-hour idle policy",
  async execute({ gcp }: CommandContext<Context<{ gcp: Service }>>) {
    return { exitCode: 0, stdout: JSON.stringify(await gcp.status(), null, 2) };
  },
});
