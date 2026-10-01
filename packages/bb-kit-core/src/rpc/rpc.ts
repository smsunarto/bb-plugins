import type {
  StandardSchemaV1,
  StandardSchemaV1InferInput,
  StandardSchemaV1InferOutput,
  StandardSchemaV1Issue,
} from "@get-bb/plugin-sdk";
import type { Context } from "../context.ts";
import { RESERVED_RPC_KEYS, RPC_KEY_PATTERN } from "../names/names.ts";
import type { ContextDemand, MaybePromise, UnionToIntersection } from "../utils/types.ts";

export type { StandardSchemaV1, StandardSchemaV1Issue } from "@get-bb/plugin-sdk";
export type { Context } from "../context.ts";

/** What a caller passes: the schema's input type. */
export type SchemaInput<S extends StandardSchemaV1> = StandardSchemaV1InferInput<S>;
/** What validation produces: the schema's output type. */
export type SchemaOutput<S extends StandardSchemaV1> = StandardSchemaV1InferOutput<S>;

/**
 * Registered with the host for RPCs that declare no `input`. It accepts
 * null (what the SDK hooks and fake host deliver) and undefined (an
 * empty POST body), and rejects everything else.
 */
export const noInputSchema: StandardSchemaV1<null | undefined, null | undefined> = {
  "~standard": {
    version: 1,
    vendor: "bb-kit",
    validate(value) {
      if (value === null || value === undefined) {
        return { value };
      }
      return { issues: [{ message: "this RPC takes no input" }] };
    },
    jsonSchema: {
      input: () => ({ type: "null" }),
      output: () => ({ type: "null" }),
    },
  },
};

export type ProcedureKind = "query" | "mutation";

/**
 * What `defineQuery`/`defineMutation` return for an RPC that declares
 * an input. `input` is REQUIRED here and ABSENT on `ProcedureNoInput`,
 * never optional, which would silently drop input typechecking.
 * `execute` is method syntax so concrete RPCs assign to `AnyProcedure`
 * bivariantly.
 */
export type ProcedureWithInput<
  K extends ProcedureKind,
  C,
  In extends StandardSchemaV1,
  Out extends StandardSchemaV1,
> = {
  readonly kind: K;
  readonly description?: string;
  readonly input: In;
  readonly output: Out;
  execute(ctx: C, args: SchemaOutput<In>): MaybePromise<SchemaInput<Out>>;
};

export type ProcedureNoInput<K extends ProcedureKind, C, Out extends StandardSchemaV1> = {
  readonly kind: K;
  readonly description?: string;
  readonly output: Out;
  execute(ctx: C): MaybePromise<SchemaInput<Out>>;
};

/** The loose shape every concrete RPC satisfies. */
export type AnyProcedure = {
  readonly kind: ProcedureKind;
  readonly output: StandardSchemaV1;
  execute(ctx: never, ...rest: never[]): unknown;
};

export type RPCProcedures = Record<string, AnyProcedure>;

/** The runtime view the composition root calls. */
export type RuntimeProcedure = {
  kind: ProcedureKind;
  description?: string;
  input?: StandardSchemaV1;
  output: StandardSchemaV1;
  execute: (ctx: unknown, input?: unknown) => unknown;
};

/**
 * RPC schemas must be zod v4 object schemas, enforced through zod's
 * `_zod.output` channel: RPC input and output are JSON objects.
 */
export interface JSONObjectSchema {
  _zod: { output: Record<string, unknown> };
}

type ObjectSchema = StandardSchemaV1 & JSONObjectSchema;

/**
 * Declare a Query. `ctx` is `Context` unless `execute` annotates its
 * first parameter with a `Context<Services>`; `definePlugin` then checks
 * that its `services` provide what every handler demands.
 */
export function defineQuery<
  In extends ObjectSchema,
  Out extends ObjectSchema,
  C extends Context = Context,
>(definition: {
  input: In;
  output: Out;
  /** Published as the method description when the plugin opts into discoverable RPC. */
  description?: string;
  execute: (ctx: C, args: SchemaOutput<In>) => MaybePromise<SchemaInput<Out>>;
}): ProcedureWithInput<"query", C, In, Out>;
export function defineQuery<Out extends ObjectSchema, C extends Context = Context>(definition: {
  output: Out;
  description?: string;
  execute: (ctx: C) => MaybePromise<SchemaInput<Out>>;
}): ProcedureNoInput<"query", C, Out>;
export function defineQuery(definition: object): AnyProcedure {
  return { kind: "query", ...definition } as AnyProcedure;
}

/** Declare a Mutation. Same shape as `defineQuery`. */
export function defineMutation<
  In extends ObjectSchema,
  Out extends ObjectSchema,
  C extends Context = Context,
>(definition: {
  input: In;
  output: Out;
  description?: string;
  execute: (ctx: C, args: SchemaOutput<In>) => MaybePromise<SchemaInput<Out>>;
}): ProcedureWithInput<"mutation", C, In, Out>;
export function defineMutation<Out extends ObjectSchema, C extends Context = Context>(definition: {
  output: Out;
  description?: string;
  execute: (ctx: C) => MaybePromise<SchemaInput<Out>>;
}): ProcedureNoInput<"mutation", C, Out>;
export function defineMutation(definition: object): AnyProcedure {
  return { kind: "mutation", ...definition } as AnyProcedure;
}

export function assertRPCKeys(procedures: RPCProcedures): void {
  for (const key of Object.keys(procedures)) {
    if (!RPC_KEY_PATTERN.test(key)) {
      throw new Error(`invalid RPC key "${key}": must match ${RPC_KEY_PATTERN}`);
    }
    if (RESERVED_RPC_KEYS.includes(key)) {
      throw new Error(`"${key}" is a reserved RPC key`);
    }
  }
}

/** The typed client for an RPC map: schema input in, schema output out. */
export type Client<P extends RPCProcedures> = {
  [K in keyof P]: P[K] extends {
    input: infer In extends StandardSchemaV1;
    output: infer Out extends StandardSchemaV1;
  }
    ? (input: SchemaInput<In>) => Promise<SchemaOutput<Out>>
    : P[K] extends { output: infer Out extends StandardSchemaV1 }
      ? () => Promise<SchemaOutput<Out>>
      : never;
};

/** What an RPC map collectively demands of `ctx`. */
export type RPCContext<P extends RPCProcedures> = UnionToIntersection<ContextDemand<P[keyof P]>>;

/** Thrown by an in-process call when validation fails on either side. */
export class RPCValidationError extends Error {
  readonly stage: "input" | "output";
  readonly issues: readonly StandardSchemaV1Issue[];
  constructor(stage: "input" | "output", issues: readonly StandardSchemaV1Issue[]) {
    super(`invalid ${stage}: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "RPCValidationError";
    this.stage = stage;
    this.issues = issues;
  }
}

/**
 * Call one RPC in-process with host semantics: input is validated before
 * `execute` runs, the result after. Both failures throw
 * `RPCValidationError`.
 */
export async function callProcedure(
  procedure: AnyProcedure,
  ctx: unknown,
  input: unknown,
): Promise<unknown> {
  const runtime = procedure as unknown as RuntimeProcedure;
  const parsed = await (runtime.input ?? noInputSchema)["~standard"].validate(input);
  if (parsed.issues) {
    throw new RPCValidationError("input", parsed.issues);
  }
  const raw = runtime.input ? await runtime.execute(ctx, parsed.value) : await runtime.execute(ctx);
  const validated = await runtime.output["~standard"].validate(raw);
  if (validated.issues) {
    throw new RPCValidationError("output", validated.issues);
  }
  return validated.value;
}
