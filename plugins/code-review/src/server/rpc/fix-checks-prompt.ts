import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { type Check, type PrRef, accountSchema, prRefSchema } from "../../shared/schema.ts";
import { jobLogTail, loadChecks } from "../lib/checks.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import type { Gh } from "../lib/gh.ts";
import { findProject, freshWorktree } from "../lib/projects.ts";
import { type FailedCheck, fixChecksPrompt as fixPrompt } from "../lib/prompts.ts";
import { loadPrHead } from "../lib/pull-request.ts";

/** Logs fetched per prompt: each is a GitHub request, and three failures say enough. */
const MAX_LOGS = 3;

/** Only a failed GitHub Actions job has a log to read. */
const hasLog = (check: Check) => check.state === "failure" && check.jobId !== null;

async function logOf(
  gh: Gh,
  ref: PrRef,
  check: Check,
  fetched: Set<Check>,
): Promise<FailedCheck["log"]> {
  if (check.state !== "failure") return { missing: `the check is ${check.state}.` };
  if (check.jobId === null) return { missing: "not a GitHub Actions job." };
  if (!fetched.has(check)) return { missing: "not fetched; open the URL." };
  try {
    return { text: await jobLogTail(gh, ref, check.jobId) };
  } catch (error) {
    return { missing: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The prompt the Fix composer opens with: the selected checks with the end
 * of each failed job's log, plus the repository's bb project and a fresh
 * worktree in it, if there is a project.
 */
export const fixChecksPrompt = defineQuery({
  input: z.strictObject({
    account: accountSchema,
    ref: prRefSchema,
    checkIds: z.array(z.string().min(1)).min(1).max(10),
  }),
  output: z.strictObject({
    prompt: z.string(),
    projectId: z.string().nullable(),
    environment: z
      .strictObject({
        type: z.literal("host"),
        hostId: z.string().optional(),
        workspace: z.strictObject({
          type: z.literal("managed-worktree"),
          baseBranch: z.strictObject({ kind: z.literal("default") }),
        }),
      })
      .nullable(),
  }),
  async execute(ctx: CodeReviewContext, { account, ref, checkIds }) {
    const gh = ctx.github.as(account);
    const [pr, { checks }, project] = await Promise.all([
      loadPrHead(gh, ref),
      loadChecks(gh, ref),
      findProject(ctx.bb, ref.owner, ref.repo),
    ]);
    const wanted = new Set(checkIds);
    const selected = checks.filter((check) => wanted.has(check.id));
    if (selected.length === 0) {
      throw new Error("Those checks are no longer on the latest commit. Refresh and try again.");
    }
    const fetched = new Set(selected.filter(hasLog).slice(0, MAX_LOGS));
    const failed = await Promise.all(
      selected.map(async (check) => ({ check, log: await logOf(gh, ref, check, fetched) })),
    );
    return {
      prompt: fixPrompt(pr, failed),
      projectId: project?.id ?? null,
      environment: project ? freshWorktree(project) : null,
    };
  },
});
