/** Type helpers shared by `rpc/`, `command/`, `tools/`, and `plugin/`. Not public API. */

export type MaybePromise<T> = T | Promise<T>;

/** `A | B` → `A & B`. */
export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/** The `ctx` type a unit's `execute` declares. */
export type ContextDemand<Unit> = Unit extends {
  execute(ctx: infer C, ...rest: never[]): unknown;
}
  ? C
  : never;
