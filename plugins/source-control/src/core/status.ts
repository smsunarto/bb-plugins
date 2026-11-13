/**
 * Every status a surface shows for a Change, derived from one summary by
 * pure functions: the ship path, the attention chips, the phone's status
 * line, the primary action and the sort key. The tab header, the composer
 * strip and outside consumers such as the sidebar call these, so they
 * cannot disagree.
 */
import { z } from "zod";
import {
  findBranch,
  uncommittedCount,
  type Branch,
  type PullRequest,
  type ThreadChange,
} from "./change.ts";
import { changeKeySchema, type ChangeKey } from "./ids.ts";

/** What the derivations read: one Change as its facets last said. */
export type ChangeSummary = {
  key: ChangeKey | null;
  branch: Branch | null;
  /** The checkout has a GitHub remote, so the branch can be pushed and reviewed. */
  onGitHub: boolean;
  uncommitted: number;
  conflicted: boolean;
  /** Undefined until the forge facet has been read once; null for a branch with none. */
  pullRequest: PullRequest | null | undefined;
  /** Open review findings. Zero until the review loop lands. */
  findings: number;
};

/** The summary of a thread's Change, or null while it has no read checkout. */
export function summarize(row: ThreadChange | undefined, findings = 0): ChangeSummary | null {
  if (row?.state !== "checkout") return null;
  const workspace = row.local.read?.value;
  if (!workspace) return null;
  const branch = findBranch(workspace, row.branch);
  return {
    key: row.key,
    branch,
    onGitHub: workspace.github !== null,
    uncommitted: uncommittedCount(workspace),
    conflicted: workspace.conflicted.length > 0 || branch?.status === "conflicted",
    pullRequest: row.forge.read ? row.forge.read.value : undefined,
    findings,
  };
}

const commitCount = (branch: Branch | null) =>
  branch ? branch.commits.length + branch.moreCommits : 0;
const UNPUSHED = new Set(["unpushed", "ahead", "diverged"]);
const unpushed = (branch: Branch | null) => !!branch && UNPUSHED.has(branch.status);
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function checksOf(pr: PullRequest | null | undefined) {
  return pr?.checks ?? { passed: 0, failed: 0, pending: 0 };
}

/** GitHub cannot merge the open pull request's head into its base without a conflict. */
export function conflictsWithBase(pr: PullRequest | null | undefined): boolean {
  return pr?.state === "open" && pr.mergeable === "conflicting";
}

/** Open, out of draft, approved, mergeable, every check passed: nothing stands between it and merging. */
function readyToMerge(pr: PullRequest | null | undefined): boolean {
  if (!pr || pr.state !== "open" || pr.isDraft || pr.reviewDecision !== "approved") return false;
  if (pr.mergeable !== "mergeable") return false;
  const checks = checksOf(pr);
  return checks.failed === 0 && checks.pending === 0;
}

// ── Ship path ──────────────────────────────────────────────────────────

export type StepState = "done" | "current" | "running" | "failed" | "todo";
export type ShipStep = {
  id: "committed" | "pushed" | "pullRequest" | "checks" | "approval" | "merged";
  label: string;
  state: StepState;
  /** Counts after the label, as the checks step shows "2 running · 9 passed". */
  detail: { text: string; tone: "warning" | "error" | "muted" }[];
};

/** A ship path as a read carries it, for a surface that has no branch or pull request of its own. */
export const shipStepSchema = z
  .object({
    id: z.enum(["committed", "pushed", "pullRequest", "checks", "approval", "merged"]),
    label: z.string(),
    state: z.enum(["done", "current", "running", "failed", "todo"]),
    detail: z.array(
      z.object({ text: z.string(), tone: z.enum(["warning", "error", "muted"]) }).strict(),
    ),
  })
  .strict() satisfies z.ZodType<ShipStep>;

function step(
  id: ShipStep["id"],
  label: string,
  state: StepState,
  detail: ShipStep["detail"] = [],
) {
  return { id, label, state, detail } satisfies ShipStep;
}

function pullRequestStep(pr: PullRequest | null | undefined): ShipStep {
  if (!pr) return step("pullRequest", "Pull request", "todo");
  if (pr.state === "closed") return step("pullRequest", "Closed", "failed");
  if (pr.state === "merged") return step("pullRequest", "Opened", "done");
  return pr.isDraft
    ? step("pullRequest", "Draft, waiting on you", "current")
    : step("pullRequest", "Ready for review", "done");
}

