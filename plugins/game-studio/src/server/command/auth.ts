import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import { falAuthAction, type FalOAuthContext } from "../lib/fal-oauth.ts";
export const auth = defineCommand({
  summary: "Connect Fal through browser OAuth and inspect or disconnect authorization",
  positionals: [
    { name: "action", required: true, description: "connect | poll | status | disconnect" },
  ],
  async execute(ctx: CommandContext<FalOAuthContext>, input) {
    const result = await ctx.falOAuth.execute(falAuthAction.parse(input.positionals.action));
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
  },
});
