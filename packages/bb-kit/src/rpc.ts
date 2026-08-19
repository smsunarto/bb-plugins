import type {
  SchemaInput,
  SchemaOutput,
  StandardSchemaV1,
  StandardSchemaV1Issue,
} from "./standard-schema.ts";
import type {
  AnyRPC,
  MaybePromise,
  ProcedureNoInput,
  ProcedureWithInput,
  RPCProcedures,
  RuntimeProcedure,
  UnionToIntersection,
} from "./procedure.ts";
import { runtimeProcedures } from "./procedure.ts";
import { noInputSchema } from "./no-input.ts";
import { wireName } from "./wire-name.ts";

/** Public surface of `@bb-kit/core/rpc` (§1, §3). */
export { wireName } from "./wire-name.ts";
export type { StandardSchemaV1, SchemaInput, SchemaOutput } from "./standard-schema.ts";

/**
 * The object-only I/O pin (ADR-0014): procedure schemas must be zod-v4
 * object schemas, enforced structurally through zod's `_zod.output`
 * channel. A `z.string()` fails the `defineQuery` constraint with a
 * TS2769 naming this type. Kept separate from `StandardSchemaV1`, which
 * still carries the handler I/O types.
 */
export interface JSONObjectSchema {
  _zod: { output: Record<string, unknown> };
}

type ObjectSchema = StandardSchemaV1 & JSONObjectSchema;

/**
 * Declare a read procedure. Two overloads — with-input first — so the
 * returned Procedure carries `input` required-or-absent, never optional
 * (§3). `Context` infers from the handler's first-parameter annotation
 * and stays `unknown` when unannotated.
 */
export function defineQuery<
  Context,
  In extends ObjectSchema,
  Out extends ObjectSchema,
>(definition: {
  input: In;
  output: Out;
  handler(context: Context, input: SchemaOutput<In>): MaybePromise<SchemaInput<Out>>;
}): ProcedureWithInput<"query", Context, In, Out>;
export function defineQuery<Context, Out extends ObjectSchema>(definition: {
  output: Out;
  handler(context: Context): MaybePromise<SchemaInput<Out>>;
}): ProcedureNoInput<"query", Context, Out>;
export function defineQuery(definition: object): any {
  return { kind: "query", ...definition };
}

/** Declare a write procedure. Identical shape to `defineQuery` (§3). */
export function defineMutation<
  Context,
  In extends ObjectSchema,
  Out extends ObjectSchema,
>(definition: {
  input: In;
  output: Out;
  handler(context: Context, input: SchemaOutput<In>): MaybePromise<SchemaInput<Out>>;
}): ProcedureWithInput<"mutation", Context, In, Out>;
export function defineMutation<Context, Out extends ObjectSchema>(definition: {
  output: Out;
  handler(context: Context): MaybePromise<SchemaInput<Out>>;
}): ProcedureNoInput<"mutation", Context, Out>;
export function defineMutation(definition: object): any {
  return { kind: "mutation", ...definition };
}

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PROCEDURE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Compose procedures into a namespaced RPC (§3). Validates the
 * namespace and key patterns and rejects duplicate wire names at define
 * time with a plain Error; the returned value is frozen and the
 * namespace stays literal-typed.
 */
export function defineRPC<N extends string, P extends RPCProcedures>(definition: {
  namespace: N;
  procedures: P;
}): { namespace: N; procedures: P } {
  const { namespace, procedures } = definition;
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`invalid RPC namespace "${namespace}": must match /^[a-z0-9][a-z0-9-]*$/`);
  }
  const seen = new Map<string, string>();
  for (const key of Object.keys(procedures)) {
    if (!PROCEDURE_KEY_PATTERN.test(key)) {
      throw new Error(`invalid procedure key "${key}": must match /^[a-z][a-zA-Z0-9]*$/`);
    }
    // "useClient" is the ./query escape hatch on the createRPC proxy and
    // "then" is guarded there to keep the client proxy non-thenable — a
    // procedure under either name would be unreachable from ui/.
    if (key === "useClient" || key === "then") {
      throw new Error(`"${key}" is a reserved procedure key`);
    }
    const wire = wireName(namespace, key);
    const existing = seen.get(wire);
    if (existing !== undefined) {
      throw new Error(`procedures "${existing}" and "${key}" both derive the wire name "${wire}"`);
    }
    seen.set(wire, key);
  }
  return Object.freeze({
    namespace,
    procedures: Object.freeze({ ...procedures }) as P,
  });
}

/**
 * The typed in-process client for an RPC (§3, spec formulation). A
 * caller passes the input schema's INPUT type and receives the output
 * schema's OUTPUT type — the mirror of the handler's view.
 */
export type ClientFor<R extends AnyRPC> = {
  [K in keyof R["procedures"]]: R["procedures"][K] extends {
    input: infer In extends StandardSchemaV1;
    output: infer Out extends StandardSchemaV1;
  }
    ? (input: SchemaInput<In>) => Promise<SchemaOutput<Out>>
    : R["procedures"][K] extends { output: infer Out extends StandardSchemaV1 }
      ? () => Promise<SchemaOutput<Out>>
      : never;
};

type ContextDemand<P> = P extends {
  handler(context: infer C, ...rest: never[]): unknown;
}
  ? unknown extends C
    ? never // an unannotated handler demands nothing
    : C
  : never;

/**
 * What the RPC's handlers collectively demand of the context (§3):
 * the intersection of every annotated first parameter, `{}` when
 * nothing demands anything (the scaffold's first-compile floor).
 */
export type RPCContext<R extends AnyRPC> = [
  ContextDemand<R["procedures"][keyof R["procedures"]]>,
] extends [never]
  ? {}
  : UnionToIntersection<ContextDemand<R["procedures"][keyof R["procedures"]]>>;

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
 * before the handler runs (no-input procedures against the vendored
 * no-input schema), the result after. Both failures throw
 * `RPCValidationError`.
 */
export function createClient<R extends AnyRPC>(rpc: R, context: RPCContext<R>): ClientFor<R> {
  const procedures = runtimeProcedures(rpc);
  const client: Record<string, (input?: unknown) => Promise<unknown>> = {};
  for (const key of Object.keys(procedures)) {
    const procedure = procedures[key];
    if (!procedure) {
      continue;
    }
    client[key] = (input?: unknown) => callProcedure(procedure, context, input);
  }
  return client as unknown as ClientFor<R>;
}

async function callProcedure(
  procedure: RuntimeProcedure,
  context: unknown,
  input: unknown,
): Promise<unknown> {
  const inputSchema = procedure.input ?? noInputSchema;
  const parsed = await inputSchema["~standard"].validate(input);
  if (parsed.issues) {
    throw new RPCValidationError("input", parsed.issues);
  }
  const raw = procedure.input
    ? await procedure.handler(context, parsed.value)
    : await procedure.handler(context);
  const validated = await procedure.output["~standard"].validate(raw);
  if (validated.issues) {
    throw new RPCValidationError("output", validated.issues);
  }
  return validated.value;
}