function checksStep(pr: PullRequest | null | undefined): ShipStep {
  const { passed, failed, pending } = checksOf(pr);
  const passedText = { text: `${passed} passed`, tone: "muted" as const };
  if (!pr || passed + failed + pending === 0) return step("checks", "Checks", "todo");
  if (failed > 0)
    return step("checks", "Checks", "failed", [
      { text: `${failed} failed`, tone: "error" },
      ...(passed > 0 ? [{ ...passedText, text: `· ${passedText.text}` }] : []),
    ]);
  if (pending > 0)
    return step("checks", "Checks", "running", [
      { text: `${pending} running`, tone: "warning" },
      ...(passed > 0 ? [{ ...passedText, text: `· ${passedText.text}` }] : []),
    ]);
  return step("checks", "Checks", "done", [passedText]);
}

function approvalStep(pr: PullRequest | null | undefined): ShipStep {
  if (pr?.reviewDecision === "approved" || (pr?.state === "merged" && pr.approvals > 0))
    return step("approval", "Approved", "done");
  if (pr?.reviewDecision === "changes-requested")
    return step("approval", "Changes requested", "failed");
  return step(
    "approval",
    "Approval",
    "todo",
    pr && pr.approvals > 0 ? [{ text: `${pr.approvals} approved`, tone: "muted" }] : [],
  );
}

/**
 * Committed, Pushed, the pull request, Checks, Approval, Merged: where the
 * Change is on its way in. With no GitHub remote it can never get a pull
 * request, so the path ends at Pushed when the branch has a remote to push
 * to, else at Committed.
 */
/** Whether the Change has commits, and whether all of them are on the remote. */
function progress(summary: ChangeSummary): { committed: boolean; pushed: boolean } {
  const { branch, pullRequest: pr } = summary;
  const merged = pr?.state === "merged";
  // A pull request read with no checkout of its branch was committed and pushed by someone.
  const published = !branch && !!pr;
  const committed = merged || published || commitCount(branch) > 0;
  const pushed =
    merged ||
    published ||
    (committed && !!branch?.remote && !unpushed(branch) && branch.status !== "unknown");
  return { committed, pushed };
}

export const changeStateSchema = z
  .object({
    /** "Draft", "Open", "Merged", "Closed", "Pushed", "Unpushed" or "Local branch". */
    label: z.string(),
    tone: z.enum(["local", "pushed", "draft", "open", "merged", "closed"]),
    /** The pull request's number, when there is one. */
    number: z.number().int().positive().nullable(),
    /** Read from GitHub and there is none: "Pushed, no pull request". */
    noPullRequest: z.boolean(),
  })
  .strict();
export type ChangeState = z.infer<typeof changeStateSchema>;

const PR_LABEL = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" } as const;

/**
 * Where the Change stands, as the chat card's chip and the composer strip's
 * lead both say it: the pull request's state, or how far the branch got.
 */
export function changeState(summary: ChangeSummary): ChangeState {
  const pr = summary.pullRequest;
  if (pr) {
    const tone = pr.state === "open" ? (pr.isDraft ? "draft" : "open") : pr.state;
    return { label: PR_LABEL[tone], tone, number: pr.number, noPullRequest: false };
  }
  const { pushed } = progress(summary);
  const noPullRequest = pr === null;
  if (pushed) return { label: "Pushed", tone: "pushed", number: null, noPullRequest };
  if (summary.branch?.remote)
    return { label: "Unpushed", tone: "local", number: null, noPullRequest };
  return { label: "Local branch", tone: "local", number: null, noPullRequest };
}

export function shipPath(summary: ChangeSummary): ShipStep[] {
  const { branch, pullRequest: pr } = summary;
  const { committed, pushed } = progress(summary);
  const steps = [
    step(
      "committed",
      "Committed",
      committed ? "done" : summary.uncommitted > 0 ? "current" : "todo",
    ),
    step(
      "pushed",
      "Pushed",
      pushed ? "done" : committed && (summary.onGitHub || !!branch?.remote) ? "current" : "todo",
    ),
  ];
  if (!summary.onGitHub && !pr) return branch?.remote ? steps : steps.slice(0, 1);
  return [...steps, pullRequestStep(pr), checksStep(pr), approvalStep(pr), mergedStep(pr)];
}

