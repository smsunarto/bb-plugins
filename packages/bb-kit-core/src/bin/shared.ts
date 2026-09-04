/**
 * Shared bin helpers (§8). `add` and `check` share one name gate and one
 * camelization so rule 1's "camelization of its filename" can never drift
 * from what `add` generates. Path math for the kit tree lives in layout.ts.
 */

import { posix } from "node:path";

/** `add`'s kebab-case gate — also rule 1's basename judgment (§8). */
export const UNIT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * The camelization pin (§3): split on `-`, uppercase the first letter of
 * every segment after the first; a digit-led segment joins unchanged
 * (`read-url` → `readUrl`, `save-2fa` → `save2fa`).
 */
export function camelName(name: string): string {
  const [first = "", ...rest] = name.split("-");
  return first + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

/** What every bin command returns; `bin.ts` writes the streams and exits. */
export type BinResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Strip a leading `./` and POSIX-normalize. `./src/server/server.ts` → `src/server/server.ts`. */
export function pluginRelative(path: string): string {
  return posix.normalize(path.replace(/^\.\//, ""));
}

/** Import specifier from one plugin-relative file to another. */
export function relativeImport(fromFile: string, toFile: string): string {
  const spec = posix.relative(posix.dirname(fromFile), toFile).replace(/\.tsx?$/, "");
  return spec.startsWith(".") ? spec : `./${spec}`;
}

/** Resolve a relative specifier against a plugin-relative file. */
export function resolveImport(fromFile: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(fromFile), specifier));
}
