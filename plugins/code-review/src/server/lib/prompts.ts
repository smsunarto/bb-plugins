import { instructionFiles } from "@bb-kit/core/instructions";
import type { Check } from "../../shared/schema.ts";
import type { PrHead } from "./pull-request.ts";

/*
 * What the threads this plugin starts are told. The words live in
 * `instructions/`; this fills in the pull request and the commands.
 *
 * Git allows `;`, `$`, and backticks in branch names, so a branch only ever
 * appears shell-quoted inside a fenced command, or in prose as inline code
 * this module renders. The files never wrap a branch in backticks: a
 * backtick in the name would close their code span early.
 */

const files = instructionFiles(import.meta.url);

/** The prompt of a bb review of `pr`. */
export function reviewPrompt(
  pr: PrHead,
  { reused, instructions }: { reused: boolean; instructions: string },
): string {
  const vars = {
    owner: pr.ref.owner,
    repo: pr.ref.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: inlineCode(pr.baseRefName),
    branch: inlineCode(pr.headRefName),
    baseRefOid: pr.baseRefOid,
    headRefOid: pr.headRefOid,
  };
  const workspace = reused
    ? files.read("review-workspace-shared", vars)
    : files.read("review-workspace-fresh", {
        checkout: fenced(`git checkout --detach ${pr.headRefOid}`),
      });
  return files.read("review-with-bb", {
    ...vars,
    fetch: fenced(
      [
        `git fetch origin 'pull/${pr.number}/head' ${quote(pr.baseRefName)}`,
        `git merge-base ${pr.headRefOid} ${quote(`origin/${pr.baseRefName}`)}`,
      ].join("\n"),
    ),
    workspace,
    reviewInstructions: instructions.trim() || "None.",
  });
}

/** A failing check and the end of its log, or why there is no log. */
export type FailedCheck = { check: Check; log: { text: string } | { missing: string } };

/**
 * The prompt of a thread that fixes `checks` on `pr`. The fix goes on a new
 * local branch at the pull request's head: the head branch is often checked
 * out in another worktree, where git refuses to switch to it, and a clone
 * of a fork's `main` already has a branch of that name. `pull/<n>/head`
 * serves forks and same-repository pull requests alike.
 */
export function fixChecksPrompt(pr: PrHead, checks: FailedCheck[]): string {
  const fixBranch = `code-review/fix-${pr.number}-${pr.headRefOid.slice(0, 7)}`;
  return files.read("fix-checks", {
    owner: pr.ref.owner,
    repo: pr.ref.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: inlineCode(pr.headRefName),
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

function checkSection({ check, log }: FailedCheck): string {
  const lines = [`### ${check.workflow ? `${check.workflow} / ` : ""}${check.name}`];
  if (check.detailsUrl) lines.push("", check.detailsUrl);
  if (check.description) lines.push("", check.description);
  lines.push("", "text" in log ? fenced(log.text, "text") : `No log: ${log.missing}`);
  return lines.join("\n");
}

/** POSIX single quotes: nothing inside is expanded, and `'` is closed, escaped, and reopened. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * CommonMark inline code that shows `text` as is: the fence is longer than
 * any backtick run inside, and a backtick or space at either end gets a
 * space on both sides, which the parser strips again.
 */
function inlineCode(text: string): string {
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A fence longer than any backtick run inside, so the content cannot close it. */
function fenced(code: string, language = "sh"): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}
