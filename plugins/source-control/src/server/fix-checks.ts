/**
 * Fix checks: the prompt a new thread opens with to fix a pull request's
 * failing checks, and starting that thread. Ported from code-review
 * (`src/server/rpc/fix-checks-prompt.ts`, `start-fix.ts`).
 *
 * The prompt is built from the checks bb last read for the Change, only
 * while they are on the head the reader saw, with the end of up to three
 * failed Actions jobs' logs read from GitHub. Starting the thread is never
 * retried: a second try could start a second thread.
 */
import { instructionFiles } from "@bb-plugins/instructions";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Effect } from "effect";
import { describeProblem, type CheckRow, type PullRequest } from "../core/change.ts";
import { checkId, MAX_LOGS, type NewThreadRequestInput } from "../core/fix-checks.ts";
import type { ChangeKey, Repo } from "../core/ids.ts";
import { parseChangeKey } from "../core/review.ts";
import { jobIdOf, type JobLog } from "../forge/job-logs.ts";
import type { ForgeSites } from "./forge-sites.ts";
import { localMatch } from "./review-change.ts";
import { fenced, inlineCode, projectFor, quote } from "./review-start.ts";
import type { Store } from "./store.ts";

const files = instructionFiles(import.meta.url);

type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

/** A new worktree of the project, so the fix never moves anyone's checkout. */
export type FixEnvironment = {
  type: "host";
  hostId?: string;
  workspace: { type: "managed-worktree"; baseBranch: { kind: "default" } };
};

export type FixPrompt =
  | { ok: true; prompt: string; projectId: string | null; environment: FixEnvironment | null }
  | { ok: false; message: string };

type Log = { text: string } | { missing: string };
type FailedCheck = { check: CheckRow; log: Log };

function checkSection({ check, log }: FailedCheck): string {
  const lines = [`### ${check.workflow ? `${check.workflow} / ` : ""}${check.name}`];
  if (check.url) lines.push("", check.url);
  lines.push("", "text" in log ? fenced(log.text, "text") : `No log: ${log.missing}`);
  return lines.join("\n");
}

/** The prompt: the pull request, how to branch from its head, and each check with its log. */
export function fixChecksPrompt(
  pr: Pick<PullRequest, "number" | "title" | "url" | "headRefOid">,
  repo: Repo,
  branch: string,
  checks: readonly FailedCheck[],
): string {
  const fixBranch = `source-control/fix-${pr.number}-${pr.headRefOid.slice(0, 7)}`;
  return files.read("fix-checks", {
    owner: repo.owner,
    repo: repo.name,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: inlineCode(branch),
    headRefOid: pr.headRefOid,
    fixBranch: inlineCode(fixBranch),
    checkout: fenced(
      [
        `git fetch origin 'pull/${pr.number}/head'`,
        `git switch -c ${quote(fixBranch)} FETCH_HEAD`,
      ].join("\n"),
    ),
    checks: checks.map(checkSection).join("\n\n"),
  });
}

/** Each selected check's log: the tail read, or why there is none. */
function logOf(
  check: CheckRow,
  asked: readonly number[],
  read: Map<number, JobLog>,
  failure: string | null,
): Log {
  if (check.outcome !== "failed") return { missing: `the check is ${check.outcome}.` };
  const jobId = jobIdOf(check.url);
  if (jobId === null) return { missing: "not a GitHub Actions job." };
  if (!asked.includes(jobId)) return { missing: "not fetched; open the URL." };
  if (failure !== null) return { missing: failure };
  const log = read.get(jobId);
  if (!log) return { missing: "GitHub sent no log." };
  return log.text !== null ? { text: log.text } : { missing: log.missing ?? "GitHub sent no log." };
}

export function createFixChecks(deps: { bb: BbPluginApi; store: Store; sites: ForgeSites }) {
  const { bb, store } = deps;

  /** The pull request and checks bb last read, if they are still on `head`. */
  const current = (key: ChangeKey, head: string) => {
    const parsed = parseChangeKey(key);
    if (parsed?.kind !== "gh") return "This Change has no pull request.";
    const pr = store.forge(key).read?.value ?? null;
    const checks = store.checks(key).read?.value ?? null;
    if (!pr || !checks) return "bb has not read this pull request's checks yet.";
    if (pr.headRefOid !== head || checks.head !== head)
      return "The pull request has a new head since you looked. Its checks are those of the new head.";
    return { parsed, pr, checks };
  };

  return {
    prompt: (key: ChangeKey, head: string, ids: readonly string[]) =>
      Effect.gen(function* () {
        const now = current(key, head);
        if (typeof now === "string") return { ok: false, message: now } satisfies FixPrompt;
        const wanted = new Set(ids);
        const selected = now.checks.rows.filter((row) => wanted.has(checkId(row)));
        if (selected.length === 0)
          return {
            ok: false,
            message: "Those checks are no longer on the latest commit. Refresh and try again.",
          } satisfies FixPrompt;
        const jobIds = selected
          .filter((row) => row.outcome === "failed")
          .flatMap((row) => jobIdOf(row.url) ?? [])
          .slice(0, MAX_LOGS);
        const placement = localMatch(store, key)?.placement;
        const answer =
          jobIds.length > 0
            ? yield* deps.sites
                .jobLogs({ repo: now.parsed.repo, jobIds }, placement ? [placement] : [])
                .pipe(Effect.result)
            : null;
        const read = new Map(
          answer?._tag === "Success" ? answer.success.map((log) => [log.jobId, log]) : [],
        );
        const failure = answer?._tag === "Failure" ? describeProblem(answer.failure.problem) : null;
        const project = yield* Effect.tryPromise(() =>
          projectFor(bb, now.parsed.repo.owner, now.parsed.repo.name),
        ).pipe(Effect.orElseSucceed(() => null));
        const source = project?.sources.find((each) => each.isDefault) ?? project?.sources[0];
        return {
          ok: true,
          prompt: fixChecksPrompt(
            now.pr,
            now.parsed.repo,
            now.parsed.branch,
            selected.map((check) => ({ check, log: logOf(check, jobIds, read, failure) })),
          ),
          projectId: project?.id ?? null,
          environment: project
            ? {
                type: "host",
                ...(source ? { hostId: source.hostId } : {}),
                workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
              }
            : null,
        } satisfies FixPrompt;
      }),
    /** Starts the thread the reader composed. Never retried. */
    start: async (
      key: ChangeKey,
      head: string,
      request: NewThreadRequestInput,
    ): Promise<{ ok: true; threadId: string } | { ok: false; message: string }> => {
      const now = current(key, head);
      if (typeof now === "string") return { ok: false, message: now };
      const { repo } = now.parsed;
      const thread = await bb.sdk.threads.spawn({
        ...request,
        title: `Fix checks on ${repo.owner}/${repo.name}#${now.pr.number}`,
        visibility: "visible",
        pluginMetadata: { kind: "fix", changeKey: key, head },
      } as SpawnArgs);
      return { ok: true, threadId: thread.id };
    },
  };
}

export type FixChecks = ReturnType<typeof createFixChecks>;
