import type { Command } from "commander";
import type {
  JSONObjectSchema,
  SchemaInput,
  StandardSchemaV1,
  StandardSchemaV1Issue,
} from "../rpc/rpc.ts";

type WithoutUndefined<T> = Exclude<T, undefined>;

/** A Zod v4 field we can brand. bb-kit does not import zod. */
type ZodField = StandardSchemaV1 & { readonly _zod: object };

declare const commandFieldBinding: unique symbol;
// Shared across bun entry bundles (command.js vs plugin.js). A unique Symbol() would not match.
const ARGV_BRAND = Symbol.for("bb-kit.argv");

type FieldHelp = {
  readonly description?: string;
};

type ArgumentBinding = FieldHelp & {
  readonly source: "argument";
  readonly arity: "required";
};

type OptionalArgumentBinding = FieldHelp & {
  readonly source: "argument";
  readonly arity: "optional";
};

type WordsBinding = FieldHelp & {
  readonly source: "argument";
  readonly arity: "rest";
  readonly fallbackOption?: true;
};

type OptionBinding = FieldHelp & {
  readonly source: "option";
  readonly arity: "value";
};

type FlagBinding = FieldHelp & {
  readonly source: "option";
  readonly arity: "flag";
};

export type FieldBinding =
  | ArgumentBinding
  | OptionalArgumentBinding
  | WordsBinding
  | OptionBinding
  | FlagBinding;

export type BoundField<
  Schema extends ZodField = ZodField,
  Binding extends FieldBinding = FieldBinding,
> = Schema & {
  readonly [commandFieldBinding]: Binding;
};

type RequiredStringField<Schema extends ZodField> =
  SchemaInput<Schema> extends string ? unknown : never;

type OptionalStringField<Schema extends ZodField> =
  undefined extends SchemaInput<Schema>
    ? WithoutUndefined<SchemaInput<Schema>> extends string
      ? unknown
      : never
    : never;

type BooleanFlagField<Schema extends ZodField> =
  undefined extends SchemaInput<Schema>
    ? WithoutUndefined<SchemaInput<Schema>> extends boolean
      ? unknown
      : never
    : never;

function bind<Schema extends ZodField, Binding extends FieldBinding>(
  schema: Schema,
  binding: Binding,
): BoundField<Schema, Binding> {
  Object.assign(schema, { [ARGV_BRAND]: binding });
  return schema as BoundField<Schema, Binding>;
}

function argument<Schema extends ZodField>(
  schema: Schema & RequiredStringField<Schema>,
  options?: FieldHelp,
): BoundField<Schema, ArgumentBinding> {
  return bind(schema, { source: "argument", arity: "required", description: options?.description });
}

function optionalArgument<Schema extends ZodField>(
  schema: Schema & OptionalStringField<Schema>,
  options?: FieldHelp,
): BoundField<Schema, OptionalArgumentBinding> {
  return bind(schema, { source: "argument", arity: "optional", description: options?.description });
}

function words<Schema extends ZodField>(
  schema: Schema & RequiredStringField<Schema>,
  options?: FieldHelp & { readonly fallbackOption?: true },
): BoundField<Schema, WordsBinding> {
  return bind(schema, {
    source: "argument",
    arity: "rest",
    description: options?.description,
    ...(options?.fallbackOption === true ? { fallbackOption: true as const } : {}),
  });
}

function option<Schema extends ZodField>(
  schema: Schema & OptionalStringField<Schema>,
  options?: FieldHelp,
): BoundField<Schema, OptionBinding> {
  return bind(schema, { source: "option", arity: "value", description: options?.description });
}

function flag<Schema extends ZodField>(
  schema: Schema & BooleanFlagField<Schema>,
  options?: FieldHelp,
): BoundField<Schema, FlagBinding> {
  return bind(schema, { source: "option", arity: "flag", description: options?.description });
}

export const argv = {
  argument,
  optionalArgument,
  words,
  option,
  flag,
} as const;

export type CommandInputSchema = StandardSchemaV1 &
  JSONObjectSchema & {
    readonly shape: Readonly<Record<string, BoundField>>;
  };

const FIELD_KEY = /^[a-z][a-zA-Z0-9]*$/;

