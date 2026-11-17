import type { PluginCliResult } from "@get-bb/plugin-sdk";

/** Why a command or item was refused, and the command that clears it. */
export type Blocker = { reason: string; fix: string };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** One result row: the same `id` leads the text line and the JSON object. */
export type Item = {
  id: string;
  ok: boolean;
  state: string;
  /** Columns between `id` and `state`, such as `thr_abc  Implement`. */
  lead?: string;
  /** The rest of the text line after `id  state`. */
  detail?: string;
  data?: Record<string, Json>;
  blockers?: Blocker[];
};

/**
 * Text is one line per item, ids first; notes go to stderr. `--json` is one
 * compact object. Exit 0 when every item succeeded, 1 when none did, 3 when
 * some failed.
 */
export function render(
  items: readonly Item[],
  json: boolean,
  notes: readonly string[] = [],
): PluginCliResult {
  const okCount = items.filter((item) => item.ok).length;
  const exitCode = okCount === items.length ? 0 : okCount === 0 ? 1 : 3;
  const stderr = notes.length > 0 ? `${notes.join("\n")}\n` : undefined;
  if (json) {
    const results = items.map((item) => ({
      id: item.id,
      ok: item.ok,
      state: item.state,
      ...item.data,
      ...(item.blockers === undefined ? {} : { blockers: item.blockers }),
    }));
    return {
      exitCode,
      stdout: `${JSON.stringify({ ok: exitCode === 0, results })}\n`,
      ...(stderr ? { stderr } : {}),
    };
  }
  const lines = items.flatMap((item) => {
    const head = [item.id, item.lead, item.state, item.detail].filter(Boolean).join("  ");
    if (item.blockers === undefined || item.blockers.length === 0) return [head];
    return item.blockers.map((blocker) => `${head}  ${blocker.reason}; fix: ${blocker.fix}`);
  });
  return { exitCode, stdout: `${lines.join("\n")}\n`, ...(stderr ? { stderr } : {}) };
}

/** A whole-command refusal that names every blocker at once. Nothing was changed. */
export function refuse(
  command: string,
  blockers: readonly Blocker[],
  json: boolean,
): PluginCliResult {
  const message = `${command} refused: ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`;
  const text = [message, ...blockers.map((b) => `  ${b.reason}; fix: ${b.fix}`)].join("\n");
  if (!json) return { exitCode: 1, stderr: `${text}\n` };
  const error = { code: "refused", message, hint: blockers[0]?.fix ?? "" };
  return {
    exitCode: 1,
    stdout: `${JSON.stringify({ ok: false, error, blockers })}\n`,
    stderr: `${text}\n`,
  };
}

/** A refusal raised from deep in a command, caught by `guard`. */
export class Refusal extends Error {
  readonly blockers: Blocker[];
  constructor(blockers: Blocker[]) {
    super(blockers.map((blocker) => blocker.reason).join("; "));
    this.blockers = blockers;
  }
}

export async function guard(
  command: string,
  json: boolean,
  run: () => Promise<PluginCliResult>,
): Promise<PluginCliResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Refusal) return refuse(command, error.blockers, json);
    throw error;
  }
}
