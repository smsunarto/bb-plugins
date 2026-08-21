import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { DotfilesRepository } from "./repository.ts";
import { createDotfilesRepository } from "./repository.ts";

/** The one Context every handler annotates. */
export type Context = {
  readonly repository: DotfilesRepository;
  readonly log: (message: string) => void;
};

export function createContext(bb: BbPluginApi): Context {
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
  return {
    repository,
    log: (message) => bb.log.info(message),
  };
}
