import type { CommandContext, CommandDefinition, CommandResult } from "./runner.ts";
import { commandDefinitions, runProgram } from "./runner.ts";

/** Public surface of `@bb-kit/core/cli` (§1, §4). */
export { CommandError } from "./runner.ts";
export type { CommandDefinition, CommandInput, CommandResult, CommandContext } from "./runner.ts";

export type DefinedCommand = CommandDefinition & {
  /**
   * Tier-1 invocation, parallel to an RPC's `execute(ctx[, args])`.
   * First argument is the plugin context plus host overlay fields
   * (partial in tests). `argv` is the command's own arguments.
   */
  invoke: (ctx?: Partial<CommandContext>, argv?: readonly string[]) => Promise<CommandResult>;
};

const INVOKE = "command";

/**
 * Declare a command. `execute` takes `CommandContext` then
 * `CommandInput`. Extra fields the preset does not provide are
 * rejected here.
 */
export function defineCommand(command: CommandDefinition): DefinedCommand {
  return {
    ...command,
    invoke(ctx = {}, argv = []) {
      return runProgram(
        () => commandDefinitions({ [INVOKE]: command }, ctx as CommandContext),
        [INVOKE, ...argv],
        {},
      );
    },
  };
}
