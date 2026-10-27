// Pure rule evaluation: does this PR match this rule, and if not, why not?
//
// Every rejection carries a human-readable reason, because "why didn't SlopCop
// review my PR?" is the question this plugin will be asked most often. The
// reasons surface in `bb slopcop check` and on skipped runs in the panel.
import {
  TRUSTED_ASSOCIATIONS,
  type AuthorAssociation,
  type Condition,
  type GitHubTarget,
  type PullRequest,
  type Rule,
  type Trigger,
} from "./types";

/**
 * Which triggers a PR fires on this poll pass.
 *
 * The subtlety is telling a genuinely new PR apart from one that merely existed
 * before SlopCop started watching the repo. Both look like "never seen before",
 * so a naive first-sighting-is-not-a-trigger rule silently ignores every PR
 * opened directly as ready-for-review — which is most of them. The per-repo
 * `bootstrapped` watermark resolves it: the first pass over a repo records the
 * backlog without firing, and everything unseen after that is genuinely new.
 */
export function computeTriggers(input: {
  seen: { headSha: string; wasDraft: boolean } | null;
  isDraft: boolean;
  headSha: string;
  repoBootstrapped: boolean;
  createdAt: number;
  watchStartedAt: number;
}): Trigger[] {
  if (input.isDraft) return [];
  const { seen } = input;
  if (seen === null) {
    // The first pass ignores the old backlog but keeps a PR posted after the
    // rule was saved. This closes the rule-save to first-poll race.
    const createdAfterWatch = input.createdAt >= input.watchStartedAt - 1_000;
    return input.repoBootstrapped || createdAfterWatch ? ["ready_for_review"] : [];
  }
  if (seen.wasDraft) return ["ready_for_review"];
  return seen.headSha !== input.headSha ? ["new_commits"] : [];
}

/** A new issue fires once after the issue watcher has recorded its backlog. */
export function computeIssueTriggers(input: {
  seen: boolean;
  repoBootstrapped: boolean;
}): Trigger[] {
  return !input.seen && input.repoBootstrapped ? ["new_issue"] : [];
}

export type MatchResult =
  | { matched: true }
  | { matched: false; reason: string; blockedByTrust?: boolean };

/**
 * Glob matching for paths and branch names.
 * `**` crosses separators, `*` and `?` do not.
 */
export function matchGlob(pattern: string, value: string): boolean {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    // `/**` makes the whole tail optional so `src/auth/**` matches the
    // directory `src/auth` itself, not only files beneath it.
    if (char === "/" && pattern[index + 1] === "*" && pattern[index + 2] === "*") {
      expression += "(?:/.*)?";
      index += 2;
      continue;
    }
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
        // `**/` may also match nothing at all, so `**/x.ts` matches `x.ts`.
        if (pattern[index + 1] === "/") index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`).test(value);
}

function matchesAnyGlob(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => matchGlob(pattern.trim(), value));
}

/** Returns the first case-insensitive literal keyword found as a full token. */
export function findMatchingKeyword(body: string, keywords: string[]): string | null {
  for (const rawKeyword of keywords) {
    const keyword = rawKeyword.trim();
    if (keyword.length === 0) continue;
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`, "iu");
    if (expression.test(body)) return keyword;
  }
  return null;
}

export function matchesPrDescription(rule: Rule, pullRequest: PullRequest): boolean {
  return (
    rule.triggers.includes("pr_description_matches") &&
    findMatchingKeyword(pullRequest.body, rule.commentKeywords) !== null
  );
}

export function isTrustedAuthor(association: string, trust: Rule["authorTrust"]): boolean {
  return (TRUSTED_ASSOCIATIONS[trust] as readonly string[]).includes(association);
}

function describeCondition(condition: Condition): string {
  switch (condition.kind) {
    case "paths":
      return `no changed file matches ${condition.globs.join(", ")}`;
    case "base_branch":
      return `base branch is not ${condition.globs.join(", ")}`;
    case "has_label":
      return `missing required label ${condition.labels.join(", ")}`;
    case "missing_label":
      return `carries excluded label ${condition.labels.join(", ")}`;
    case "author":
      return `author is not in ${condition.logins.join(", ")}`;
    case "title_matches":
      return `title does not match /${condition.regex}/`;
    case "max_changed_files":
      return `changes more than ${condition.value} files`;
  }
}

