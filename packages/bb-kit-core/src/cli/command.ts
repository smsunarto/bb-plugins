import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { JSONObjectSchema, SchemaOutput, StandardSchemaV1 } from "../rpc/rpc.ts";
import type { MaybePromise } from "../utils/types.ts";
import { assertCommandInput, type BoundField, type CommandInputSchema } from "./argv.ts";

/**
 * Plugin Context plus host overlay fields. Parsed argv is the second
 * execute argument, not these fields.
 */
export type CommandContext = {
  readonly bb: BbPluginApi;
  cwd?: string;
  threadId?: string;
  projectId?: string;
  signal?: AbortSignal;
};

export type CommandResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

/** Throw from `execute` to exit with a chosen code (defaults to 1). */
export class CommandError extends Error {
  readonly exitCode: number;
  constructor(message: string, options?: { exitCode?: number }) {
    super(message);
    this.name = "CommandError";
    this.exitCode = options?.exitCode ?? 1;
  }
}

type ObjectWithShape = StandardSchemaV1 &
  JSONObjectSchema & {
    readonly shape: Readonly<Record<string, unknown>>;
  };

type BoundShape<Shape> = {
  readonly [Key in keyof Shape]: Shape[Key] extends BoundField ? Shape[Key] : BoundField;
};

export type CommandWithInput<Input extends CommandInputSchema> = {
  readonly summary: string;
  readonly input: Input;
  execute(ctx: CommandContext, input: SchemaOutput<Input>): MaybePromise<CommandResult>;
};

export type CommandWithoutInput = {
  readonly summary: string;
  readonly input?: never;
  execute(ctx: CommandContext): MaybePromise<CommandResult>;
};

/**
 * Map entry. Method syntax so a narrower execute still assigns.
 * `input` is required-or-absent, never optional.
 */
export type AnyCommand = {
  readonly summary: string;
  readonly input?: CommandInputSchema;
  execute(ctx: never, ...rest: never[]): unknown;
};

export type CommandMap = Record<string, AnyCommand> & Partial<Record<"rpc" | "help", never>>;

export type RuntimeCommand = {
  summary: string;
  input?: CommandInputSchema;
  execute: (ctx: CommandContext, input?: unknown) => MaybePromise<CommandResult>;
};

export function runtimeCommands(commands: Readonly<Record<string, AnyCommand>>): Record<string, RuntimeCommand> {
  return commands as Record<string, RuntimeCommand>;
}

type ExecuteArity<Execute extends (...args: never[]) => unknown, Allowed extends number> = number extends
  Parameters<Execute>["length"]
  ? never
  : Parameters<Execute>["length"] extends Allowed
    ? unknown
    : { readonly execute: `execute must take ${Allowed} argument(s)` };

/**
 * Declare a command. Two overloads, `input` required-or-absent.
 * `execute` is a property so extra CommandContext fields are rejected
 * here (methods would compare bivariantly).
 */
export function defineCommand<
  Input extends ObjectWithShape,
  Execute extends (
    ctx: CommandContext,
    input: SchemaOutput<Input & { readonly shape: BoundShape<Input["shape"]> }>,
  ) => MaybePromise<CommandResult>,
>(
  definition: {
    readonly summary: string;
    readonly input: Input & { readonly shape: BoundShape<Input["shape"]> };
    readonly execute: Execute;
  } & ExecuteArity<Execute, 2>,
): CommandWithInput<Input & { readonly shape: BoundShape<Input["shape"]> }>;
export function defineCommand<
  Execute extends (ctx: CommandContext) => MaybePromise<CommandResult>,
>(
  definition: {
    readonly summary: string;
    readonly input?: never;
    readonly execute: Execute;
  } & ExecuteArity<Execute, 0 | 1>,
): CommandWithoutInput;
export function defineCommand(definition: object): AnyCommand {
  const input = (definition as { input?: CommandInputSchema }).input;
  if (input !== undefined) {
    assertCommandInput(input);
  }
  return definition as AnyCommand;
}
