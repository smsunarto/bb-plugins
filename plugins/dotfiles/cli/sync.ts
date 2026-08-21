import { CLIError, defineCommand } from "@bb-kit/core/cli";
import type { Client } from "../server.ts";

export const sync = defineCommand({
  summary: "Sync the repo; default is consume-only, --publish pushes",
  configure: (command) => {
    command.option("--publish", "publish: rebase, push, re-apply, and render");
  },
  run: async (client: Client, { options }) => {
    const overview = await client.overview();
    if (!overview.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${overview.repoPath}`);
    }
    const result = options["publish"]
      ? await client.publish()
      : await client.runTask({ task: "sync:pull" });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