/** Merged; a pull request that conflicts with its base cannot get there until it is updated. */
function mergedStep(pr: PullRequest | null | undefined): ShipStep {
  if (pr?.state === "merged") return step("merged", "Merged", "done");
  if (conflictsWithBase(pr))
    return step("merged", "Merged", "failed", [
      { text: `Conflicts with ${pr!.baseRef}`, tone: "error" },
    ]);
  return step("merged", "Merged", "todo");
}

// ── Attention chips ────────────────────────────────────────────────────

export type ChipTone = "neutral" | "warning" | "error" | "success" | "merged";
export type AttentionChip = {
  id: string;
  /** Count first and capitalised: "4 Findings", "2 Running". */
  label: string;
  tone: ChipTone;
  icon: "dot" | "cross" | "check" | null;
};

/** What asks for attention, most urgent first. */
export function attentionChips(summary: ChangeSummary): AttentionChip[] {
  const pr = summary.pullRequest;
  const { passed, failed, pending } = checksOf(pr);
  const chips: AttentionChip[] = [];
  const add = (chip: AttentionChip) => chips.push(chip);
  if (summary.findings > 0)
    add({ id: "findings", label: `${summary.findings} Findings`, tone: "neutral", icon: null });
  if (pr?.state === "merged") {
    add({ id: "merged", label: "Merged", tone: "merged", icon: null });
    return chips;
  }
  if (summary.conflicted)
    add({ id: "conflicted", label: "Conflicted", tone: "error", icon: "cross" });
  if (conflictsWithBase(pr))
    add({ id: "conflicts", label: "Conflicts", tone: "error", icon: "cross" });
  if (failed > 0) add({ id: "failed", label: `${failed} Failed`, tone: "error", icon: "cross" });
  if (pending > 0)
    add({ id: "running", label: `${pending} Running`, tone: "warning", icon: "dot" });
  if (pr?.reviewDecision === "changes-requested")
    add({ id: "changes", label: "Changes requested", tone: "error", icon: null });
  if (readyToMerge(pr)) add({ id: "ready", label: "Ready to merge", tone: "success", icon: null });
  if (pr && failed === 0 && pending === 0 && passed > 0)
    add({ id: "passed", label: "Passed", tone: "success", icon: "check" });
  if (!pr && summary.branch && (unpushed(summary.branch) || !summary.branch.remote))
    add({ id: "local", label: "Local", tone: "neutral", icon: null });
  return chips;
}

// ── Phone status line ──────────────────────────────────────────────────

/** Before a pull request, or before GitHub has answered: how far the branch got. */
function unpublishedLine(summary: ChangeSummary): string {
  if (commitCount(summary.branch) === 0)
    return summary.uncommitted > 0 ? `${summary.uncommitted} uncommitted` : "No commits yet";
  if (unpushed(summary.branch) || !summary.branch?.remote) return "Local, not pushed";
  return summary.pullRequest === null ? "Pushed, no pull request" : "Pushed";
}

function draftLine(summary: ChangeSummary, pending: number): string {
  if (summary.findings > 0) return `Draft · ${plural(summary.findings, "finding")} to settle`;
  if (pending > 0) return `Draft · ${plural(pending, "check")} running`;
  return "Draft";
}

/** One line saying what the Change is waiting on, as the phone list shows it. */
export function statusLine(summary: ChangeSummary): string {
  const pr = summary.pullRequest;
  const { failed, pending } = checksOf(pr);
  if (pr?.state === "merged") return "Merged";
  if (pr?.state === "closed") return "Closed";
  if (summary.conflicted) return "Conflicted";
  if (!pr) return unpublishedLine(summary);
  if (conflictsWithBase(pr)) return `Conflicts with ${pr.baseRef}`;
  if (failed > 0) return `${plural(failed, "check")} failed`;
  if (pr.reviewDecision === "changes-requested") return "Changes requested";
  if (pr.isDraft) return draftLine(summary, pending);
  if (pending > 0) return `${plural(pending, "check")} running`;
  return readyToMerge(pr) ? "Ready to merge" : "Review requested";
}

// ── Primary action ─────────────────────────────────────────────────────

export type PrimaryAction =
  | { kind: "push"; label: "Push" }
  | { kind: "ship"; label: "Ship it" }
  | { kind: "markReady"; label: "Mark ready" }
  | { kind: "merge"; label: "Merge" }
  | null;

/**
 * Pushed commits not yet in the target, and GitHub answered that the branch
 * has no pull request: the next step is the thread's agent shipping it.
 */
function canOpenPullRequest({ branch, onGitHub, pullRequest }: ChangeSummary): boolean {
  if (pullRequest !== null || !onGitHub || !branch?.remote || branch.head === null) return false;
  return commitCount(branch) > 0 && (branch.status === "pushed" || branch.status === "behind");
}

