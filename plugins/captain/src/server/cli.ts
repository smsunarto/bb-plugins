import { defineCli } from "@get-bb/plugin-sdk";
import { archiveCommand } from "./commands/archive.ts";
import { askCommand, askResolveCommand } from "./commands/ask.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { driveReadCommand, driveWriteCommand } from "./commands/drive.ts";
import { iconCommand } from "./commands/icon.ts";
import { newCommand } from "./commands/new.ts";
import { dispatchCommand } from "./commands/dispatch.ts";
import { repoAddCommand, repoRemoveCommand } from "./commands/repo.ts";
import { statusCommand } from "./commands/status.ts";
import { tellCommand } from "./commands/tell.ts";
import { verdictCommand } from "./commands/verdict.ts";

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
      dispatch: dispatchCommand(deps),
      verdict: verdictCommand(deps),
      tell: tellCommand(deps),
      ask: askCommand(deps),
      "ask resolve": askResolveCommand(deps),
      status: statusCommand(deps),
      icon: iconCommand(deps),
    },
  });
}
