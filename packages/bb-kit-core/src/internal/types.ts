/**
 * Type helpers shared across domains — the only module under
 * `internal/`. Everything here is imported by more than one of `rpc/`,
 * `cli/`, and `plugin/`; none of it is public API (the exports map
 * blocks deep imports).
 */

export type MaybePromise<T> = T | Promise<T>;

/** `A | B` → `A & B`. Shared by `./rpc` and `./cli`. */
export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;
