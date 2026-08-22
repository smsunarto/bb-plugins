import type { CLICommand, CLIContext, CLIResult } from "./runner.ts";
import { commandDefinitions, runProgram } from "./runner.ts";
import type { UnionToIntersection } from "../internal/types.ts";

/** Public surface of `@bb-kit/core/cli` (§1, §4). */
export { CLIError } from "./runner.ts";
export type { CLIResult, CLIContext } from "./runner.ts";

/**
 * Declare a CLI command. `D` — what the command demands of the client —
 * infers from `run`'s first-parameter annotation; unannotated, it stays
 * `unknown` and the command accepts any client.
 */
export function defineCommand<D = unknown>(command: CLICommand<D>): CLICommand<D> {
  return command;
}

type DependenciesOf<C> = C extends CLICommand<infer D> ? D : never;

/**
 * Tier-1 direct invocation (§4): run commands against explicit
 * dependencies, no host involved. `deps` is the intersection of the
 * commands' declared dependencies, in non-inference position. Never
 * mounts the RPC subtree.
 */
export async function invokeCLI<C extends Record<string, CLICommand<any>>>(
  commands: C,
  deps: UnionToIntersection<DependenciesOf<C[keyof C]>>,
  argv: readonly string[],
  options: { context?: CLIContext; name?: string; summary?: string } = {},
): Promise<CLIResult> {
  const context = options.context ?? {};
  return runProgram(() => commandDefinitions(commands, deps, context), argv, {
    name: options.name,
    summary: options.summary,
  });
}
