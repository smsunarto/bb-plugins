import type { ExecFileOptions } from "node:child_process";
import type { BigIntStats, MakeDirectoryOptions, Stats } from "node:fs";
import { type HostRoute, invokeHost } from "./client.ts";
import { commandRoute } from "./pull-request.ts";

/**
 * Host `fs` module (design §3.1): the `node:fs` and `execFile` calls
 * `local-data.ts` makes, with the same signatures, run on the host that owns
 * the path. `watch` is the `fs.watch` replacement over host signals.
 */
export { watch } from "./watch.ts";

const on = (target: string): HostRoute => ({ rootPath: target });

/** The host's `serializeStats` record (`src/host/lib/host-fs.ts`): numeric fields plus kind predicates. */
type WireStats = {
  fields: Record<string, number | bigint>;
  kinds: Record<string, boolean>;
};

/** A host `Stats` record with its methods and Date fields back. */
export function rehydrateStats(wire: WireStats): Stats & BigIntStats {
  const stats: Record<string, unknown> = { ...wire.fields };
  for (const name of ["atime", "mtime", "ctime", "birthtime"]) {
    const ms = wire.fields[`${name}Ms`];
    // node:fs rounds fractional milliseconds the same way.
    if (ms !== undefined) stats[name] = new Date(Math.round(Number(ms)));
  }
  for (const [kind, value] of Object.entries(wire.kinds)) stats[kind] = () => value;
  return stats as unknown as Stats & BigIntStats;
}

export async function realpath(target: string): Promise<string> {
  return (await invokeHost("fs", "realpath", [target], on(target))) as string;
}

export function stat(target: string): Promise<Stats>;
export function stat(target: string, options: { bigint: true }): Promise<BigIntStats>;
export function stat(target: string, options?: { bigint?: boolean }): Promise<Stats | BigIntStats>;
export async function stat(target: string, options?: { bigint?: boolean }) {
  return rehydrateStats(
    (await invokeHost("fs", "stat", [target, options ?? {}], on(target))) as WireStats,
  );
}

export function lstat(target: string): Promise<Stats>;
export function lstat(target: string, options: { bigint: true }): Promise<BigIntStats>;
export function lstat(target: string, options?: { bigint?: boolean }): Promise<Stats | BigIntStats>;
export async function lstat(target: string, options?: { bigint?: boolean }) {
  return rehydrateStats(
    (await invokeHost("fs", "lstat", [target, options ?? {}], on(target))) as WireStats,
  );
}

export function readFile(target: string): Promise<Buffer>;
export function readFile(target: string, encoding: BufferEncoding): Promise<string>;
export async function readFile(
  target: string,
  encoding?: BufferEncoding,
): Promise<string | Buffer> {
  const value = await invokeHost("fs", "readFile", [target, encoding ?? null], on(target));
  return typeof value === "string" ? value : Buffer.from(value as Uint8Array);
}

export async function readlink(target: string): Promise<string> {
  return (await invokeHost("fs", "readlink", [target], on(target))) as string;
}

export async function writeFile(
  target: string,
  data: string | Uint8Array,
  options?: { mode?: number; encoding?: BufferEncoding },
): Promise<void> {
  await invokeHost("fs", "writeFile", [target, data, options ?? {}], on(target));
}

export async function mkdir(
  target: string,
  options?: MakeDirectoryOptions,
): Promise<string | undefined> {
  const value = await invokeHost(
    "fs",
    "mkdir",
    [target, { recursive: options?.recursive, mode: options?.mode }],
    on(target),
  );
  return (value as string | null | undefined) ?? undefined;
}

/** How long a memoized `exists` answer is reused. */
export const EXISTS_TTL_MS = 3_000;

/**
 * Memoized `exists` answers, kept while an engine runs (`memoizeExists`).
 * Every `exists` caller in local-data.ts checks a repository root, and the
 * store's 1 Hz worktree refresh asks for each session's root. Without the
 * memo each ask is a host RPC. The cost: a removed checkout shows up to 3 s
 * late. Off by default, so specs that move a checkout see the move at once.
 */
let answers: Map<string, { at: number; answer: Promise<boolean> }> | undefined;

/** Reuse repository-root answers for `EXISTS_TTL_MS`. Returns the off switch. */
export function memoizeExists(): () => void {
  const mine = new Map<string, { at: number; answer: Promise<boolean> }>();
  answers = mine;
  return () => {
    if (answers === mine) answers = undefined;
  };
}

/** Drop memoized answers: a repository was registered or rebound, or a host worker exited. */
export function forgetExists(): void {
  answers?.clear();
}

/** `existsSync` on the host; async because the path may live on another machine. */
export function exists(target: string): Promise<boolean> {
  const memo = answers;
  const ask = async () => (await invokeHost("fs", "exists", [target], on(target))) as boolean;
  if (!memo) return ask();
  const now = Date.now();
  const cached = memo.get(target);
  if (cached && now - cached.at < EXISTS_TTL_MS) return cached.answer;
  const answer = ask();
  memo.set(target, { at: now, answer });
  // A failed ask is not an answer: the next call asks again.
  answer.catch(() => {
    if (memo.get(target)?.answer === answer) memo.delete(target);
  });
  return answer;
}

/** `promisify(execFile)` on the host that owns `options.cwd` or the `-C`/`--git-dir` path. */
export async function execFile(
  file: string,
  args: readonly string[],
  options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const cwd = typeof options?.cwd === "string" ? options.cwd : undefined;
  return (await invokeHost(
    "fs",
    "execFile",
    [file, args, { cwd, timeout: options?.timeout, maxBuffer: options?.maxBuffer }],
    commandRoute(args, cwd),
    {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.timeout ? { timeoutMs: options.timeout + 5_000 } : {}),
    },
  )) as { stdout: string; stderr: string };
}

/** Preserve upstream atomic/private workspace writes on the checkout host. */
export async function writePrivateJsonAtomic<T>(target: string, value: T): Promise<void> {
  await invokeHost("fs", "writePrivateJsonAtomic", [target, value], on(target));
}