/** The one next step the Change's owner takes, or null when it waits on someone else. */
export function primaryAction(summary: ChangeSummary): PrimaryAction {
  const pr = summary.pullRequest;
  if (pr?.state === "merged" || pr?.state === "closed" || summary.conflicted) return null;
  if (conflictsWithBase(pr)) return null;
  if (unpushed(summary.branch) && summary.onGitHub) return { kind: "push", label: "Push" };
  if (canOpenPullRequest(summary)) return { kind: "ship", label: "Ship it" };
  if (pr?.isDraft) return { kind: "markReady", label: "Mark ready" };
  if (readyToMerge(pr)) return { kind: "merge", label: "Merge" };
  return null;
}

/** The branch holds commits of its own, or already has a pull request: there is a Change to review. */
export function hasWork(summary: ChangeSummary): boolean {
  return !!summary.pullRequest || commitCount(summary.branch) > 0;
}

/**
 * The branch has work its thread's agent can still ship: commits the remote
 * lacks, or a pushed branch GitHub has no pull request for. Uncommitted files
 * do not count here: in a checkout several threads share they may be
 * anyone's, so only a thread with no commits of its own is offered them.
 */
export function canShip(summary: ChangeSummary): boolean {
  const { branch, pullRequest: pr } = summary;
  if (pr?.state === "merged" || pr?.state === "closed") return false;
  if (!branch || commitCount(branch) === 0) return false;
  if (unpushed(branch)) return true;
  // No remote branch yet: shippable where there is a GitHub repository to push to.
  if (!branch.remote) return summary.onGitHub;
  // Pushed, and GitHub answered that it has no pull request: the agent opens one.
  const pushed = branch.status === "pushed" || branch.status === "behind";
  return pr === null && summary.onGitHub && pushed && branch.head !== null;
}

// ── Sort key ───────────────────────────────────────────────────────────

/**
 * Lists sort by this, lowest first: what needs its owner, then what is
 * moving, then what waits on others, then what is done.
 */
export function sortKey(summary: ChangeSummary): number {
  const pr = summary.pullRequest;
  const { failed, pending } = checksOf(pr);
  if (pr?.state === "merged" || pr?.state === "closed") return 9;
  if (summary.conflicted || conflictsWithBase(pr)) return 0;
  if (failed > 0 || pr?.reviewDecision === "changes-requested") return 1;
  if (summary.findings > 0 || pr?.isDraft || unpushed(summary.branch)) return 2;
  if (readyToMerge(pr)) return 3;
  if (pending > 0) return 4;
  if (!pr) return 5;
  return 6;
}

// ── Compact status for other surfaces ──────────────────────────────────

export const chipSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    tone: z.enum(["neutral", "warning", "error", "success", "merged"]),
    icon: z.enum(["dot", "cross", "check"]).nullable(),
  })
  .strict();

/**
 * A thread's Change as other plugins draw it in a list row: small, and
 * already derived, so a row says what the tab and the strip say.
 */
export const threadStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("none") }).strict(),
  z
    .object({
      state: z.literal("change"),
      key: changeKeySchema.nullable(),
      branch: z.string().nullable(),
      pullRequest: z
        .object({
          number: z.number().int().positive(),
          title: z.string(),
          url: z.string(),
          state: z.enum(["draft", "open", "merged", "closed"]),
        })
        .strict()
        .nullable(),
      line: z.string(),
      chips: z.array(chipSchema),
      /** The most urgent chip's tone, for a single tint. */
      tone: z.enum(["neutral", "warning", "error", "success", "merged"]),
      sort: z.number().int(),
    })
    .strict(),
]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

export function threadStatus(row: ThreadChange | undefined): ThreadStatus {
  if (!row || row.state === "pending") return { state: "pending" };
  const summary = summarize(row);
  if (!summary) return row.state === "none" ? { state: "none" } : { state: "pending" };
  const pr = summary.pullRequest ?? null;
  const chips = attentionChips(summary);
  return {
    state: "change",
    key: summary.key,
    branch: summary.branch?.name ?? null,
    pullRequest: pr && {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state === "open" ? (pr.isDraft ? "draft" : "open") : pr.state,
    },
    line: statusLine(summary),
    chips,
    tone: chips.find((chip) => chip.tone !== "neutral")?.tone ?? "neutral",
    sort: sortKey(summary),
  };
}