function evaluateCondition(condition: Condition, target: GitHubTarget): boolean {
  switch (condition.kind) {
    case "paths":
      // PR-only conditions do not restrict issue events on a mixed rule.
      if (target.kind === "issue") return true;
      return target.files.some((file) => matchesAnyGlob(condition.globs, file.path));
    case "base_branch":
      return target.kind === "issue" ? true : matchesAnyGlob(condition.globs, target.baseRefName);
    case "has_label":
      return target.labels.some((label) => condition.labels.includes(label.name));
    case "missing_label":
      return !target.labels.some((label) => condition.labels.includes(label.name));
    case "author":
      return condition.logins.includes(target.author?.login ?? "");
    case "title_matches":
      try {
        return new RegExp(condition.regex).test(target.title);
      } catch {
        // A malformed regex must not match everything by accident.
        return false;
      }
    case "max_changed_files":
      return target.kind === "issue" || target.files.length <= condition.value;
  }
}

/**
 * Evaluates a rule against a PR. Checks run cheapest-and-most-decisive first,
 * with the trust gate ahead of the conditions so the reason reported for an
 * untrusted PR is always the trust gate rather than an incidental path miss.
 */
export function evaluateRule(
  rule: Rule,
  target: GitHubTarget,
  trigger: Trigger,
  options: { skipAuthorTrust?: boolean } = {},
): MatchResult {
  if (!rule.enabled) {
    return { matched: false, reason: "rule is disabled" };
  }
  if (trigger !== "manual" && !rule.triggers.includes(trigger)) {
    return { matched: false, reason: `rule does not listen for ${trigger}` };
  }
  if (target.kind === "pull_request" && target.isDraft) {
    return { matched: false, reason: "pull request is a draft" };
  }
  if (
    options.skipAuthorTrust !== true &&
    !isTrustedAuthor(target.authorAssociation, rule.authorTrust)
  ) {
    const login = target.author?.login ?? "unknown";
    return {
      matched: false,
      blockedByTrust: true,
      reason: `author @${login} is ${target.authorAssociation}, and this rule only handles ${describeTrust(rule.authorTrust)}`,
    };
  }
  for (const condition of rule.conditions) {
    if (!evaluateCondition(condition, target)) {
      return { matched: false, reason: describeCondition(condition) };
    }
  }
  return { matched: true };
}

export function describeTrust(trust: Rule["authorTrust"]): string {
  switch (trust) {
    case "org_members":
      return "organization members and owners (OWNER, MEMBER)";
    case "write_access":
      return "authors with write access (OWNER, MEMBER, COLLABORATOR)";
    case "past_contributors":
      return "authors with write access or a previously merged commit";
    case "anyone":
      return "any author";
  }
}

/**
 * Reviewing a PR from `anyone` is the genuinely dangerous corner: the agent
 * runs `gh pr checkout` on a stranger's code and can execute commands in EVERY
 * BB permission mode — the enum is full | auto | accept-edits, and none of them
 * is read-only. So trust is the only real gate, and `full` merely widens an
 * already-open door.
 */
export function isDangerousCombination(rule: Rule): boolean {
  const listensForPullRequests = rule.triggers.some(
    (trigger) => trigger === "ready_for_review" || trigger === "new_commits",
  );
  return rule.authorTrust === "anyone" && listensForPullRequests;
}

/** True when the rule is in the worst corner: any author AND full access. */
export function isSevereCombination(rule: Rule): boolean {
  return isDangerousCombination(rule) && rule.request?.permissionMode === "full";
}

/** Associations that would newly qualify if the trust level were loosened. */
export function wouldQualifyAt(
  association: AuthorAssociation | string,
  trust: Rule["authorTrust"],
): boolean {
  return isTrustedAuthor(association, trust);
}
