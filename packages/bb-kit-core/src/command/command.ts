import type {
  PluginCliCommand,
  PluginCliConstraint,
  PluginCliContext,
  PluginCliOption,
  PluginCliPositional,
  PluginCliResult,
  PluginCliRunInput,
} from "@get-bb/plugin-sdk";
import type { Context } from "../context.ts";
import type { ContextDemand, MaybePromise, UnionToIntersection } from "../utils/types.ts";

export { PluginCliError } from "@get-bb/plugin-sdk";

/** A command's `ctx`: the plugin Context plus the invocation's cwd, thread, and signal. */
export type CommandContext<C extends Context = Context> = C & PluginCliContext;

export type CommandResult = PluginCliResult;

type Options = Record<string, PluginCliOption>;
type Positionals = readonly PluginCliPositional[];

/** The declaration `defineCli` renders help from, minus `run`. */
type CommandSpec = Omit<PluginCliCommand, "run">;

export type DefinedCommand<C> = CommandSpec & {
  execute(ctx: C, input: PluginCliRunInput): MaybePromise<CommandResult>;
};

export type CommandMap = Record<string, DefinedCommand<never>>;

/**
 * Declare a command. `options`, `positionals`, and `constraints` are the
 * SDK's `cliCommand` declarations, so the SDK parses argv, renders
 * `--help`, and reports usage errors. `execute` gets the parsed values,
 * typed from the declaration. Throw `PluginCliError` for a failure the
 * caller should see as a usage-style error.
 */
export function defineCommand<
  const O extends Options = Record<never, never>,
  const P extends Positionals = readonly [],
  C extends Context = Context,
>(definition: {
  summary: string;
  description?: string;
  aliases?: readonly string[];
  hidden?: boolean;
  options?: O;
  positionals?: P;
  constraints?: readonly PluginCliConstraint[];
  passthrough?: boolean;
  execute(ctx: CommandContext<C>, input: PluginCliRunInput<O, P>): MaybePromise<CommandResult>;
}): DefinedCommand<CommandContext<C>> {
  return definition as unknown as DefinedCommand<CommandContext<C>>;
}

/** What a command map collectively demands of `ctx`. */
export type CommandsContext<M extends CommandMap> = UnionToIntersection<ContextDemand<M[keyof M]>>;
