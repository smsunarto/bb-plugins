// SlopCop — configurable GitHub issue and PR rules that dispatch BB agents.
//
// Flow: a watcher polls each watched repo with `gh`, detects the
// draft -> ready-for-review edge, matches PRs against enabled rules, and spawns
// a review thread per match. When that thread goes idle, SlopCop verifies the
// outcome against GitHub itself rather than trusting the agent's transcript.
import {
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
  type PluginCliPositional,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createGhClient, type GhClient } from "./lib/gh";
import {
  createStore,
  MIGRATIONS,
  repairIssueSchema,
  repairKeywordSchema,
  type Store,
} from "./lib/db";
import { buildPrompt, buildThreadTitle } from "./lib/dispatch";
import { resolveThreadSectionId } from "./lib/sections";
import { expandHome } from "./lib/paths";
import {
  computeIssueTriggers,
  computeTriggers,
  describeTrust,
  evaluateRule,
  findMatchingKeyword,
  isDangerousCombination,
  isTrustedAuthor,
  matchesPrDescription,
} from "./lib/matcher";
import { verifyLive, verifyShadow } from "./lib/verify";
import {
  authorTrustSchema,
  conditionSchema,
  dedupeSchema,
  reviewStrategySchema,
  ruleModeSchema,
  threadRequestSchema,
  targetKindSchema,
  triggerSchema,
  visibilitySchema,
  type GitHubIssue,
  type GitHubTarget,
  type PullRequest,
  type Rule,
  type Trigger,
  type CommentTriggerEvent,
  type TriggerCommentSource,
} from "./lib/types";

const RUNS_CHANNEL = "runs-changed";

const ruleInputSchema = z
  .object({
    name: z.string().min(1),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    enabled: z.boolean().default(true),
    mode: ruleModeSchema.default("shadow"),
    triggers: z.array(triggerSchema).min(1).default(["ready_for_review"]),
    commentKeywords: z.array(z.string().min(1)).default([]),
    conditions: z.array(conditionSchema).default([]),
    authorTrust: authorTrustSchema.default("write_access"),
    requesterTrust: authorTrustSchema.default("write_access"),
    prompt: z.string().default(""),
    request: threadRequestSchema.nullable().default(null),
    dedupe: dedupeSchema.default("once_per_pr"),
    reviewStrategy: reviewStrategySchema.default("update"),
    visibility: visibilitySchema.default("visible"),
  })
  .superRefine((rule, context) => {
    const needsKeywords = rule.triggers.some((trigger) =>
      ["comment_matches", "pr_description_matches"].includes(trigger),
    );
    if (needsKeywords && rule.commentKeywords.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["commentKeywords"],
        message: "a comment or description trigger needs at least one keyword",
      });
    }
  });

const ruleOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  repo: z.string(),
  enabled: z.boolean(),
  mode: z.string(),
  triggers: z.array(z.string()),
  commentKeywords: z.array(z.string()),
  conditions: z.array(z.unknown()),
  authorTrust: z.string(),
  requesterTrust: z.string(),
  commentTriggerEnabledAt: z.number().nullable(),
  prompt: z.string(),
  request: z.unknown().nullable(),
  dedupe: z.string(),
  reviewStrategy: z.string(),
  visibility: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  dangerous: z.boolean(),
});

const runOutputSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  repo: z.string(),
  targetKind: targetKindSchema,
  prNumber: z.number(),
  prTitle: z.string(),
  prAuthor: z.string(),
  headSha: z.string(),
  trigger: z.string(),
  triggerEventId: z.string().nullable(),
  status: z.string(),
  mode: z.string(),
  detail: z.string().nullable(),
  threadId: z.string().nullable(),
  commentCount: z.number(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});

const commentOutputSchema = z.object({
  githubId: z.string().nullable(),
  kind: z.string(),
  path: z.string().nullable(),
  line: z.number().nullable(),
  url: z.string().nullable(),
  bodyExcerpt: z.string(),
  attribution: z.string(),
});

