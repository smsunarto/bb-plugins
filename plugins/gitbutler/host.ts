import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { createFixedButCommands, type ExecFileLike } from "./host/commands.ts";
import { RepositoryMutationQueue } from "./host/mutation-queue.ts";
import { createGitButlerHostService, type GitButlerHostService } from "./host/service.ts";
import { gitButlerHostContract } from "./shared/host-contract.ts";

export function createGitButlerHostEntry(service: GitButlerHostService) {
  return experimental_defineHostEntry({
    contract: gitButlerHostContract,
    handlers: {
      inspectRepository(input, context) {
        return service.inspectRepository(input.repositoryPath, context.signal);
      },
      commitSelection(input, context) {
        return service.commitSelection(input.repositoryPath, input.intent, context.signal);
      },
    },
  });
}

const execute: ExecFileLike = (file, args, options, callback) => {
  execFile(file, args, options, callback);
};

const commands = createFixedButCommands(execute);
const mutations = new RepositoryMutationQueue();

export default createGitButlerHostEntry(
  createGitButlerHostService({ commands, mutations, realpath }),
);
