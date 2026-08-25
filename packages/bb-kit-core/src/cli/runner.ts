import { Command, CommanderError } from "commander";
import type { MaybePromise, UnionToIntersection } from "../utils/types.ts";

/**
 * The shared commander runner (§4). A command's `invoke` and the
 * `definePlugin` dispatcher both build a FRESH program per invocation
 * through `runProgram`, so the behavior table lives in exactly one place.
 * Internal — `./cli` re-exports the public subset.
 */

/** What the host passes per invocation (bb's `PluginCliContext` fields). */
export type CLIContext = {
  cwd?: string;
  threadId?: string;
  projectId?: string;
  signal?: AbortSignal;
};

/**
 * What a Command's `run` receives: the plugin Context plus required
 * `cli`. RPC handlers stay typed against the base Context; the extra
 * `cli` property is type-level only.
 */
export type CommandContext<C extends object = {}> = C & {
  cli: CLIContext;
};

/** The buffered result shape bb's server-side CLI protocol expects. */
export type CLIResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

/** What a command's `run` receives alongside its context. */
export type CLIInvocation = {
  /** Positional values — strings under commander's default parsers. */
  args: string[];
  options: Record<string, unknown>;
};

/**
 * A command definition. `run` is a PROPERTY on purpose: properties
 * compare contravariantly under strictFunctionTypes, so a command
 * demanding more than the plugin's context provides is rejected at the
 * `definePlugin` call (method syntax would compare bivariantly and let
 * superset demands slip through).
 */
export type CLICommand<D> = {
  summary: string;
  /** Declare arguments/options here; a user-supplied `.action()` is inert. */
  configure?: (command: Command) => void;
  run: (context: D, invocation: CLIInvocation) => MaybePromise<CLIResult>;
};

export type CommandMap<D> = Record<string, CLICommand<D>> & Partial<Record<"rpc" | "help", never>>;

/** The universal bound: `run` is contravariant, so every map assigns. */
export type AnyCommandMap = CommandMap<never>;

type CommandDemand<Cmd> = Cmd extends { run: (context: infer D, invocation: never) => unknown }
  ? unknown extends D
    ? never // unannotated commands demand nothing
    : D
  : never;

/** What a command map collectively demands. Mirrors `RPCContext`. */
export type CommandsContext<C> = [CommandDemand<C[keyof C]>] extends [never]
  ? {}
  : UnionToIntersection<CommandDemand<C[keyof C]>>;

/** Throw from `run` to exit with a chosen code (defaults to 1). */
export class CLIError extends Error {
  readonly exitCode: number;
  constructor(message: string, options?: { exitCode?: number }) {
    super(message);
    this.name = "CLIError";
    this.exitCode = options?.exitCode ?? 1;
  }
}

/** One subcommand of the program `runProgram` builds. */
export type SubcommandDefinition = {
  name: string;
  summary: string;
  configure?: (command: Command) => void;
  action?: (command: Command) => MaybePromise<CLIResult>;
  children?: SubcommandDefinition[];
};

export type ProgramOptions = { name?: string; summary?: string };

/** Map curated commands to subcommand definitions (shared by both tiers). */
export function commandDefinitions<D>(
  commands: Readonly<Record<string, CLICommand<D>>>,
  context: D,
): SubcommandDefinition[] {
  return Object.entries(commands).map(([name, command]) => ({
    name,
    summary: command.summary,
    configure: command.configure,
    action: (sub: Command) =>
      command.run(context, {
        args: sub.processedArgs as string[],
        options: sub.opts(),
      }),
  }));
}

/**
 * The behavior table (§4):
 * - empty argv            → exit 2, help on stderr
 * - `--help` / `help`     → exit 0, help on stdout
 * - unknown command or
 *   parse error           → exit 2, commander's message on stderr
 * - thrown CLIError       → its exitCode, message on stderr
 * - anything else thrown  → exit 1, message on stderr
 */
export async function runProgram(
  makeDefinitions: () => SubcommandDefinition[],
  argv: readonly string[],
  options: ProgramOptions,
): Promise<CLIResult> {
  const sink: OutputSink = { out: "", err: "", result: undefined };
  try {
    const program = buildProgram(makeDefinitions(), options, sink);
    if (argv.length === 0) {
      return { exitCode: 2, stderr: program.helpInformation() };
    }
    await program.parseAsync([...argv], { from: "user" });
    if (sink.result) {
      return sink.result;
    }
    return { exitCode: 0, stdout: sink.out || undefined, stderr: sink.err || undefined };
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        // --help and the implicit help command land here.
        return { exitCode: 0, stdout: sink.out || undefined, stderr: sink.err || undefined };
      }
      return { exitCode: 2, stderr: sink.err || `${error.message}\n` };
    }
    if (error instanceof CLIError) {
      return { exitCode: error.exitCode, stderr: `${error.message}\n` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stderr: `${message}\n` };
  }
}

type OutputSink = { out: string; err: string; result: CLIResult | undefined };

/**
 * Build a commander program. Settings (exitOverride, output capture)
 * are installed BEFORE subcommands are created so `parent.command()`
 * copies them down via commander's `copyInheritedSettings`. `configure`
 * runs here — at registration for the metadata build, and again on
 * every invocation.
 */
export function buildProgram(
  definitions: readonly SubcommandDefinition[],
  options: ProgramOptions,
  sink?: OutputSink,
): Command {
  const program = new Command(options.name ?? "cli");
  program.exitOverride();
  if (options.summary !== undefined) {
    program.description(options.summary);
  }
  if (sink) {
    program.configureOutput({
      writeOut: (str) => {
        sink.out += str;
      },
      writeErr: (str) => {
        sink.err += str;
      },
    });
  }
  const onResult =
    sink &&
    ((result: CLIResult): void => {
      sink.result = result;
    });
  for (const definition of definitions) {
    addSubcommand(program, definition, onResult);
  }
  return program;
}

function addSubcommand(
  parent: Command,
  definition: SubcommandDefinition,
  onResult?: (result: CLIResult) => void,
): void {
  const sub = parent.command(definition.name);
  sub.summary(definition.summary);
  definition.configure?.(sub);
  const action = definition.action;
  if (action) {
    // Installed AFTER configure: overwrites any user-supplied .action().
    sub.action(async () => {
      const result = await action(sub);
      onResult?.(result);
    });
  }
  for (const child of definition.children ?? []) {
    addSubcommand(sub, child, onResult);
  }
}
