import type { BbPluginApi } from "@bb/plugin-sdk";
import { registerOperations } from "@smsunarto/bb-kit/operations";
import { registerDotfilesCli } from "./cli.js";
import { dotfilesOperations } from "./generated/operations.js";
import { createDotfilesRepository } from "./repository.js";
import { createDotfilesService } from "./service.js";

export async function installDotfiles(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    repoPath: {
      type: "string",
      label: "Dotfiles repo path (on the bb server host)",
      default: "~/git/dotfiles",
    },
  });
  const repository = createDotfilesRepository({
    files: bb.sdk.files,
    getConfiguredRepoPath: async () => (await settings.get()).repoPath,
  });
  bb.onDispose(() => repository.dispose());

  const service = createDotfilesService({
    repository,
    log: (message) => bb.log.info(message),
  });
  registerOperations(bb, dotfilesOperations, service);
  registerDotfilesCli(bb.cli, service);

  const repoPath = await repository.getRepoPath();
  if (!repository.repoExists(repoPath)) {
    bb.status.needsConfiguration(
      `Dotfiles repo not found at ${repoPath}. Configure repoPath in the Dotfiles plugin settings.`,
    );
  }
}
