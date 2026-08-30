import { Command, CommanderError } from "commander";
import type { MaybePromise } from "../utils/types.ts";
import { declareArgv, formatArgvIssues, readArgv } from "./argv.ts";
import {
  CommandError,
  runtimeCommands,
  type AnyCommand,
  type CommandContext,
  type CommandResult,
} from "./command.ts";

/** One node of the program `runProgram` builds. Internal — commander stays here. */
export type ProgramDefinition = {
  name: string;
  summary: string;
  configure?: (cmd: Command) => void;
  action?: (cmd: Command) => MaybePromise<CommandResult>;
  children?: ProgramDefinition[];
};

export type ProgramOptions = {
  name?: string;
  summary?: string;
  onUnhandledError?: (error: unknown) => void;
};

/** Map curated Commands to program nodes (shared by both tiers). */
export function commandDefinitions(
  commands: Readonly<Record<string, AnyCommand>>,
  ctx: CommandContext,
): ProgramDefinition[] {
  return Object.entries(runtimeCommands(commands)).map(([name, command]) => {
    const input = command.input;
    if (input === undefined) {
      return {
        name,
        summary: command.summary,
        action: () => command.execute(ctx),
      };
    }
    return {
      name,
      summary: command.summary,
      configure: (cmd: Command) => {
        declareArgv(cmd, input);
      },
      action: async (cmd: Command): Promise<CommandResult> => {
        const raw = readArgv(cmd, input);
        const parsed = await input["~standard"].validate(raw);
        if (parsed.issues) {
          throw new CommandError(formatArgvIssues(parsed.issues), { exitCode: 2 });
        }
        return command.execute(ctx, parsed.value);
      },
    };
  });
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
        return { exitCode: 0, stdout: sink.out || undefined, stderr: sink.err || undefined };
      }
      return { exitCode: 2, stderr: sink.err || `${error.message}\n` };
    }
    if (error instanceof CommandError) {
      return { exitCode: error.exitCode, stderr: `${error.message}\n` };
    }
    try {
      options.onUnhandledError?.(error);
    } catch {}
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
