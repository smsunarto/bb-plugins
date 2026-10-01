import { execFile as execFileCallback } from "node:child_process";
import { existsSync, type BigIntStats, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";

/**
 * The host `fs` module (design §3.1): the `node:fs` and `execFile` calls the
 * engine makes on checkout paths, run on the machine that owns the checkout.
 * Arguments and results are wire values, so `Stats` travel as plain records
 * (`serializeStats`) and the server facade gives them their methods back.
 */

const STAT_KINDS = [
  "isFile",
  "isDirectory",
  "isSymbolicLink",
  "isFIFO",
  "isSocket",
  "isBlockDevice",
  "isCharacterDevice",
] as const;

export type StatKind = (typeof STAT_KINDS)[number];

/** A `Stats` or `BigIntStats` as a wire record: numeric fields plus the kind predicates. */
export type WireStats = {
  fields: Record<string, number | bigint>;
  kinds: Record<StatKind, boolean>;
};

export function serializeStats(stats: Stats | BigIntStats): WireStats {
  const fields: Record<string, number | bigint> = {};
  for (const [key, value] of Object.entries(stats)) {
    if (typeof value === "number" || typeof value === "bigint") fields[key] = value;
  }
  const kinds = Object.fromEntries(STAT_KINDS.map((kind) => [kind, stats[kind]()])) as Record<
    StatKind,
    boolean
  >;
  return { fields, kinds };
}

type StatOptions = { bigint?: boolean };
type ExecOptions = { cwd?: string; timeout?: number; maxBuffer?: number };

const execFileAsync = promisify(execFileCallback);

export const hostFs = {
  realpath: (target: string) => fs.realpath(target),
  stat: async (target: string, options?: StatOptions) =>
    serializeStats(await fs.stat(target, { bigint: options?.bigint === true })),
  lstat: async (target: string, options?: StatOptions) =>
    serializeStats(await fs.lstat(target, { bigint: options?.bigint === true })),
  readFile: (target: string, encoding?: BufferEncoding | null) =>
    encoding ? fs.readFile(target, encoding) : fs.readFile(target),
  readlink: (target: string) => fs.readlink(target),
  writeFile: (
    target: string,
    data: string | Uint8Array,
    options?: { mode?: number; encoding?: BufferEncoding },
  ) => fs.writeFile(target, data, options),
  mkdir: (target: string, options?: { recursive?: boolean; mode?: number }) =>
    fs.mkdir(target, options),
  exists: async (target: string) => existsSync(target),
  execFile: async (
    file: string,
    args: readonly string[],
    options: ExecOptions | undefined,
    signal: AbortSignal,
  ) => {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options?.cwd,
      timeout: options?.timeout,
      maxBuffer: options?.maxBuffer ?? 64 * 1024 * 1024,
      encoding: "utf8",
      signal,
      windowsHide: true,
    });
    return { stdout, stderr };
  },
};
