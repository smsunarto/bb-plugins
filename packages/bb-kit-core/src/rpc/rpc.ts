import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { MaybePromise, UnionToIntersection } from "../utils/types.ts";
import { noInputSchema } from "./rpc-standard-schema.ts";
import type {
  SchemaInput,
  SchemaOutput,
  StandardSchemaV1,
  StandardSchemaV1Issue,
} from "./rpc-standard-schema.ts";

export type {
  SchemaInput,
  SchemaOutput,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./rpc-standard-schema.ts";
export { noInputSchema } from "./rpc-standard-schema.ts";

// ── RPC shapes ───────────────────────────────────────────────────────

/**
 * Internal shapes behind the rpc domain (`./rpc`, `./rpc/query`), also
 * deep-imported by `./plugin`'s composition root.
 */

export type ProcedureKind = "query" | "mutation";

/**
 * The precise shape `defineQuery`/`defineMutation` return for an
 * RPC that declares an input. `execute` is method syntax so the
 * concrete shape satisfies `AnyProcedure` bivariantly; the `input`
 * property is REQUIRED here and ABSENT on `ProcedureNoInput` — never
 * optional, which would silently kill input typechecking (§3).
 */
export type ProcedureWithInput<
  K extends ProcedureKind,
  Context,
  In extends StandardSchemaV1,
  Out extends StandardSchemaV1,
> = {
  readonly kind: K;
  readonly input: In;
  readonly output: Out;
  execute(ctx: Context, args: SchemaOutput<In>): MaybePromise<SchemaInput<Out>>;
};

/** The shape for an RPC with no input: no `input` key at all. */
export type ProcedureNoInput<K extends ProcedureKind, Context, Out extends StandardSchemaV1> = {
  readonly kind: K;
  readonly output: Out;
  execute(ctx: Context): MaybePromise<SchemaInput<Out>>;
};

/**
 * What an RPC `execute` receives as `ctx`. Inlined so `rpc/` does
 * not import `plugin/`. Same shape as `Context` from `./plugin`.
 */
type HandlerContext = {
  readonly bb: BbPluginApi;
};

/**
 * The loose shape every concrete RPC satisfies. `execute` is
 * declared in method syntax on purpose: its parameters compare
 * bivariantly, so concrete RPCs with narrower context and input
 * types still satisfy `Record<string, AnyProcedure>` (§3).
 */
export type AnyProcedure = {
  readonly kind: ProcedureKind;
  readonly output: StandardSchemaV1;
  execute(ctx: never, ...rest: never[]): unknown;
};

export type RPCProcedures = Record<string, AnyProcedure>;

/**
 * The runtime view of an RPC — what `createClient` and the entry
 * factory actually call. Reached by one contained cast from the precise
 * generic types; `input` is present exactly when the RPC declares
 * one.
 */
export type RuntimeProcedure = {
  kind: ProcedureKind;
  input?: StandardSchemaV1;
  output: StandardSchemaV1;
  execute: (ctx: unknown, input?: unknown) => unknown;
};

export function runtimeProcedures(procedures: RPCProcedures): Record<string, RuntimeProcedure> {
  return procedures as unknown as Record<string, RuntimeProcedure>;
}

// ── Public RPC API ───────────────────────────────────────────────────

/**
 * The object-only I/O pin (ADR-0014): RPC schemas must be zod-v4
 * object schemas, enforced structurally through zod's `_zod.output`
 * channel. A `z.string()` fails the `defineQuery` constraint with a
 * TS2769 naming this type. Kept separate from `StandardSchemaV1`, which
 * still carries the input/output types.
 */
export interface JSONObjectSchema {
  _zod: { output: Record<string, unknown> };
}

type ObjectSchema = StandardSchemaV1 & JSONObjectSchema;

/**
 * Declare a Query. Two overloads — with-input first — so the
 * returned type carries `input` required-or-absent, never optional
 * (§3). `execute` is a PROPERTY so extra context fields are
 * rejected here. Authors write `async execute(ctx, { keys })`.
 */
export function defineQuery<In extends ObjectSchema, Out extends ObjectSchema>(definition: {
  input: In;
  output: Out;
  execute: (ctx: HandlerContext, args: SchemaOutput<In>) => MaybePromise<SchemaInput<Out>>;
}): ProcedureWithInput<"query", HandlerContext, In, Out>;
export function defineQuery<Out extends ObjectSchema>(definition: {
  output: Out;
  execute: (ctx: HandlerContext) => MaybePromise<SchemaInput<Out>>;
}): ProcedureNoInput<"query", HandlerContext, Out>;
export function defineQuery(definition: object): any {
  return { kind: "query", ...definition };
}

/** Declare a Mutation. Identical shape to `defineQuery` (§3). */
export function defineMutation<In extends ObjectSchema, Out extends ObjectSchema>(definition: {
  input: In;
  output: Out;
  execute: (ctx: HandlerContext, args: SchemaOutput<In>) => MaybePromise<SchemaInput<Out>>;
}): ProcedureWithInput<"mutation", HandlerContext, In, Out>;
export function defineMutation<Out extends ObjectSchema>(definition: {
  output: Out;
  execute: (ctx: HandlerContext) => MaybePromise<SchemaInput<Out>>;
}): ProcedureNoInput<"mutation", HandlerContext, Out>;
export function defineMutation(definition: object): any {
  return { kind: "mutation", ...definition };
}

const PROCEDURE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Validate RPC map keys. Called from `definePlugin` at define time
 * and from `createClient` for the in-process path. "useClient" is the
 * `./rpc/query` escape hatch on the createRPC proxy and "then" is
 * guarded there to keep the client proxy non-thenable — an RPC under
 * either name would be unreachable from app/.
 */
export function assertRPCKeys(procedures: RPCProcedures): void {
  for (const key of Object.keys(procedures)) {
    if (!PROCEDURE_KEY_PATTERN.test(key)) {
      throw new Error(`invalid RPC key "${key}": must match /^[a-z][a-zA-Z0-9]*$/`);
    }
    if (key === "useClient" || key === "then") {
      throw new Error(`"${key}" is a reserved RPC key`);
    }
  }
}

/**
 * The typed client for an RPC map (§3, spec formulation). A
 * caller passes the input schema's INPUT type and receives the output
 * schema's OUTPUT type, the mirror of the execute's view.
 */
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

type ContextDemand<P> = P extends {
  execute(ctx: infer C, ...rest: never[]): unknown;
}
  ? unknown extends C
    ? never // an unannotated execute demands nothing
    : C
  : never;

/**
 * What RPCs collectively demand of the context (§3):
 * the intersection of every annotated first parameter. `defineQuery`
 * / `defineMutation` pin `{ bb }`, so a map of those demands `{ bb }`.
 * An unannotated hand-rolled execute is filtered out; `{}` when
 * nothing demands anything.
 */
export type RPCContext<P extends RPCProcedures> = [ContextDemand<P[keyof P]>] extends [never]
  ? {}
  : UnionToIntersection<ContextDemand<P[keyof P]>>;

/** Thrown by a client call when validation fails on either side. */
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
 * Build the validating in-process client (§3): input is validated
 * before the execute runs (no-input RPCs against the vendored
 * no-input schema), the result after. Both failures throw
 * `RPCValidationError`.
 */
export function createClient<P extends RPCProcedures>(
  procedures: P,
  ctx: RPCContext<P>,
): Client<P> {
  assertRPCKeys(procedures);
  const runtime = runtimeProcedures(procedures);
  const client: Record<string, (input?: unknown) => Promise<unknown>> = {};
  for (const key of Object.keys(runtime)) {
    const procedure = runtime[key];
    if (!procedure) {
      continue;
    }
    client[key] = (input?: unknown) => callProcedure(procedure, ctx, input);
  }
  return client as unknown as Client<P>;
}

async function callProcedure(
  procedure: RuntimeProcedure,
  ctx: unknown,
  input: unknown,
): Promise<unknown> {
  const inputSchema = procedure.input ?? noInputSchema;
  const parsed = await inputSchema["~standard"].validate(input);
  if (parsed.issues) {
    throw new RPCValidationError("input", parsed.issues);
  }
  const raw = procedure.input
    ? await procedure.execute(ctx, parsed.value)
    : await procedure.execute(ctx);
  const validated = await procedure.output["~standard"].validate(raw);
  if (validated.issues) {
    throw new RPCValidationError("output", validated.issues);
  }
  return validated.value;
}