type PlannedField = {
  readonly key: string;
  readonly binding: FieldBinding;
};

function bindingOf(field: unknown): FieldBinding | undefined {
  if (field === null || typeof field !== "object") {
    return undefined;
  }
  return (field as { readonly [ARGV_BRAND]?: FieldBinding })[ARGV_BRAND];
}

function plannedFields(input: CommandInputSchema): PlannedField[] {
  return Object.entries(input.shape).map(([key, field]) => {
    const binding = bindingOf(field);
    if (binding === undefined) {
      throw new Error(`command input field "${key}" is missing an argv binding`);
    }
    if (!FIELD_KEY.test(key)) {
      throw new Error(`command input field "${key}" must be lowerCamelCase`);
    }
    return { key, binding };
  });
}

export function assertCommandInput(input: CommandInputSchema): void {
  const fields = plannedFields(input);
  const restKeys = fields
    .filter((field) => field.binding.arity === "rest")
    .map((field) => field.key);
  if (restKeys.length > 1) {
    throw new Error(`command input allows one words field, found ${restKeys.join(", ")}`);
  }
  const positionals = fields.filter((field) => field.binding.source === "argument");
  const restIndex = positionals.findIndex((field) => field.binding.arity === "rest");
  if (restIndex !== -1 && restIndex !== positionals.length - 1) {
    throw new Error("argv.words must be the last positional field");
  }
}

function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function optionFlag(key: string): string {
  return `--${kebabCase(key)}`;
}

export function declareArgv(command: Command, input: CommandInputSchema): void {
  for (const field of plannedFields(input)) {
    const description = field.binding.description;
    switch (field.binding.arity) {
      case "required":
        command.argument(`<${field.key}>`, description);
        break;
      case "optional":
        command.argument(`[${field.key}]`, description);
        break;
      case "rest":
        command.argument(`[${field.key}...]`, description);
        if (field.binding.fallbackOption === true) {
          command.option(`${optionFlag(field.key)} <value>`, description);
        }
        break;
      case "value":
        command.option(`${optionFlag(field.key)} <value>`, description);
        break;
      case "flag":
        command.option(optionFlag(field.key), description);
        break;
    }
  }
}

function restTokens(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => restTokens(entry));
  }
  return [String(value)];
}

function joinWords(value: unknown): string {
  return restTokens(value).join(" ").trim();
}

export function readArgv(command: Command, input: CommandInputSchema): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  const opts = command.opts() as Record<string, unknown>;
  let positionalIndex = 0;
  for (const field of plannedFields(input)) {
    switch (field.binding.arity) {
      case "required": {
        raw[field.key] = command.processedArgs[positionalIndex];
        positionalIndex += 1;
        break;
      }
      case "optional": {
        const value = command.processedArgs[positionalIndex];
        positionalIndex += 1;
        if (value !== undefined) {
          raw[field.key] = value;
        }
        break;
      }
      case "rest": {
        const joined = joinWords(command.processedArgs[positionalIndex]);
        positionalIndex += 1;
        const fallback =
          field.binding.fallbackOption === true && typeof opts[field.key] === "string"
            ? (opts[field.key] as string)
            : undefined;
        const value = joined !== "" ? joined : fallback;
        if (value !== undefined && value !== "") {
          raw[field.key] = value;
        }
        break;
      }
      case "value": {
        const value = opts[field.key];
        if (value !== undefined) {
          raw[field.key] = value;
        }
        break;
      }
      case "flag": {
        if (opts[field.key] === true) {
          raw[field.key] = true;
        }
        break;
      }
    }
  }
  return raw;
}

function issuePath(issue: StandardSchemaV1Issue): string | undefined {
  if (issue.path === undefined) {
    return undefined;
  }
  const parts = Array.isArray(issue.path) ? issue.path : [issue.path];
  const keys = parts.map((part) =>
    typeof part === "object" && part !== null && "key" in part ? part.key : part,
  );
  return keys.length === 0 ? undefined : keys.map(String).join(".");
}

export function formatArgvIssues(issues: readonly StandardSchemaV1Issue[]): string {
  return `invalid arguments: ${issues
    .map((issue) => {
      const path = issuePath(issue);
      return path === undefined ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ")}`;
}
