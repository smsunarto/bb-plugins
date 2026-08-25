import type { CLICommand, CLIContext, CLIResult } from "./runner.ts";
import { commandDefinitions, runProgram } from "./runner.ts";

/** Public surface of `@bb-kit/core/cli` (§1, §4). */
export { CLIError } from "./runner.ts";
export type { CLICommand, CLIContext, CLIResult, CommandContext } from "./runner.ts";

type ContextOf<D> = D extends object ? Partial<D> : D;

export type DefinedCommand<D> = CLICommand<D> & {
  /**
   * Tier-1 invocation, parallel to an RPC's `handler(context, input)`.
   * First argument is the plugin context (partial in tests).
   * `argv` is the command's own arguments. `options.cli` is the host
   * invocation overlay.
   */
  invoke: (
    context?: ContextOf<D>,
    argv?: readonly string[],
    options?: { cli?: CLIContext },
  ) => Promise<CLIResult>;
};

const INVOKE = "command";

/**
 * Declare a command. `D` — what the command demands of the plugin
 * context — infers from `run`'s first-parameter annotation; unannotated,
 * it stays `unknown` and the command accepts any context.
 */
export function defineCommand<D = unknown>(command: CLICommand<D>): DefinedCommand<D> {
  return {
    ...command,
    invoke(pluginContext, argv = [], options = {}) {
      const cli = options.cli ?? {};
      const context = { ...pluginContext, cli } as D;
      return runProgram(
        () => commandDefinitions({ [INVOKE]: command }, context),
        [INVOKE, ...argv],
        {},
      );
    },
  };
}
