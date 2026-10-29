// Shared contract between the language core (core/), the React renderer (ui/),
// and the server tool (server.ts). Pure data: no React, no DOM, no Node APIs.

import type { ComponentName } from "./catalog";

/** A compile-time or evaluation-time problem, positioned in the UI source. */
export interface Diagnostic {
  severity: "error" | "warning";
  /** 1-based line in the UI source. */
  line: number;
  /** 1-based column in the UI source. */
  column: number;
  message: string;
}

export type Scalar = string | number | boolean | null;

/**
 * Every value the renderer can receive as a component prop. Lambdas passed to
 * `map`/`filter` never reach it; a function given where the catalog takes one
 * (a Scene's `t => ...`, a surface's `f`) arrives as a FunctionValue.
 */
export type Value =
  | Scalar
  | readonly Value[]
  | { readonly [key: string]: Value }
  | UiNode
  | Action
  | Binding
  | FunctionValue;

/**
 * A function the renderer calls (per frame, per surface point). It closes over
 * the state and named values of the evaluation that made it, so a call never
 * re-evaluates the program. Opaque to JSON, markdown and persistence.
 */
export interface FunctionValue {
  readonly kind: "function";
  readonly params: readonly string[];
  /** Runs the function with a fresh step budget (LIMITS.functionSteps). Never throws. */
  call(args: readonly Value[]): { readonly value: Value; readonly error: string | null };
}

export function isFunctionValue(value: unknown): value is FunctionValue {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "function" && "call" in value && typeof value.call === "function";
}

/**
 * One evaluated catalog component. `props` are keyed by the catalog param
 * name; omitted optional params are absent (never `undefined` values).
 * `nodes` params arrive normalized as `UiNode[]`, `actions` params as
 * `Action[]`, and `binding` params as a `Binding`. A Table, Chart or Metric
 * without `source` whose data came from Load also has `loadedFrom: string[]`,
 * the paths in the order its arguments reach them.
 */
export interface ComponentNode {
  readonly kind: "node";
  readonly type: ComponentName;
  /**
   * Stable across re-evaluations of the same program so React keeps
   * component identity: derived from the source position and list index.
   */
  readonly key: string;
  readonly props: Readonly<Record<string, Value>>;
}

/** A component that failed to evaluate: an error line renders in its place. */
export interface ErrorNode {
  readonly kind: "node";
  readonly type: "Error";
  readonly key: string;
  readonly props: Readonly<Record<string, Value>> & { readonly message: string };
}

/** A component waiting for a file it reads with Load; `component` is null for a bare expression. */
export interface LoadingNode {
  readonly kind: "node";
  readonly type: "Loading";
  readonly key: string;
  readonly props: Readonly<Record<string, Value>> & { readonly path: string; readonly component: ComponentName | null };
}

/** What a UI evaluates to: catalog components, with Error and Loading nodes standing in where one could not. */
export type UiNode = ComponentNode | ErrorNode | LoadingNode;

/** A two-way binding to one `$state` variable. `name` excludes the `$`. */
export interface Binding {
  readonly kind: "binding";
  readonly name: string;
  readonly value: Value;
}

/** Side effects a button can trigger. Evaluated at render time. */
export type Action =
  | { readonly kind: "action"; readonly type: "send"; readonly text: string }
  | {
      readonly kind: "action";
      readonly type: "set";
      /** State name without the `$`. */
      readonly name: string;
      readonly value: Value;
    }
  | { readonly kind: "action"; readonly type: "openUrl"; readonly url: string }
  | { readonly kind: "action"; readonly type: "copy"; readonly text: string };

/** Mutable state of one rendered UI: `$name` → value (keys exclude the `$`). */
export type UiState = Readonly<Record<string, Value>>;
