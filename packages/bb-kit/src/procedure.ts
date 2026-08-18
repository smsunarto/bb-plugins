import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from "./standard-schema.ts";

/**
 * Internal shapes shared by `./rpc`, `./cli`, and `./plugin`. Not a
 * public subpath: the exports map blocks deep imports, so nothing here
 * is API.
 */

export type MaybePromise<T> = T | Promise<T>;

export type ProcedureKind = "query" | "mutation";

/**
 * The precise shape `defineQuery`/`defineMutation` return for a
 * procedure that declares an input. `handler` is method syntax so the
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
  handler(context: Context, input: SchemaOutput<In>): MaybePromise<SchemaInput<Out>>;
};

/** The shape for a procedure with no input: no `input` key at all. */
export type ProcedureNoInput<
  K extends ProcedureKind,
  Context,
  Out extends StandardSchemaV1,
> = {
  readonly kind: K;
  readonly output: Out;
  handler(context: Context): MaybePromise<SchemaInput<Out>>;
};

/**
 * The loose shape every concrete Procedure satisfies. `handler` is
 * declared in method syntax on purpose: its parameters compare
 * bivariantly, so concrete procedures with narrower context and input
 * types still satisfy `Record<string, AnyProcedure>` (§3).
 */
export type AnyProcedure = {
  readonly kind: ProcedureKind;
  readonly output: StandardSchemaV1;
  handler(context: never, ...rest: never[]): unknown;
};

export type RPCProcedures = Record<string, AnyProcedure>;

/** The shape `defineRPC` produces; `definePlugin`'s `rpc` constraint. */
export type AnyRPC = {
  namespace: string;
  procedures: RPCProcedures;
};

/**
 * The runtime view of a procedure — what `createClient` and the entry
 * factory actually call. Reached by one contained cast from the precise
 * generic types; `input` is present exactly when the procedure declares
 * one.
 */
export type RuntimeProcedure = {
  kind: ProcedureKind;
  input?: StandardSchemaV1;
  output: StandardSchemaV1;
  handler: (context: unknown, input?: unknown) => unknown;
};

export function runtimeProcedures(rpc: AnyRPC): Record<string, RuntimeProcedure> {
  return rpc.procedures as unknown as Record<string, RuntimeProcedure>;
}

/** `A | B` → `A & B`. One private helper, shared by `./rpc` and `./cli`. */
export type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;
