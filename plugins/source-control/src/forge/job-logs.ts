/**
 * The end of failed GitHub Actions jobs' logs, for the Fix checks prompt.
 * Ported from code-review (`src/server/lib/checks.ts`). Exec-injected and
 * Effect-free, like `github.ts`.
 */
import { LOG_CHARS, MISSING_CHARS } from "../core/fix-checks.ts";
import type { Repo } from "../core/ids.ts";
import { classifyFailure, type Exec } from "./github.ts";

/** Enough to show the failure, short enough to read in the composer before sending. */
export const LOG_LINES = 60;

/* Actions log lines start with a timestamp, and some carry ANSI colour. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
/**
 * Every terminal escape sequence (CSI such as colour, OSC such as links) and
 * any other control character but tab: the tail goes into a prompt, not a terminal.
 */
const ESCAPES =
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B.?|[\u0000-\u0008\u000B-\u001F\u007F]/g;
/** Newer gh will not print a body with escape sequences unless asked to. */
const ESCAPE_REFUSAL = /--allow-escape-sequences/;

/**
 * The end of a failed job's log, where the error is. The log runs on past
 * the failure into post-job cleanup, so it is cut after the last
 * `##[error]` line before the tail is taken.
 */
export function logTail(log: string, lines = LOG_LINES): string {
  const all = log
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(TIMESTAMP, "").replace(ESCAPES, "").trimEnd());
  const lastError = all.findLastIndex((line) => line.includes("##[error]"));
  const upToFailure = lastError === -1 ? all : all.slice(0, lastError + 1);
  return upToFailure.slice(-lines).join("\n").trim().slice(-LOG_CHARS);
}

/** An Actions job's id from its check's URL (`…/actions/runs/1/job/2`); null for any other check. */
export function jobIdOf(url: string | null): number | null {
  const match = url ? /\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export type JobLog = { jobId: number; text: string | null; missing: string | null };

/** Each job's log tail, or why it is missing. One job's failure does not fail the others. */
export async function readJobLogs(
  exec: Exec,
  repo: Repo,
  jobIds: readonly number[],
  signal?: AbortSignal,
): Promise<JobLog[]> {
  return Promise.all(
    jobIds.map(async (jobId): Promise<JobLog> => {
      // REST, not `gh run view --log-failed`, which prints nothing for current Actions logs.
      const args = ["api", `repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}/logs`];
      let result = await exec(args, { signal });
      // Asked for only when gh refuses, since an older gh does not know the flag.
      if (result.code !== 0 && ESCAPE_REFUSAL.test(result.stderr))
        result = await exec([...args, "--allow-escape-sequences"], { signal });
      if (result.code !== 0)
        return {
          jobId,
          text: null,
          missing: classifyFailure(result).message.slice(0, MISSING_CHARS),
        };
      return { jobId, text: logTail(result.stdout), missing: null };
    }),
  );
}
