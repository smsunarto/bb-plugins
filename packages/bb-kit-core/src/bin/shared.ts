/**
 * Shared bin helpers (§7). `add` and `check` share one name gate and one
 * camelization so rule 1's "camelization of its filename" can never drift
 * from what `add` generates. Path math follows `bb.server`, so a nested
 * composition root (`server/server.ts`) and a root one (`server.ts`)
 * both typecheck the same wiring rules. Unit directories sit beside
 * that file (`server/rpc`, or `rpc` when `bb.server` is at the root).
 */

import { posix } from "node:path";

/** `add`'s kebab-case gate — also rule 1's basename judgment (§7). */
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

/** Strip a leading `./` and POSIX-normalize. `./server/server.ts` → `server/server.ts`. */
export function pluginRelative(path: string): string {
  return posix.normalize(path.replace(/^\.\//, ""));
}

/** `bb.server` as a plugin-root-relative file, or undefined if the manifest lacks it. */
export function compositionRootFromPkg(
  pkg: Record<string, unknown> | undefined,
): string | undefined {
  const bb = pkg?.["bb"];
  if (bb === undefined || bb === null || typeof bb !== "object" || Array.isArray(bb)) {
    return undefined;
  }
  const server = (bb as Record<string, unknown>)["server"];
  if (typeof server !== "string" || server === "") {
    return undefined;
  }
  return pluginRelative(server);
}

/** Import specifier from one plugin-relative file to another. */
export function relativeImport(fromFile: string, toFile: string): string {
  const spec = posix.relative(posix.dirname(fromFile), toFile);
  return spec.startsWith(".") ? spec : `./${spec}`;
}

/** Resolve a relative specifier against a plugin-relative file. */
export function resolveImport(fromFile: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(fromFile), specifier));
}

/**
 * Unit directory beside the composition root. `server/server.ts` →
 * `server/rpc`; a root `server.ts` → `rpc`.
 */
export function unitDir(compositionRoot: string, kind: "rpc" | "cli" | "tools"): string {
  const dir = posix.dirname(compositionRoot);
  return dir === "." ? kind : posix.join(dir, kind);
}
