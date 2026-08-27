import { Command, CommanderError } from "commander";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { MaybePromise } from "../utils/types.ts";

/**
 * The shared commander runner (§4). A command's `invoke` and the
 * `definePlugin` dispatcher both build a FRESH program per invocation
 * through `runProgram`, so the behavior table lives in exactly one place.
 * Internal — `./cli` re-exports the public subset.
 */

/**
 * What a Command's `execute` receives as `ctx`: the plugin Context plus
 * host overlay fields. Parsed argv is the second argument. RPC execute
 * stays typed against the base Context; extra Command fields are
 * type-level only.
 */
export type CommandContext = {
  readonly bb: BbPluginApi;
  cwd?: string;
  threadId?: string;
  projectId?: string;
  signal?: AbortSignal;
};

/** Parsed argv. The payload `execute` receives, parallel to a tool's input. */
export type CommandInput = {
  /** Positional values — strings under commander's default parsers. */
  args: string[];
  options: Record<string, unknown>;
};

/** What a Command's `execute` returns, and what the host CLI protocol buffers. */
export type CommandResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

/**
 * The object passed to `defineCommand`. `execute` is a PROPERTY on
 * purpose: properties compare contravariantly under strictFunctionTypes,
 * so a command demanding more than CommandContext provides is rejected
 * at `defineCommand` (method syntax would compare bivariantly and let
 * superset demands slip through). Authors still write `async execute(ctx, { args, options })`.
 */
export type CommandDefinition = {
  summary: string;
  /** Declare arguments/options here; a user-supplied `.action()` is inert. */
  configure?: (cmd: Command) => void;
  execute: (ctx: CommandContext, input: CommandInput) => MaybePromise<CommandResult>;
};

export type CommandMap = Record<string, CommandDefinition> & Partial<Record<"rpc" | "help", never>>;

/** Throw from `execute` to exit with a chosen code (defaults to 1). */
export class CommandError extends Error {
  readonly exitCode: number;
  constructor(message: string, options?: { exitCode?: number }) {
    super(message);
    this.name = "CommandError";
    this.exitCode = options?.exitCode ?? 1;
  }
}

/** One node of the program `runProgram` builds. */
export type ProgramDefinition = {
  name: string;
  summary: string;
  configure?: (cmd: Command) => void;
  action?: (cmd: Command) => MaybePromise<CommandResult>;
  children?: ProgramDefinition[];
};

export type ProgramOptions = { name?: string; summary?: string };

/** Map curated Commands to program nodes (shared by both tiers). */
export function commandDefinitions(
  commands: Readonly<Record<string, CommandDefinition>>,
  ctx: CommandContext,
): ProgramDefinition[] {
  return Object.entries(commands).map(([name, command]) => ({
    name,
    summary: command.summary,
    configure: command.configure,
    action: (cmd: Command) =>
      command.execute(ctx, {
        args: cmd.processedArgs as string[],
        options: cmd.opts(),
      }),
  }));
}

/**
 * The behavior table (§4):
 * - empty argv            → exit 2, help on stderr
 * - `--help` / `help`     → exit 0, help on stdout
 * - unknown command or
 *   parse error           → exit 2, commander's message on stderr
 * - thrown CommandError   → its exitCode, message on stderr
 * - anything else thrown  → exit 1, message on stderr
 */
export async function runProgram(
  makeDefinitions: () => ProgramDefinition[],
  argv: readonly string[],
  options: ProgramOptions,
): Promise<CommandResult> {
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
    if (error instanceof CommandError) {
      return { exitCode: error.exitCode, stderr: `${error.message}\n` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stderr: `${message}\n` };
  }
}

type OutputSink = { out: string; err: string; result: CommandResult | undefined };

/**
 * Build a commander program. Settings (exitOverride, output capture)
 * are installed BEFORE subcommands are created so `parent.command()`
 * copies them down via commander's `copyInheritedSettings`. `configure`
 * runs here — at registration for the metadata build, and again on
 * every invocation.
 */
export function buildProgram(
  definitions: readonly ProgramDefinition[],
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
    ((result: CommandResult): void => {
      sink.result = result;
    });
  for (const definition of definitions) {
    addNode(program, definition, onResult);
  }
  return program;
}

function addNode(
  parent: Command,
  definition: ProgramDefinition,
  onResult?: (result: CommandResult) => void,
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
    addNode(sub, child, onResult);
  }
}
