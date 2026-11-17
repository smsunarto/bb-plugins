import { defineCli } from "@get-bb/plugin-sdk";
import { archiveCommand } from "./commands/archive.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { driveReadCommand, driveWriteCommand } from "./commands/drive.ts";
import { newCommand } from "./commands/new.ts";
import { repoAddCommand, repoRemoveCommand } from "./commands/repo.ts";

/** `bb captain …`: text output ids first by default, one compact object with `--json`. */
export function captainCli(deps: CommandDeps) {
  return defineCli({
    name: "captain",
    summary: "Run a Captain thread that directs crew threads across repos",
    commands: {
      new: newCommand(deps),
      archive: archiveCommand(deps),
      "repo add": repoAddCommand(deps),
      "repo remove": repoRemoveCommand(deps),
      "drive read": driveReadCommand(deps),
      "drive write": driveWriteCommand(deps),
    },
  });
}
