import { instructionFiles } from "@bb-plugins/instructions";
const prompts = instructionFiles(import.meta.url);
// Builds the prompt handed to the review agent.
//
// The prompt is a contract, not a suggestion: it specifies the exact header and
// marker every posted body must carry, because verification matches on them. In
// shadow mode it forbids posting entirely and asks for the review as text, so
// the same rule can be dry-run before it is ever visible on a PR.
import { buildMarker, buildHeader } from "./marker";
import type { GitHubIssue, GitHubTarget, PullRequest, Rule, Trigger } from "./types";

export interface DispatchContext {
  rule: Rule;
  target: GitHubTarget;
  runId: string;
  trigger?: Trigger;
  triggerRequest?: {
    author: string;
    keyword: string;
    url: string | null;
  };
  /**
   * The command the agent must use for writes. A bot deployment points this at
   * a wrapper that exports a bot `GH_TOKEN` and then execs `gh`, so the review
   * posts under the bot identity while the operator's own `gh` login stays
   * untouched. The agent never sees the token, only this command name.
   */
  ghCommand?: string;
}

function shadowBanner(target: GitHubTarget): string {
  const commands =
    target.kind === "issue"
      ? "`gh issue comment` or any other command"
      : "`gh pr review`, `gh pr comment`, or any other command";
  return prompts.read("shadow-mode", { commands: commands });
}

function liveBanner(ghCommand: string, target: GitHubTarget, repo: string): string {
  const note =
    ghCommand === "gh" ? "" : "\n\n" + prompts.read("bot-identity", { ghCommand: ghCommand });
  if (target.kind === "issue") {
    return prompts.read("post-issue", {
      ghCommand: ghCommand,
      number: target.number,
      repo: repo,
      identityNote: note,
    });
  }
  return prompts.read("post-review", { ghCommand: ghCommand, identityNote: note });
}

function formatBodyContract(context: DispatchContext): string {
  const { rule, target, runId } = context;
  const reference = target.kind === "pull_request" ? target.headRefOid : `issue-${target.number}`;
  const summaryMarker = buildMarker({
    rule: rule.name,
    run: runId,
    sha: reference,
    kind: "summary",
  });
  if (target.kind === "issue") {
    return prompts.read("issue-body-format", {
      summaryHeader: buildHeader("summary", rule.name),
      summaryMarker: summaryMarker,
    });
  }
  const inlineMarker = buildMarker({
    rule: rule.name,
    run: runId,
    sha: target.headRefOid,
    kind: "inline",
  });
  return prompts.read("review-body-format", {
    summaryHeader: buildHeader("summary", rule.name),
    summaryMarker: summaryMarker,
    inlineHeader: buildHeader("inline", rule.name),
    inlineMarker: inlineMarker,
  });
}

function formatIssue(issue: GitHubIssue, repo: string): string {
  const labels = issue.labels.map((label) => label.name).join(", ");
  return prompts.read("issue-details", {
    repo: repo,
    number: issue.number,
    title: issue.title,
    author: issue.author?.login ?? "unknown",
    authorAssociation: issue.authorAssociation,
    labels: labels.length > 0 ? labels : "none",
    createdAt: issue.createdAt || "unknown",
    body: issue.body.trim() || "(empty)",
  });
}

function formatPullRequest(pullRequest: PullRequest, repo: string): string {
  const files = pullRequest.files.slice(0, 50).map((file) => file.path);
  const overflow =
    pullRequest.files.length > files.length
      ? `\n  …and ${pullRequest.files.length - files.length} more`
      : "";
  const labels = pullRequest.labels.map((label) => label.name).join(", ");
  return prompts.read("review-details", {
    repo: repo,
    number: pullRequest.number,
    title: pullRequest.title,
    author: pullRequest.author?.login ?? "unknown",
    authorAssociation: pullRequest.authorAssociation,
    baseBranch: pullRequest.baseRefName,
    headSha: pullRequest.headRefOid,
    fromFork: pullRequest.isCrossRepository ? "yes" : "no",
    labels: labels.length > 0 ? labels : "none",
    fileCount: pullRequest.files.length,
    files: "\n" + files.map((path) => `  - ${path}`).join("\n"),
    overflow: overflow,
  });
}

export function buildPrompt(context: DispatchContext): string {
  const { rule, target } = context;
  const shadow = rule.mode === "shadow";
  const untrustedWarning =
    target.kind === "issue"
      ? "\n" + prompts.read("untrusted-issue") + "\n"
      : target.isCrossRepository
        ? "\n" + prompts.read("untrusted-fork") + "\n"
        : "";
  const targetName = target.kind === "issue" ? "an issue" : "a pull request";
  const targetDetails =
    target.kind === "issue" ? formatIssue(target, rule.repo) : formatPullRequest(target, rule.repo);

  const triggerRequest = context.triggerRequest;
  const triggerSection =
    triggerRequest === undefined
      ? ""
      : "\n" +
        prompts.read("review-request", {
          author: triggerRequest.author,
          keyword: triggerRequest.keyword,
          requestLink: triggerRequest.url === null ? "" : `Request URL: ${triggerRequest.url}\n`,
        }) +
        "\n";

  return prompts.read("dispatch", {
    ruleName: rule.name,
    targetName: targetName,
    repo: rule.repo,
    untrustedWarning: untrustedWarning,
    targetDetails: targetDetails,
    triggerSection: triggerSection,
    ruleInstructions: rule.prompt.trim(),
    postingInstructions: shadow
      ? shadowBanner(target)
      : liveBanner(context.ghCommand?.trim() || "gh", target, rule.repo),
    bodyFormat: formatBodyContract(context),
    finishingInstructions: shadow ? prompts.read("finish-shadow") : prompts.read("finish-live"),
  });
}

/** A concise title for the spawned thread, shown in the BB sidebar. */
export function buildThreadTitle(context: DispatchContext): string {
  const prefix = context.rule.mode === "shadow" ? "SlopCop (shadow)" : "SlopCop";
  const label = context.target.kind === "issue" ? "Issue" : "PR";
  return `${prefix}: ${context.rule.name} — ${label} #${context.target.number}`;
}
