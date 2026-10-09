import { PluginCliError, type CommandContext } from "@bb-kit/core/command";
import type { GitContext } from "../git.ts";
import { overview, type OverviewResult } from "../rpc/overview.ts";

export type ReadyOverview = Extract<OverviewResult, { state: "ready" }>;

/**
 * The checkout a `bb dotfiles` command acts on: the invoking agent's
 * machine when its thread has an environment, else the panel's machine.
 * Throws when that machine is offline or has no repo at the path.
 */
export async function commandCheckout(ctx: CommandContext<GitContext>): Promise<ReadyOverview> {
  const hostId = ctx.threadId === undefined ? undefined : await ctx.git.threadHostId(ctx.threadId);
  const snapshot = await overview.execute(ctx, { hostId });
  if (snapshot.state === "offline") {
    throw new PluginCliError(`${snapshot.host.name} is not connected`);
  }
  if (!snapshot.repoExists) {
    throw new PluginCliError(
      `dotfiles repo not found at ${snapshot.repoPath} on ${snapshot.host.name}`,
    );
  }
  return snapshot;
}

/** The stderr line naming the machine and checkout a command acted on. */
export function actedOn(snapshot: ReadyOverview): string {
  return `host: ${snapshot.host.name} · repo: ${snapshot.repoPath}\n`;
}