export const rpcContract = defineRpcContract({
  listRules: {
    input: z.null(),
    output: z.object({ rules: z.array(ruleOutputSchema) }),
  },
  saveRule: {
    input: z.object({ id: z.string().nullable(), rule: ruleInputSchema }),
    output: z.object({ rule: ruleOutputSchema }),
  },
  deleteRule: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  setRuleEnabled: {
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  listRuns: {
    input: z.object({
      ruleId: z.string().nullable().optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    output: z.object({ runs: z.array(runOutputSchema) }),
  },
  getRunComments: {
    input: z.object({ runId: z.string() }),
    output: z.object({ comments: z.array(commentOutputSchema) }),
  },
  checkPr: {
    input: z.object({ ruleId: z.string(), prNumber: z.number().int() }),
    output: z.object({
      matched: z.boolean(),
      reason: z.string().nullable(),
      prTitle: z.string(),
      prAuthor: z.string(),
      association: z.string(),
    }),
  },
  dispatchNow: {
    input: z.object({
      ruleId: z.string(),
      prNumber: z.number().int(),
      targetKind: targetKindSchema.default("pull_request"),
      force: z.boolean().optional(),
    }),
    output: z.object({
      runId: z.string().nullable(),
      threadId: z.string().nullable(),
      blockedReason: z.string().nullable(),
    }),
  },
  status: {
    input: z.null(),
    output: z.object({
      ghAvailable: z.boolean(),
      ghLogin: z.string().nullable(),
      watchedRepos: z.array(z.string()),
      pollSeconds: z.number(),
      defaultThreadSection: z.string(),
    }),
  },
});

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function toRuleOutput(rule: Rule) {
  return { ...rule, dangerous: isDangerousCombination(rule) };
}

function createServices(bb: BbPluginApi) {
  const settings = bb.settings.define({
    pollSeconds: {
      type: "string",
      label: "Poll interval (seconds)",
      default: "60",
    },
    maxConcurrentReviews: {
      type: "string",
      label: "Max concurrent review threads",
      default: "3",
    },
    ghPath: { type: "string", label: "Path to the gh binary", default: "gh" },
    botGhPath: {
      type: "string",
      label: "Bot gh wrapper",
      description:
        "Absolute path to a wrapper that exports a bot GH_TOKEN and execs gh. When set, SlopCop reads, verifies, and posts as the bot instead of your own gh login. Leave empty to use your own login.",
      default: "",
    },
    defaultThreadSection: {
      type: "string",
      label: "Default review thread section",
      description:
        "Use a section name or ID. Leave this field empty to create unsectioned review threads.",
      default: "",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  repairIssueSchema(db);
  repairKeywordSchema(db);
  const store: Store = createStore(db as never);

  let gh: GhClient = createGhClient("gh");
  let ghLogin: string | null = null;
  let inFlight = 0;

  const readSettings = async () => {
    const values = await settings.get();
    const poll = Number.parseInt(values.pollSeconds, 10);
    const concurrency = Number.parseInt(values.maxConcurrentReviews, 10);
    const botGhPath = values.botGhPath.trim();
    return {
      pollSeconds: Number.isFinite(poll) && poll >= 15 ? poll : 60,
      maxConcurrent: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 3,
      // One switch turns on bot mode. The backend client and the agent's write
      // command must resolve to the same identity, or `verifyLive`'s
      // account-based fallback would look for comments from the wrong login.
      //
      // `execFile` does not expand `~`, but the agent's shell does — and the
      // two often run on different hosts with different home directories, so
      // an absolute path cannot serve both. Store the tilde, expand it here.
      ghPath: expandHome(botGhPath) || values.ghPath.trim() || "gh",
      botGhPath,
      defaultThreadSection: values.defaultThreadSection.trim(),
    };
  };

  const announce = () => {
    bb.realtime.publish(RUNS_CHANNEL, { at: Date.now() });
  };

  /**
   * REST does not return a PR's changed files inline, so they are fetched only
   * when a rule actually filters on paths — which keeps the common poll pass to
   * a single API call per repo.
   */
  async function hydrateFiles(
    rules: Rule[],
    repo: string,
    pullRequest: PullRequest,
  ): Promise<void> {
    const needsFiles = rules.some((rule) =>
      rule.conditions.some((condition) => condition.kind === "paths"),
    );
    if (!needsFiles || pullRequest.files.length > 0) return;
    try {
      pullRequest.files = await gh.listFiles(repo, pullRequest.number);
    } catch (error) {
      bb.log.warn(
        `could not list files for ${repo}#${pullRequest.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Creates the run row and spawns the review thread. Returns the run id so a
   * manual dispatch can report it even when the spawn itself fails.
   */
  async function dispatch(
    rule: Rule,
    target: GitHubTarget,
    options: {
      forcedReason?: string | null;
      trigger?: Trigger;
      triggerEventId?: string | null;
      triggerRequest?: {
        author: string;
        keyword: string;
        url: string | null;
      };
    } = {},
  ): Promise<{ runId: string; threadId: string | null }> {
    const runId = newId("run");
    const now = Date.now();
    // A forced run bypassed a gate the rule would otherwise have honoured, so
    // record why on the run itself — otherwise the activity feed shows a
    // perfectly ordinary review and the override is invisible in hindsight.
    const forcedReason = options.forcedReason ?? null;
    store.insertRun({
      id: runId,
      ruleId: rule.id,
      ruleName: rule.name,
      repo: rule.repo,
      targetKind: target.kind,
      prNumber: target.number,
      prTitle: target.title,
      prAuthor: target.author?.login ?? "",
      headSha: target.kind === "pull_request" ? target.headRefOid : "",
      trigger: options.trigger ?? "manual",
      triggerEventId: options.triggerEventId ?? null,
      status: "dispatched",
      mode: rule.mode,
      detail: forcedReason === null ? null : `forced past the gate — ${forcedReason}`,
      threadId: null,
      commentCount: 0,
      startedAt: now,
      finishedAt: null,
    });
    announce();

    if (rule.request === null) {
      store.updateRun(runId, {
        status: "failed",
        detail: "rule has no agent configuration — open it in the SlopCop panel and save it once",
        finishedAt: Date.now(),
      });
      announce();
      return { runId, threadId: null };
    }

    const { botGhPath, defaultThreadSection } = await readSettings();
    const context = {
      rule,
      target,
      runId,
      ghCommand: botGhPath,
      trigger: options.trigger,
      triggerRequest: options.triggerRequest,
    };
    try {
      // `spawn` takes prompt XOR input. The composer stores its draft under
      // `input`, so it must be dropped here — the prompt SlopCop builds from
      // the rule + PR context is what actually runs.
      const { input: _draftInput, ...execution } = rule.request as Record<string, unknown>;
      // `executionInputSources` tells the server which fields the caller chose
      // explicitly; anything not marked explicit falls back to the project's
      // remembered default. The composer omits `providerId` there, so replaying
      // its request verbatim silently dropped our provider and resolved the
      // project's instead — which then rejected the (valid) model as unknown.
      // Anything we actually send is by definition an explicit choice.
      const sources: Record<string, string> = {
        ...((execution.executionInputSources as Record<string, string>) ?? {}),
      };
      for (const field of [
        "providerId",
        "model",
        "reasoningLevel",
        "serviceTier",
        "permissionMode",
      ]) {
        if (execution[field] !== undefined) sources[field] = "explicit";
      }
      execution.executionInputSources = sources;
      const sectionId = resolveThreadSectionId(
        defaultThreadSection,
        defaultThreadSection.length > 0 ? await bb.sdk.threadSections.list() : [],
      );
      const thread = await bb.sdk.threads.spawn({
        ...execution,
        prompt: buildPrompt(context),
        title: buildThreadTitle(context),
        visibility: rule.visibility,
        ...(sectionId === undefined ? {} : { sectionId }),
      } as never);
      const threadId = (thread as { id: string }).id;
      store.updateRun(runId, { status: "reviewing", threadId });
      inFlight += 1;
      announce();
      bb.log.info(
        `dispatched ${rule.name} for ${target.kind} ${rule.repo}#${target.number} (${rule.mode}) -> ${threadId}`,
      );
      return { runId, threadId };
    } catch (error) {
      store.updateRun(runId, {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      });
      announce();
      return { runId, threadId: null };
    }
  }

  /** Records a rule that matched nothing, so "why no review?" is answerable. */
  function recordSkip(
    rule: Rule,
    target: GitHubTarget,
    reason: string,
    trigger: Trigger,
    triggerEventId: string | null,
  ): void {
    store.insertRun({
      id: newId("run"),
      ruleId: rule.id,
      ruleName: rule.name,
      repo: rule.repo,
      targetKind: target.kind,
      prNumber: target.number,
      prTitle: target.title,
      prAuthor: target.author?.login ?? "",
      headSha: target.kind === "pull_request" ? target.headRefOid : "",
      trigger,
      triggerEventId,
      status: "skipped",
      mode: rule.mode,
      detail: reason,
      threadId: null,
      commentCount: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    });
  }

  function triggerEventId(
    trigger: Trigger,
    pullRequest: PullRequest,
    comment?: { source: TriggerCommentSource; commentId: string },
  ): string {
    if (comment !== undefined) {
      return `comment:${comment.source}:${comment.commentId}`;
    }
    return `${trigger}:${pullRequest.headRefOid}`;
  }

  function hasAlreadyRun(rule: Rule, pullRequest: PullRequest, eventId: string): boolean {
    return store.hasRunFor(
      rule.id,
      rule.repo,
      "pull_request",
      pullRequest.number,
      rule.dedupe === "once_per_head_sha" ? pullRequest.headRefOid : null,
      rule.dedupe === "once_per_trigger_event" ? eventId : null,
    );
  }

  async function ingestCommentEvents(
    repo: string,
    repoRules: Rule[],
    pullRequests: Map<number, PullRequest>,
  ): Promise<void> {
    const commentRules = repoRules.filter((rule) => rule.triggers.includes("comment_matches"));
    if (commentRules.length === 0) return;

    const pollStartedAt = Date.now();
    const earliestRule = Math.min(
      ...commentRules.map((rule) => rule.commentTriggerEnabledAt ?? rule.updatedAt),
    );
    const sources: TriggerCommentSource[] = ["issue", "review"];
    for (const source of sources) {
      const cursor = store.getCommentCursor(repo, source) ?? earliestRule;
      const since = Math.max(0, cursor - 5_000);
      try {
        const comments =
          source === "issue"
            ? await gh.listRecentIssueComments(repo, since)
            : await gh.listRecentReviewComments(repo, since);
        for (const comment of comments) {
          if (!pullRequests.has(comment.prNumber)) continue;
          if (ghLogin !== null && comment.author?.toLowerCase() === ghLogin.toLowerCase()) {
            continue;
          }
          for (const rule of commentRules) {
            // GitHub timestamps have second precision. The one-second margin
            // keeps a comment made just after rule creation from disappearing.
            const enabledAt = rule.commentTriggerEnabledAt ?? rule.updatedAt;
            if (comment.createdAt < enabledAt - 1_000) continue;
            const keyword = findMatchingKeyword(comment.body, rule.commentKeywords);
            if (keyword === null) continue;
            store.enqueueCommentEvent({
              ruleId: rule.id,
              source,
              commentId: comment.id,
              repo,
              prNumber: comment.prNumber,
              author: comment.author ?? "unknown",
              authorAssociation: String(comment.authorAssociation),
              matchedKeyword: keyword,
              url: comment.url,
              createdAt: comment.createdAt,
              status: "pending",
              detail: null,
            });
          }
        }
        store.setCommentCursor(repo, source, pollStartedAt);
      } catch (error) {
        bb.log.warn(
          `comment poll failed for ${repo} (${source}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async function processCommentEvents(
    repo: string,
    repoRules: Rule[],
    pullRequests: Map<number, PullRequest>,
    maxConcurrent: number,
  ): Promise<void> {
    for (const event of store.listPendingCommentEvents(repo)) {
      const rule = repoRules.find((candidate) => candidate.id === event.ruleId);
      const pullRequest = pullRequests.get(event.prNumber);
      if (rule === undefined || pullRequest === undefined) {
        store.finishCommentEvent(
          event.ruleId,
          event.source,
          event.commentId,
          "ignored",
          rule === undefined ? "rule is no longer enabled" : "PR is not open",
        );
        continue;
      }

      const eventId = triggerEventId("comment_matches", pullRequest, event);
      if (!isTrustedAuthor(event.authorAssociation, rule.requesterTrust)) {
        const reason = `requester @${event.author} is ${event.authorAssociation}, and this rule only accepts ${describeTrust(rule.requesterTrust)}`;
        recordSkip(rule, pullRequest, reason, "comment_matches", eventId);
        store.finishCommentEvent(event.ruleId, event.source, event.commentId, "ignored", reason);
        announce();
        continue;
      }

      await hydrateFiles([rule], repo, pullRequest);
      // A trusted requester can ask for a review on another person's PR. The
      // requester gate above replaces the PR-author gate for this trigger.
      const result = evaluateRule(rule, pullRequest, "comment_matches", {
        skipAuthorTrust: true,
      });
      if (!result.matched) {
        if (result.blockedByTrust) {
          recordSkip(rule, pullRequest, result.reason, "comment_matches", eventId);
          announce();
        }
        store.finishCommentEvent(
          event.ruleId,
          event.source,
          event.commentId,
          "ignored",
          result.reason,
        );
        continue;
      }
      if (hasAlreadyRun(rule, pullRequest, eventId)) {
        store.finishCommentEvent(
          event.ruleId,
          event.source,
          event.commentId,
          "processed",
          "dedupe policy already matched a run",
        );
        continue;
      }
      if (inFlight >= maxConcurrent) return;

      await dispatch(rule, pullRequest, {
        trigger: "comment_matches",
        triggerEventId: eventId,
        triggerRequest: {
          author: event.author,
          keyword: event.matchedKeyword,
          url: event.url,
        },
      });
      store.finishCommentEvent(event.ruleId, event.source, event.commentId, "processed", null);
    }
  }

  /**
   * One polling pass. It detects PR edges and new issues. It then evaluates
   * the applicable rules for each target.
   */
  async function poll(maxConcurrent: number): Promise<void> {
    const rules = store.listRules().filter((rule) => rule.enabled);
    const repos = [...new Set(rules.map((rule) => rule.repo))];

    for (const repo of repos) {
      const repoRules = rules.filter((candidate) => candidate.repo === repo);
      const pullRequestRules = repoRules.filter((rule) =>
        rule.triggers.some(
          (trigger) =>
            trigger === "ready_for_review" ||
            trigger === "new_commits" ||
            trigger === "pr_description_matches" ||
            trigger === "comment_matches",
        ),
      );
      const issueRules = repoRules.filter((rule) => rule.triggers.includes("new_issue"));

      if (pullRequestRules.length > 0) {
        try {
          const pullRequests = await gh.listOpenPullRequests(repo);
          const repoBootstrapped = store.isBootstrapped(repo);
          if (!repoBootstrapped) {
            bb.log.info(
              `bootstrapping ${repo}: recording ${pullRequests.length} open PR(s) as backlog`,
            );
          }

          const pullRequestsByNumber = new Map(
            pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
          );
          await ingestCommentEvents(repo, repoRules, pullRequestsByNumber);
          await processCommentEvents(repo, repoRules, pullRequestsByNumber, maxConcurrent);

          for (const pullRequest of pullRequests) {
            const lifecycleTriggers = computeTriggers({
              seen: store.getSeen(repo, pullRequest.number),
              isDraft: pullRequest.isDraft,
              headSha: pullRequest.headRefOid,
              repoBootstrapped,
              createdAt: pullRequest.createdAt,
              watchStartedAt: Math.min(...pullRequestRules.map((rule) => rule.createdAt)),
            });
            if (lifecycleTriggers.length === 0) {
              store.markSeen(
                repo,
                pullRequest.number,
                pullRequest.headRefOid,
                pullRequest.isDraft,
                Date.now(),
              );
              continue;
            }

            await hydrateFiles(pullRequestRules, repo, pullRequest);
            let deferred = false;
            for (const rule of pullRequestRules) {
              const triggers = lifecycleTriggers.slice();
              if (
                lifecycleTriggers.includes("ready_for_review") &&
                matchesPrDescription(rule, pullRequest)
              ) {
                triggers.push("pr_description_matches");
              }
              for (const trigger of triggers) {
                const result = evaluateRule(rule, pullRequest, trigger);
                if (!result.matched) {
                  if (result.blockedByTrust) {
                    const eventId = triggerEventId(trigger, pullRequest);
                    recordSkip(rule, pullRequest, result.reason, trigger, eventId);
                    announce();
                  }
                  continue;
                }
                const eventId = triggerEventId(trigger, pullRequest);
                if (hasAlreadyRun(rule, pullRequest, eventId)) continue;
                if (inFlight >= maxConcurrent) {
                  bb.log.info(
                    `concurrency cap reached (${maxConcurrent}); ${rule.name} will retry next poll`,
                  );
                  deferred = true;
                  break;
                }
                await dispatch(rule, pullRequest, {
                  trigger,
                  triggerEventId: eventId,
                });
                break;
              }
              if (deferred) break;
            }
            if (!deferred) {
              store.markSeen(
                repo,
                pullRequest.number,
                pullRequest.headRefOid,
                pullRequest.isDraft,
                Date.now(),
              );
            }
          }
          store.markBootstrapped(repo, Date.now());
        } catch (error) {
          bb.log.warn(
            `PR poll failed for ${repo}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (issueRules.length > 0) {
        try {
          const issueNumbers = await gh.listOpenIssueNumbers(repo);
          const repoBootstrapped = store.isIssueBootstrapped(repo);
          if (!repoBootstrapped) {
            bb.log.info(
              `bootstrapping ${repo}: recording ${issueNumbers.length} open issue(s) as backlog`,
            );
          }

          for (const issueNumber of issueNumbers) {
            const triggers = computeIssueTriggers({
              seen: store.hasSeenIssue(repo, issueNumber),
              repoBootstrapped,
            });
            let retry = false;
            if (triggers.length === 0) {
              store.markIssueSeen(repo, issueNumber, Date.now());
              continue;
            }
            const issue = await gh.getIssue(repo, issueNumber);
            for (const rule of issueRules) {
              const result = evaluateRule(rule, issue, triggers[0]!);
              if (!result.matched) {
                if (result.blockedByTrust) {
                  recordSkip(rule, issue, result.reason, "new_issue", null);
                  announce();
                }
                continue;
              }
              const alreadyRan = store.hasRunFor(rule.id, repo, "issue", issue.number, null);
              if (alreadyRan) continue;
              if (inFlight >= maxConcurrent) {
                retry = true;
                bb.log.info(
                  `concurrency cap reached (${maxConcurrent}); ${rule.name} will retry next poll`,
                );
                continue;
              }
              await dispatch(rule, issue, { trigger: "new_issue" });
            }
            if (!retry) store.markIssueSeen(repo, issue.number, Date.now());
          }
          store.markIssueBootstrapped(repo, Date.now());
        } catch (error) {
          bb.log.warn(
            `issue poll failed for ${repo}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  // --- verification ------------------------------------------------------

  async function finishRun(
    threadId: string,
    finalMessage: string | null,
    failure: string | null,
  ): Promise<void> {
    const run = store.findRunByThread(threadId);
    if (run === null || run.finishedAt !== null) return;
    inFlight = Math.max(0, inFlight - 1);

    if (failure !== null) {
      store.updateRun(run.id, {
        status: "failed",
        detail: failure,
        finishedAt: Date.now(),
      });
      announce();
      return;
    }

    const runVerify = () =>
      verifyLive({
        gh,
        repo: run.repo,
        prNumber: run.prNumber,
        targetKind: run.targetKind,
        runId: run.id,
        startedAt: run.startedAt,
        authenticatedLogin: ghLogin,
      });

    const result =
      run.mode === "shadow"
        ? verifyShadow({ runId: run.id, finalMessage })
        : await (async () => {
            // GitHub's list endpoints can lag a just-submitted review, so a
            // bare no_comment gets one retry before it is believed.
            const first = await runVerify();
            if (first.status !== "no_comment") return first;
            await new Promise((resolve) => setTimeout(resolve, 4_000));
            return runVerify();
          })();

    store.replaceComments(run.id, result.comments);
    store.updateRun(run.id, {
      status: result.status,
      detail: result.detail,
      commentCount: result.comments.length,
      finishedAt: Date.now(),
    });
    announce();
    bb.log.info(
      `run ${run.id} (${run.ruleName} ${run.targetKind} #${run.prNumber}) -> ${result.status}`,
    );
  }

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    void finishRun(thread.id, lastAssistantText, null).catch((error: unknown) => {
      bb.log.error(
        `verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });

  /**
   * `thread.failed`'s `error` is only the latest system/error message, so a
   * provider-level rejection (bad model, auth, cold-start) arrives as null and
   * the run would record a useless "it failed". Recover the real message from
   * the event log, which is where provider/error actually lands.
   */
  async function describeThreadFailure(threadId: string, reported: string | null): Promise<string> {
    if (reported !== null && reported.trim().length > 0) return reported;
    try {
      const result = (await bb.sdk.threads.events.list({
        threadId,
      } as never)) as { events?: unknown[] };
      const events = Array.isArray(result.events) ? result.events : [];
      for (const raw of [...events].reverse()) {
        const event = raw as {
          type?: unknown;
          message?: unknown;
          error?: unknown;
        };
        const type = typeof event.type === "string" ? event.type : "";
        if (!type.includes("error")) continue;
        const message =
          typeof event.message === "string"
            ? event.message
            : typeof event.error === "string"
              ? event.error
              : JSON.stringify(event).slice(0, 400);
        if (message.length > 0) return `${type}: ${message}`;
      }
    } catch (error) {
      bb.log.warn(
        `could not read failure detail for ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return "the review thread failed (no error detail recorded — open the thread)";
  }

  bb.events.on("thread.failed", ({ thread, error }) => {
    void describeThreadFailure(thread.id, error).then((detail) =>
      finishRun(thread.id, null, detail),
    );
  });

  // --- shared helpers for rpc + cli ---------------------------------------

  function resolveRule(idOrName: string): Rule {
    const rule = store.getRule(idOrName) ?? store.findRuleByName(idOrName);
    if (rule === null) throw new Error(`no rule named '${idOrName}'`);
    return rule;
  }

  async function checkPr(rule: Rule, prNumber: number) {
    const pullRequest = await gh.getPullRequest(rule.repo, prNumber);
    await hydrateFiles([rule], rule.repo, pullRequest);
    const result = evaluateRule(rule, pullRequest, "manual");
    return { pullRequest, result };
  }

  async function checkTarget(rule: Rule, targetKind: "pull_request" | "issue", number: number) {
    if (targetKind === "pull_request") {
      const { pullRequest, result } = await checkPr(rule, number);
      return { target: pullRequest as GitHubTarget, result };
    }
    const issue = await gh.getIssue(rule.repo, number);
    return {
      target: issue as GitHubTarget,
      result: evaluateRule(rule, issue, "manual"),
    };
  }

  function saveRule(id: string | null, input: z.infer<typeof ruleInputSchema>): Rule {
    const now = Date.now();
    const existing = id === null ? null : store.getRule(id);
    const hadCommentTrigger =
      (existing?.triggers.includes("comment_matches") ?? false) && existing?.repo === input.repo;
    const hasCommentTrigger = input.triggers.includes("comment_matches");
    const rule: Rule = {
      id: existing?.id ?? newId("rule"),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...input,
      commentTriggerEnabledAt: hasCommentTrigger
        ? hadCommentTrigger
          ? (existing?.commentTriggerEnabledAt ?? now)
          : now
        : null,
    };
    store.upsertRule(rule);
    if (isDangerousCombination(rule)) {
      bb.log.warn(
        `rule '${rule.name}' reviews PRs from ANY author — untrusted code can run with agent access`,
      );
    }
    return rule;
  }

  // --- rpc -----------------------------------------------------------------

  const handlers = {
    listRules: () => ({ rules: store.listRules().map(toRuleOutput) }),

    saveRule: ({ id, rule }) => ({ rule: toRuleOutput(saveRule(id, rule)) }),

    deleteRule: ({ id }) => {
      store.deleteRule(id);
      announce();
      return { ok: true };
    },

    setRuleEnabled: ({ id, enabled }) => {
      const rule = store.getRule(id);
      if (rule === null) throw new Error("rule not found");
      const now = Date.now();
      store.upsertRule({
        ...rule,
        enabled,
        updatedAt: now,
        commentTriggerEnabledAt:
          enabled && !rule.enabled && rule.triggers.includes("comment_matches")
            ? now
            : rule.commentTriggerEnabledAt,
      });
      announce();
      return { ok: true };
    },

    listRuns: ({ ruleId, limit }) => ({
      runs: store.listRuns({ ruleId: ruleId ?? undefined, limit }),
    }),

    getRunComments: ({ runId }) => ({
      comments: store.listComments(runId).map(({ runId: _runId, ...rest }) => rest),
    }),

    checkPr: async ({ ruleId, prNumber }) => {
      const rule = resolveRule(ruleId);
      const { pullRequest, result } = await checkPr(rule, prNumber);
      return {
        matched: result.matched,
        reason: result.matched ? null : result.reason,
        prTitle: pullRequest.title,
        prAuthor: pullRequest.author?.login ?? "",
        association: String(pullRequest.authorAssociation),
      };
    },

    dispatchNow: async ({ ruleId, prNumber, targetKind, force }) => {
      const rule = resolveRule(ruleId);
      const { target, result } = await checkTarget(rule, targetKind, prNumber);
      if (!result.matched && force !== true) {
        // Refuse rather than silently reviewing: the caller gets the reason and
        // can re-issue with force once a human has judged it.
        return { runId: null, threadId: null, blockedReason: result.reason };
      }
      const dispatched = await dispatch(rule, target, {
        forcedReason: result.matched ? null : result.reason,
      });
      return { ...dispatched, blockedReason: null };
    },

    status: async () => {
      const values = await readSettings();
      return {
        ghAvailable: ghLogin !== null,
        ghLogin,
        watchedRepos: [
          ...new Set(
            store
              .listRules()
              .filter((rule) => rule.enabled)
              .map((rule) => rule.repo),
          ),
        ],
        pollSeconds: values.pollSeconds,
        defaultThreadSection: values.defaultThreadSection,
      };
    },
  } satisfies PluginRpcHandlers<typeof rpcContract>;

  // --- cli -----------------------------------------------------------------

  const runCli = async (argv: string[]) => {
    const flag = (name: string): string | undefined => {
      const index = argv.indexOf(`--${name}`);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    const has = (name: string) => argv.includes(`--${name}`);
    const json = has("json");
    const ok = (stdout: string) => ({ exitCode: 0, stdout });
    const fail = (stderr: string) => ({ exitCode: 1, stderr });

    try {
      const [command, rawSub] = argv;
      // A leading flag is not a subcommand: `rules --json` must list, not
      // fall through to the usage error.
      const sub = rawSub !== undefined && rawSub.startsWith("--") ? undefined : rawSub;

      if (command === "status") {
        const values = await readSettings();
        const repos = [
          ...new Set(
            store
              .listRules()
              .filter((rule) => rule.enabled)
              .map((rule) => rule.repo),
          ),
        ];
        const payload = {
          ghLogin,
          ghAvailable: ghLogin !== null,
          watchedRepos: repos,
          pollSeconds: values.pollSeconds,
          defaultThreadSection: values.defaultThreadSection,
          rules: store.listRules().length,
        };
        return ok(
          json
            ? JSON.stringify(payload, null, 2)
            : `gh: ${ghLogin ?? "NOT AUTHENTICATED"}\nwatching: ${
                repos.join(", ") || "(no enabled rules)"
              }\npolling every ${values.pollSeconds}s\ndefault section: ${
                values.defaultThreadSection || "(unsectioned)"
              }\n${payload.rules} rule(s)`,
        );
      }

      if (command === "rules" && (sub === undefined || sub === "list")) {
        const rules = store.listRules();
        if (json) return ok(JSON.stringify(rules.map(toRuleOutput), null, 2));
        if (rules.length === 0) return ok("No rules yet.");
        return ok(
          rules
            .map((rule) => {
              const flags = [
                rule.enabled ? "enabled" : "disabled",
                rule.mode,
                ...(rule.visibility === "hidden" ? ["hidden threads"] : []),
                describeTrust(rule.authorTrust),
              ];
              return `${rule.name}  ${rule.repo}  [${flags.join(" · ")}]  ${rule.id}`;
            })
            .join("\n"),
        );
      }

      if (command === "rules" && (sub === "add" || sub === "edit")) {
        const existing = sub === "edit" ? resolveRule(argv[2] ?? "") : null;
        const list = (name: string) =>
          flag(name)
            ?.split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0);

        const conditions = existing?.conditions.slice() ?? [];
        const paths = list("paths");
        if (paths !== undefined) {
          const index = conditions.findIndex((c) => c.kind === "paths");
          const next = { kind: "paths" as const, globs: paths };
          if (index >= 0) conditions[index] = next;
          else conditions.push(next);
        }
        const base = flag("base");
        if (base !== undefined) {
          const index = conditions.findIndex((c) => c.kind === "base_branch");
          const next = { kind: "base_branch" as const, globs: [base] };
          if (index >= 0) conditions[index] = next;
          else conditions.push(next);
        }
        const label = list("label");
        if (label !== undefined) {
          conditions.push({ kind: "has_label", labels: label });
        }
        const skipLabel = list("skip-label");
        if (skipLabel !== undefined) {
          conditions.push({ kind: "missing_label", labels: skipLabel });
        }
        const excludedAuthors = list("exclude-author");
        if (excludedAuthors !== undefined) {
          for (let index = conditions.length - 1; index >= 0; index -= 1) {
            if (conditions[index]?.kind === "exclude_author") conditions.splice(index, 1);
          }
          if (excludedAuthors.length > 0) {
            conditions.push({ kind: "exclude_author", logins: excludedAuthors });
          }
        }

        const parsedTriggers = list("trigger") ?? existing?.triggers ?? ["ready_for_review"];
        const keywordTrigger = parsedTriggers.some((trigger) =>
          ["comment_matches", "pr_description_matches"].includes(trigger),
        );
        const parsed = ruleInputSchema.parse({
          name: flag("name") ?? existing?.name,
          repo: flag("repo") ?? existing?.repo,
          enabled: has("disabled") ? false : (existing?.enabled ?? true),
          mode: has("live") ? "live" : has("shadow") ? "shadow" : (existing?.mode ?? "shadow"),
          triggers: parsedTriggers,
          commentKeywords: list("keyword") ?? existing?.commentKeywords ?? [],
          conditions,
          authorTrust: flag("trust") ?? existing?.authorTrust ?? "write_access",
          requesterTrust: flag("requester-trust") ?? existing?.requesterTrust ?? "write_access",
          prompt: flag("prompt") ?? existing?.prompt ?? "",
          request: existing?.request ?? null,
          dedupe:
            flag("dedupe") ??
            existing?.dedupe ??
            (keywordTrigger ? "once_per_trigger_event" : "once_per_pr"),
          reviewStrategy: flag("strategy") ?? existing?.reviewStrategy ?? "update",
          visibility: has("hidden")
            ? "hidden"
            : has("visible")
              ? "visible"
              : (existing?.visibility ?? "visible"),
        });

        // Agent configuration from the CLI, so another BB agent can create a
        // dispatchable rule without opening the panel.
        const projectFlag = flag("project");
        let request = existing?.request ?? null;
        if (projectFlag !== undefined || flag("model") !== undefined) {
          const projects = await bb.sdk.projects.list();
          const project =
            projectFlag === undefined
              ? null
              : (projects.find((entry) => entry.id === projectFlag) ??
                projects.find((entry) => entry.name === projectFlag) ??
                null);
          if (projectFlag !== undefined && project === null) {
            return fail(
              `no project named '${projectFlag}'. Available: ${projects
                .map((entry) => entry.name)
                .join(", ")}`,
            );
          }
          const previous = (request ?? {}) as Record<string, unknown>;
          request = {
            ...previous,
            projectId: project?.id ?? (previous.projectId as string),
            providerId: flag("provider") ?? previous.providerId ?? "claude-code",
            model: flag("model") ?? previous.model ?? "claude-opus-5",
            reasoningLevel: flag("reasoning") ?? previous.reasoningLevel ?? "high",
            // BB's permission modes are full | auto | accept-edits — there is
            // no read-only tier, so `auto` is the narrowest sensible default.
            permissionMode: flag("permission") ?? previous.permissionMode ?? "auto",
            executionInputSources: previous.executionInputSources ?? {
              providerId: "explicit",
              model: "explicit",
              reasoningLevel: "explicit",
              permissionMode: "explicit",
            },
            environment: previous.environment ?? { type: "project-default" },
          } as never;
        }
        parsed.request = request as never;

        const rule = saveRule(existing?.id ?? null, parsed);
        announce();
        const warning = isDangerousCombination(rule)
          ? "\nWARNING: this rule reviews PRs from ANY author, so untrusted code can run."
          : "";
        const unconfigured =
          rule.request === null
            ? "\nNote: no agent configured yet — open the rule in the SlopCop panel and save it once before it can dispatch."
            : "";
        return ok(
          json
            ? JSON.stringify(toRuleOutput(rule), null, 2)
            : `${sub === "add" ? "Created" : "Updated"} '${rule.name}' (${rule.id}) in ${rule.mode} mode.${unconfigured}${warning}`,
        );
      }

      if (command === "rules" && (sub === "enable" || sub === "disable" || sub === "rm")) {
        const rule = resolveRule(argv[2] ?? "");
        if (sub === "rm") {
          store.deleteRule(rule.id);
          announce();
          return ok(`Deleted '${rule.name}'.`);
        }
        const now = Date.now();
        const enabled = sub === "enable";
        store.upsertRule({
          ...rule,
          enabled,
          updatedAt: now,
          commentTriggerEnabledAt:
            enabled && !rule.enabled && rule.triggers.includes("comment_matches")
              ? now
              : rule.commentTriggerEnabledAt,
        });
        announce();
        return ok(`${sub === "enable" ? "Enabled" : "Disabled"} '${rule.name}'.`);
      }

      if (command === "runs") {
        const ruleFlag = flag("rule");
        const rule = ruleFlag === undefined ? null : resolveRule(ruleFlag);
        const limitFlag = Number.parseInt(flag("limit") ?? "20", 10);
        const runs = store.listRuns({
          ruleId: rule?.id,
          limit: Number.isFinite(limitFlag) ? limitFlag : 20,
        });
        if (json) return ok(JSON.stringify(runs, null, 2));
        if (runs.length === 0) return ok("No runs yet.");
        return ok(
          runs
            .map(
              (run) =>
                `${run.status.padEnd(24)} ${run.ruleName}  ${
                  run.targetKind === "issue" ? "issue" : "PR"
                } #${run.prNumber} ${run.prTitle}` +
                (run.commentCount > 0 ? `  (${run.commentCount} comment(s))` : "") +
                (run.detail === null ? "" : `\n    ${run.detail}`),
            )
            .join("\n"),
        );
      }

      if (command === "verify") {
        const target = argv[1] ?? "";
        const run =
          (target === "" ? null : store.getRun(target)) ?? store.listRuns({ limit: 1 })[0];
        if (run === undefined || run === null) return fail("no such run");
        if (run.mode === "shadow") {
          return fail("shadow runs post nothing, so there is nothing on GitHub to verify");
        }
        const result = await verifyLive({
          gh,
          repo: run.repo,
          prNumber: run.prNumber,
          targetKind: run.targetKind,
          runId: run.id,
          startedAt: run.startedAt,
          authenticatedLogin: ghLogin,
        });
        store.replaceComments(run.id, result.comments);
        store.updateRun(run.id, {
          status: result.status,
          detail: result.detail,
          commentCount: result.comments.length,
        });
        announce();
        return ok(
          json
            ? JSON.stringify(result, null, 2)
            : `${run.id}: ${result.status} (${result.comments.length} comment(s))${
                result.detail === null ? "" : `\n${result.detail}`
              }`,
        );
      }

      if (command === "show") {
        const runId = argv[1] ?? "";
        const run = store.getRun(runId) ?? store.listRuns({ limit: 1 })[0];
        if (run === undefined || run === null) return fail("no such run");
        const comments = store.listComments(run.id);
        if (json) return ok(JSON.stringify({ run, comments }, null, 2));
        const header =
          `${run.ruleName} — ${run.targetKind === "issue" ? "issue" : "PR"} ${run.repo}#${run.prNumber} ${run.prTitle}\n` +
          `status: ${run.status}${run.mode === "shadow" ? " (shadow — nothing was posted)" : ""}` +
          (run.detail === null ? "" : `\ndetail: ${run.detail}`);
        const bodies = comments
          .map(
            (comment) =>
              `\n--- ${comment.kind}${
                comment.path === null ? "" : ` ${comment.path}:${comment.line ?? ""}`
              } [${comment.attribution}]${comment.url === null ? "" : ` ${comment.url}`} ---\n${comment.bodyExcerpt}`,
          )
          .join("\n");
        return ok(`${header}\n${bodies || "\n(no comments recorded)"}`);
      }

      if (command === "check" || command === "dispatch") {
        const rule = resolveRule(argv[1] ?? "");
        const number = Number.parseInt(argv[2] ?? "", 10);
        if (!Number.isFinite(number)) {
          return fail("expected an issue or PR number");
        }
        const listensOnlyForIssues =
          rule.triggers.includes("new_issue") &&
          !rule.triggers.some(
            (trigger) => trigger === "ready_for_review" || trigger === "new_commits",
          );
        const targetKind = has("issue") || listensOnlyForIssues ? "issue" : "pull_request";
        const targetLabel = targetKind === "issue" ? "issue" : "PR";

        if (command === "check") {
          const { target, result } = await checkTarget(rule, targetKind, number);
          const payload = {
            matched: result.matched,
            reason: result.matched ? null : result.reason,
            target: {
              kind: target.kind,
              number: target.number,
              title: target.title,
              author: target.author?.login ?? "",
              association: target.authorAssociation,
            },
          };
          return ok(
            json
              ? JSON.stringify(payload, null, 2)
              : result.matched
                ? `MATCH — '${rule.name}' would handle ${targetLabel} #${number} (${target.title}) in ${rule.mode} mode.`
                : `NO MATCH — ${result.reason}`,
          );
        }

        const { target, result } = await checkTarget(rule, targetKind, number);
        if (!result.matched && !has("force")) {
          return fail(
            `'${rule.name}' does not match ${targetLabel} #${number}: ${result.reason}\nRe-run with --force to dispatch anyway.`,
          );
        }
        const dispatched = await dispatch(rule, target, {
          forcedReason: result.matched ? null : result.reason,
        });
        return ok(
          json
            ? JSON.stringify(dispatched, null, 2)
            : `Dispatched ${rule.name} for ${targetLabel} #${number} (${rule.mode} mode). run=${dispatched.runId} thread=${dispatched.threadId ?? "none"}`,
        );
      }

      return fail(
        "Usage: bb slopcop <rules|runs|show|verify|check|dispatch|status> …\nRun `bb slopcop rules` to list rules.",
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };

  // --- watcher -------------------------------------------------------------

  bb.background.service("watcher", {
    async start(signal) {
      const initial = await readSettings();
      gh = createGhClient(initial.ghPath);
      ghLogin = await gh.authenticatedLogin();
      if (ghLogin === null) {
        bb.status.needsConfiguration(
          "`gh` is not authenticated on this machine. Run `gh auth login`, then reload the plugin.",
        );
        return;
      }
      bb.log.info(`gh authenticated as ${ghLogin}`);

      while (!signal.aborted) {
        const values = await readSettings();
        try {
          await poll(values.maxConcurrent);
        } catch (error) {
          bb.log.error(
            `poll pass failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, values.pollSeconds * 1_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve(undefined);
            },
            { once: true },
          );
        });
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });

  return { handlers, runCli };
}

type Services = ReturnType<typeof createServices>;
/** What every command receives: the host plus the plugin services. */
type PluginContext = Readonly<{ bb: BbPluginApi } & Services>;
const options = {
  paths: { type: "string", description: "Match comma-separated changed-file globs." },
  label: { type: "string", description: "Require comma-separated labels." },
  "skip-label": { type: "string", description: "Exclude comma-separated labels." },
  "exclude-author": {
    type: "string",
    description:
      "Replace excluded PR authors (comma-separated usernames, optional @); use an empty string to clear.",
  },
  trigger: { type: "string", description: "Comma-separated trigger names." },
  keyword: { type: "string", description: "Comma-separated literal request keywords." },
  base: { type: "string", description: "Match a base branch glob." },
  name: { type: "string", description: "Rule display name." },
  repo: { type: "string", description: "GitHub repository as owner/repo." },
  trust: {
    type: "string",
    description: "Author trust policy: org_members, write_access, past_contributors, or anyone.",
  },
  "requester-trust": { type: "string", description: "Trust policy for comment requesters." },
  prompt: { type: "string", description: "Instructions for the dispatched agent." },
  dedupe: { type: "string", description: "Dispatch deduplication policy." },
  strategy: { type: "string", description: "Update an existing review or create a new one." },
  project: { type: "string", description: "BB project name or ID for dispatched threads." },
  model: { type: "string", description: "Model ID for dispatched threads." },
  provider: { type: "string", description: "Agent provider ID." },
  reasoning: { type: "string", description: "Reasoning effort for dispatched threads." },
  permission: { type: "string", description: "Permission mode for dispatched threads." },
  rule: { type: "string", description: "Filter by rule name or ID." },
  limit: { type: "string", description: "Maximum number of results." },
  json: { type: "boolean", description: "Print the result as JSON." },
  disabled: { type: "boolean", description: "Save the rule disabled." },
  live: { type: "boolean", description: "Post results to GitHub." },
  shadow: { type: "boolean", description: "Run without posting results to GitHub." },
  hidden: { type: "boolean", description: "Hide dispatched review threads." },
  visible: { type: "boolean", description: "Show dispatched review threads." },
  issue: { type: "boolean", description: "Target a GitHub issue instead of a pull request." },
  force: { type: "boolean", description: "Dispatch even when the rule does not match." },
} as const;

type CommandSpec = {
  name: string;
  summary: string;
  description: string;
  optionKeys: readonly (keyof typeof options)[];
  positionals?: readonly PluginCliPositional[];
};
function forwardCommand(ctx: PluginContext, spec: CommandSpec) {
  const positionals = spec.positionals ?? [];
  return cliCommand({
    summary: spec.summary,
    description: spec.description,
    options: Object.fromEntries(spec.optionKeys.map((key) => [key, options[key]])),
    positionals,
    run: (input) =>
      ctx.runCli([
        spec.name,
        ...positionals.flatMap(({ name }) => {
          const value = input.positionals[name];
          return value === undefined ? [] : Array.isArray(value) ? value : [value];
        }),
        ...Object.entries(input.options).flatMap(([key, value]) =>
          value === undefined || value === false
            ? []
            : value === true
              ? [`--${key}`]
              : (Array.isArray(value) ? value : [value]).flatMap((item) => [
                  `--${key}`,
                  String(item),
                ]),
        ),
      ]),
  });
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx: PluginContext = Object.freeze({ bb, ...createServices(bb) });
  bb.rpc.register(rpcContract, ctx.handlers);
  bb.cli.register(
    defineCli({
      name: "slopcop",
      summary: "CLI for the slopcop plugin",
      commands: {
        rules: forwardCommand(ctx, {
          name: "rules",
          summary: "List, add, edit, enable, disable, or remove rules",
          description:
            "Usage: bb slopcop rules [--json]; rules add --name <name> --repo <owner/repo> --project <project> [options]; rules edit <rule> [options]; rules enable|disable|rm <rule>. New rules use shadow mode.",
          optionKeys: [
            "paths",
            "label",
            "skip-label",
            "exclude-author",
            "trigger",
            "keyword",
            "base",
            "name",
            "repo",
            "trust",
            "requester-trust",
            "prompt",
            "dedupe",
            "strategy",
            "project",
            "model",
            "provider",
            "reasoning",
            "permission",
            "json",
            "disabled",
            "live",
            "shadow",
            "hidden",
            "visible",
          ],
          positionals: [
            { name: "action", description: "add, edit, enable, disable, rm, or omit to list." },
            { name: "rule", description: "Rule name or ID for edit, enable, disable, or rm." },
          ],
        }),
        runs: forwardCommand(ctx, {
          name: "runs",
          summary: "Show recent review runs",
          description: "Usage: bb slopcop runs [--rule <rule>] [--limit <count>] [--json].",
          optionKeys: ["rule", "limit", "json"],
          positionals: [],
        }),
        check: forwardCommand(ctx, {
          name: "check",
          summary: "Check a rule against a PR or issue",
          description:
            "Usage: bb slopcop check <rule> <number> [--issue] [--json]. Does not dispatch.",
          optionKeys: ["issue", "json"],
          positionals: [
            { name: "rule", description: "Rule name or ID.", required: true },
            { name: "number", description: "Pull request or issue number.", required: true },
          ],
        }),
        dispatch: forwardCommand(ctx, {
          name: "dispatch",
          summary: "Dispatch a rule for a PR or issue",
          description: "Usage: bb slopcop dispatch <rule> <number> [--issue] [--force] [--json].",
          optionKeys: ["issue", "force", "json"],
          positionals: [
            { name: "rule", description: "Rule name or ID.", required: true },
            { name: "number", description: "Pull request or issue number.", required: true },
          ],
        }),
        verify: forwardCommand(ctx, {
          name: "verify",
          summary: "Verify a live run against GitHub",
          description: "Usage: bb slopcop verify [run-id] [--json]. Defaults to the latest run.",
          optionKeys: ["json"],
          positionals: [{ name: "runId", description: "Run ID; omit for the latest run." }],
        }),
        show: forwardCommand(ctx, {
          name: "show",
          summary: "Show a run and its review body",
          description: "Usage: bb slopcop show [run-id] [--json]. Defaults to the latest run.",
          optionKeys: ["json"],
          positionals: [{ name: "runId", description: "Run ID; omit for the latest run." }],
        }),
        status: forwardCommand(ctx, {
          name: "status",
          summary: "Show GitHub authentication and watched repositories",
          description: "Usage: bb slopcop status [--json].",
          optionKeys: ["json"],
          positionals: [],
        }),
      },
    }),
  );
}
