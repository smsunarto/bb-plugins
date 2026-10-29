import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExecutionSettings } from "./execution-settings";
import type { ThreadRequest } from "./lib/types";

interface ConditionView {
  kind: string;
  globs?: string[];
  labels?: string[];
  logins?: string[];
  regex?: string;
  value?: number;
}

interface RuleView {
  id: string;
  name: string;
  repo: string;
  enabled: boolean;
  mode: string;
  triggers: string[];
  commentKeywords: string[];
  conditions: ConditionView[];
  authorTrust: string;
  requesterTrust: string;
  prompt: string;
  request: ThreadRequest | null;
  dedupe: string;
  reviewStrategy: string;
  visibility: string;
  dangerous: boolean;
}

interface RunView {
  id: string;
  ruleName: string;
  repo: string;
  targetKind: "pull_request" | "issue";
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  status: string;
  mode: string;
  trigger: string;
  detail: string | null;
  threadId: string | null;
  commentCount: number;
  startedAt: number;
}

interface CommentView {
  githubId: string | null;
  kind: string;
  path: string | null;
  line: number | null;
  url: string | null;
  bodyExcerpt: string;
  attribution: string;
}

const TRUST_LABEL: Record<string, string> = {
  org_members: "organization members only",
  write_access: "trusted authors only",
  past_contributors: "+ past contributors",
  anyone: "any author",
};

const STATUS_TONE: Record<string, string> = {
  commented: "text-success-foreground bg-success/15",
  shadowed: "text-timeline-accent bg-timeline-accent/15",
  reviewing: "text-timeline-accent bg-timeline-accent/15",
  dispatched: "text-muted-foreground bg-surface-recessed",
  commented_partial: "text-warning-text bg-surface-attention",
  commented_unmarked: "text-warning-text bg-surface-attention",
  commented_unattributed: "text-warning-text bg-surface-attention",
  no_comment: "text-warning-text bg-surface-attention",
  skipped: "text-muted-foreground bg-surface-recessed",
  failed: "text-destructive-text bg-surface-destructive",
};

function relative(timestamp: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function describeCondition(condition: ConditionView): string {
  switch (condition.kind) {
    case "paths":
      return `paths ${(condition.globs ?? []).join(", ")}`;
    case "base_branch":
      return `base ${(condition.globs ?? []).join(", ")}`;
    case "has_label":
      return `label ${(condition.labels ?? []).join(", ")}`;
    case "missing_label":
      return `skip label ${(condition.labels ?? []).join(", ")}`;
    case "author":
      return `author ${(condition.logins ?? []).join(", ")}`;
    case "exclude_author":
      return `exclude PR author ${(condition.logins ?? []).map((login) => `@${login}`).join(", ")}`;
    case "title_matches":
      return `title /${condition.regex}/`;
    case "max_changed_files":
      return `≤ ${condition.value} files`;
    default:
      return condition.kind;
  }
}

function Chip({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "trigger" | "guard" | "warn";
}) {
  const tones: Record<string, string> = {
    default: "border-border text-muted-foreground bg-surface-recessed",
    trigger: "border-timeline-accent/30 text-timeline-accent",
    guard: "border-success/30 text-success-foreground bg-success/10",
    warn: "border-attention/40 text-warning-text bg-surface-attention",
  };
  return (
    <span className={`rounded-md border px-1.5 py-px text-xs ${tones[tone]}`}>{children}</span>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      role="switch"
      aria-checked={on}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!on);
      }}
      className={`relative inline-block h-[17px] w-[30px] shrink-0 cursor-pointer rounded-full transition-colors ${
        on ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`absolute top-0.5 h-[13px] w-[13px] rounded-full transition-all ${
          on ? "left-[15px] bg-primary-foreground" : "left-0.5 bg-subtle-foreground"
        }`}
      />
    </button>
  );
}

// --------------------------------------------------------------------------

function RulesList({
  rules,
  onEdit,
  onToggle,
  onNew,
}: {
  rules: RuleView[];
  onEdit: (rule: RuleView) => void;
  onToggle: (rule: RuleView, enabled: boolean) => void;
  onNew: () => void;
}) {
  if (rules.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <p className="text-sm font-medium">No rules yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A rule watches one repo for pull requests or issues. New rules start in shadow mode — they
          run but post nothing until you promote them.
        </p>
        <Button size="sm" className="mt-4" onClick={onNew}>
          Create a rule
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {rules.map((rule) => (
        <div
          key={rule.id}
          className={`cursor-pointer rounded-lg border border-border bg-card p-3 text-left shadow-xs transition-colors hover:bg-state-hover ${
            rule.enabled ? "" : "opacity-60"
          }`}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onEdit(rule)}
              className="min-w-0 text-left text-sm font-semibold hover:underline"
            >
              {rule.name}
            </button>
            <span className="rounded-md border border-border bg-surface-recessed px-1.5 py-px font-mono text-xs text-muted-foreground">
              {rule.repo}
            </span>
            {rule.mode === "shadow" ? (
              <Chip tone="trigger">shadow</Chip>
            ) : (
              <Chip tone="guard">live</Chip>
            )}
            <span className="flex-1" />
            <Toggle
              label={`Enable ${rule.name}`}
              on={rule.enabled}
              onChange={(next) => onToggle(rule, next)}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {rule.triggers.map((trigger) => (
              <Chip key={trigger} tone="trigger">
                {
                  (
                    {
                      ready_for_review: "PR ready for review",
                      new_commits: "New commits",
                      new_issue: "New issue",
                      pr_description_matches: "PR description matches",
                      comment_matches: "Comment matches",
                    } as Record<string, string>
                  )[trigger]
                }
              </Chip>
            ))}
            {rule.commentKeywords.map((keyword) => (
              <Chip key={keyword}>{keyword}</Chip>
            ))}
            {rule.conditions.map((condition, index) => (
              <Chip key={index}>{describeCondition(condition)}</Chip>
            ))}
            <Chip tone={rule.authorTrust === "anyone" ? "warn" : "guard"}>
              {TRUST_LABEL[rule.authorTrust] ?? rule.authorTrust}
            </Chip>
            {rule.visibility === "hidden" ? <Chip>hidden threads</Chip> : null}
            {rule.dangerous ? <Chip tone="warn">⚠ untrusted code, full access</Chip> : null}
          </div>
          {rule.request === null ? (
            <p className="mt-2 text-xs text-warning-text">
              No agent configured — open and save once before it can dispatch.
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------

/**
 * Run a rule against one PR on demand.
 *
 * Deliberately two-step: it checks first and reports the rule's own verdict,
 * and only offers an override once the reason is on screen. A one-click force
 * would make bypassing the trust gate as cheap as an ordinary run, which
 * defeats the point of having one.
 */
function RunOnTarget({ rule }: { rule: RuleView }) {
  const rpc = useRpc<typeof rpcContract>();
  const supportsPullRequests = rule.triggers.some(
    (trigger) => trigger === "ready_for_review" || trigger === "new_commits",
  );
  const supportsIssues = rule.triggers.includes("new_issue");
  const [targetKind, setTargetKind] = useState<"pull_request" | "issue">(
    supportsIssues && !supportsPullRequests ? "issue" : "pull_request",
  );
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);

  const targetNumber = Number.parseInt(number, 10);
  const valid = Number.isFinite(targetNumber) && targetNumber > 0;
  const targetLabel = targetKind === "issue" ? "issue" : "PR";

  const run = useCallback(
    async (force: boolean) => {
      setBusy(true);
      try {
        const result = await rpc.call("dispatchNow", {
          ruleId: rule.id,
          prNumber: targetNumber,
          targetKind,
          force,
        });
        if (result.blockedReason !== null) {
          setBlocked(result.blockedReason);
          return;
        }
        setBlocked(null);
        setNumber("");
        toast.success(
          force
            ? `Forced ${rule.name} on ${targetLabel} #${targetNumber}`
            : `Running ${rule.name} on ${targetLabel} #${targetNumber}`,
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [rpc, rule.id, rule.name, targetKind, targetLabel, targetNumber],
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Run now</span>
        <span className="flex-1" />
        {supportsPullRequests && supportsIssues ? (
          <select
            value={targetKind}
            onChange={(event) => setTargetKind(event.target.value as "pull_request" | "issue")}
            className="h-7 rounded-md border border-input bg-card px-2 text-xs"
          >
            <option value="pull_request">PR</option>
            <option value="issue">Issue</option>
          </select>
        ) : null}
        <Input
          value={number}
          onChange={(event) => {
            setNumber(event.target.value.replace(/[^0-9]/g, ""));
            setBlocked(null);
          }}
          placeholder={`${targetLabel} #`}
          className="h-7 w-24"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!valid || busy}
          onClick={() => void run(false)}
        >
          {rule.mode === "shadow" ? "Dry run" : "Run"}
        </Button>
      </div>
      {blocked !== null ? (
        <div className="rounded-md bg-surface-attention p-2 text-xs leading-relaxed">
          <b className="text-warning-text">
            This rule would skip {targetLabel} #{targetNumber}:
          </b>{" "}
          {blocked}
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(true)}>
              Run anyway
            </Button>
            <span className="text-subtle-foreground">
              {rule.mode === "live"
                ? "This action can write to GitHub."
                : "The agent will process this target without a public post."}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface RuleDraft {
  name: string;
  repo: string;
  trust: string;
  requesterTrust: string;
  mode: string;
  visibility: string;
  prompt: string;
  request: ThreadRequest;
  triggers: string[];
  commentKeywords: string;
  pathGlobs: string;
  baseBranch: string;
  excludedAuthors: string;
}
// BB remounts nav panels when crossing its mobile layout breakpoint. Keep this
// browser's in-progress editor until Save or Cancel, without writing the rule.
const ruleDrafts = new Map<string, RuleDraft>();
let openRule: RuleView | null | "new" = null;

function RuleEditor({ rule, onDone }: { rule: RuleView | null; onDone: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const fieldId = useId();
  const draftKey = rule?.id ?? "new";
  const draft = ruleDrafts.get(draftKey);
  const [name, setName] = useState(draft?.name ?? rule?.name ?? "");
  const [repo, setRepo] = useState(draft?.repo ?? rule?.repo ?? "");
  const [trust, setTrust] = useState(draft?.trust ?? rule?.authorTrust ?? "write_access");
  const [requesterTrust, setRequesterTrust] = useState(
    draft?.requesterTrust ?? rule?.requesterTrust ?? "write_access",
  );
  const [mode, setMode] = useState(draft?.mode ?? rule?.mode ?? "shadow");
  const [visibility, setVisibility] = useState(draft?.visibility ?? rule?.visibility ?? "visible");

  const [prompt, setPrompt] = useState(draft?.prompt ?? rule?.prompt ?? "");
  const [request, setRequest] = useState<ThreadRequest>(
    draft?.request ??
      rule?.request ?? {
        projectId: "",
        providerId: "codex",
        model: "",
        permissionMode: "auto",
      },
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [triggers, setTriggers] = useState<string[]>(
    draft?.triggers ?? rule?.triggers ?? ["ready_for_review"],
  );
  const [commentKeywords, setCommentKeywords] = useState(
    draft?.commentKeywords ?? (rule?.commentKeywords ?? []).join(", "),
  );
  const [pathGlobs, setPathGlobs] = useState<string>(
    draft?.pathGlobs ??
      (rule?.conditions.find((condition) => condition.kind === "paths")?.globs ?? []).join(", "),
  );
  const [baseBranch, setBaseBranch] = useState<string>(
    draft?.baseBranch ??
      (rule?.conditions.find((condition) => condition.kind === "base_branch")?.globs ?? []).join(
        ", ",
      ),
  );
  const excludedAuthorsId = useId();
  const [excludedAuthors, setExcludedAuthors] = useState(
    () =>
      draft?.excludedAuthors ??
      (rule?.conditions ?? [])
        .filter((condition) => condition.kind === "exclude_author")
        .flatMap((condition) => condition.logins ?? [])
        .join(", "),
  );
  const excludedAuthorsError = excludedAuthors.split(",").some((value) => value.trim() === "@")
    ? "Add a GitHub username after @."
    : null;

  useEffect(() => {
    ruleDrafts.set(draftKey, {
      name,
      repo,
      trust,
      requesterTrust,
      mode,
      visibility,
      prompt,
      request,
      triggers,
      commentKeywords,
      pathGlobs,
      baseBranch,
      excludedAuthors,
    });
  }, [
    draftKey,
    name,
    repo,
    trust,
    requesterTrust,
    mode,
    visibility,
    prompt,
    request,
    triggers,
    commentKeywords,
    pathGlobs,
    baseBranch,
    excludedAuthors,
  ]);

  const conditions = useMemo(() => {
    const list = (rule?.conditions ?? []).filter(
      (condition) => !["paths", "base_branch", "exclude_author"].includes(condition.kind),
    );
    const globs = pathGlobs
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (globs.length > 0) list.push({ kind: "paths", globs });
    const bases = baseBranch
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (bases.length > 0) list.push({ kind: "base_branch", globs: bases });
    const logins = excludedAuthors
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (logins.length > 0) list.push({ kind: "exclude_author", logins });
    return list;
  }, [rule, pathGlobs, baseBranch, excludedAuthors]);

  const listensForPullRequests = triggers.some(
    (trigger) => trigger === "ready_for_review" || trigger === "new_commits",
  );
  const dangerous = trust === "anyone" && mode === "live" && listensForPullRequests;

  const hasUnsavedChanges =
    rule !== null &&
    (name !== rule.name ||
      repo !== rule.repo ||
      prompt !== rule.prompt ||
      mode !== rule.mode ||
      visibility !== rule.visibility ||
      trust !== rule.authorTrust ||
      requesterTrust !== rule.requesterTrust ||
      JSON.stringify(triggers) !== JSON.stringify(rule.triggers) ||
      pathGlobs !==
        (rule.conditions.find((condition) => condition.kind === "paths")?.globs ?? []).join(", ") ||
      baseBranch !==
        (rule.conditions.find((condition) => condition.kind === "base_branch")?.globs ?? []).join(
          ", ",
        ) ||
      excludedAuthors !==
        rule.conditions
          .filter((condition) => condition.kind === "exclude_author")
          .flatMap((condition) => condition.logins ?? [])
          .join(", ") ||
      commentKeywords !== rule.commentKeywords.join(", ") ||
      JSON.stringify(request) !== JSON.stringify(rule.request));

  const handleSubmit = useCallback(async () => {
    if (name.trim().length === 0) {
      throw new Error("Give the rule a name first");
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo.trim())) {
      throw new Error("Repository must look like owner/repo");
    }
    if (triggers.length === 0) {
      throw new Error("Select at least one trigger");
    }
    if (excludedAuthorsError !== null) {
      throw new Error(excludedAuthorsError);
    }
    const keywords = commentKeywords
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const usesKeywordTrigger = triggers.some((trigger) =>
      ["comment_matches", "pr_description_matches"].includes(trigger),
    );
    if (usesKeywordTrigger && keywords.length === 0) {
      throw new Error("Add at least one comment or description keyword");
    }
    if (
      !request.projectId ||
      !request.model ||
      (!request.environment && (!rule?.request || request.projectId !== rule.request.projectId))
    ) {
      throw new Error("Choose a project, workspace, and model in Agent settings.");
    }
    await rpc.call("saveRule", {
      id: rule?.id ?? null,
      rule: {
        name: name.trim(),
        repo: repo.trim(),
        enabled: rule?.enabled ?? true,
        mode: mode as "shadow" | "live",
        triggers: triggers as (
          | "ready_for_review"
          | "new_commits"
          | "new_issue"
          | "pr_description_matches"
          | "comment_matches"
        )[],
        commentKeywords: keywords,
        conditions: conditions as never,
        authorTrust: trust as "org_members" | "write_access" | "past_contributors" | "anyone",
        requesterTrust: requesterTrust as
          | "org_members"
          | "write_access"
          | "past_contributors"
          | "anyone",
        prompt,
        request,
        dedupe: (rule?.dedupe ??
          (usesKeywordTrigger ? "once_per_trigger_event" : "once_per_pr")) as
          | "once_per_pr"
          | "once_per_head_sha"
          | "once_per_trigger_event",
        reviewStrategy: (rule?.reviewStrategy ?? "update") as "update",
        visibility: visibility as "visible" | "hidden",
      },
    });
    toast.success(
      mode === "shadow"
        ? `Saved '${name}' in shadow mode — it reviews but posts nothing.`
        : `Saved '${name}' — it will post reviews to ${repo}.`,
    );
    onDone();
  }, [
    commentKeywords,
    conditions,
    excludedAuthorsError,
    mode,
    name,
    onDone,
    repo,
    requesterTrust,
    rpc,
    rule,
    triggers,
    trust,
    visibility,
    prompt,
    request,
  ]);

  return (
    <div className="@container min-w-0">
      <form
        className="flex min-w-0 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          setSaveError(null);
          void handleSubmit()
            .catch((error: unknown) => {
              setSaveError(
                error instanceof Error ? error.message : "Could not save the rule. Try again.",
              );
            })
            .finally(() => setSaving(false));
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{rule ? "Edit rule" : "New rule"}</h2>
          <span className="text-xs text-muted-foreground">
            {rule?.enabled === false ? "Disabled" : "Enabled"}
          </span>
        </div>
        <fieldset disabled={saving} className="contents">
          <div className="grid min-w-0 grid-cols-1 gap-3 @min-[480px]:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${fieldId}-name`}>
              <span className="text-xs font-semibold text-muted-foreground">Rule name</span>
              <Input
                id={`${fieldId}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="security-sweep"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${fieldId}-repo`}>
              <span className="text-xs font-semibold text-muted-foreground">Repository</span>
              <Input
                id={`${fieldId}-repo`}
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="owner/repo"
              />
            </label>
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-3 @min-[480px]:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-muted-foreground">
              Review mode
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value)}
                className="h-9 rounded-md border border-input bg-card px-2 text-foreground"
              >
                <option value="shadow">Shadow — review without posting</option>
                <option value="live">Live — post to GitHub</option>
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-muted-foreground">
              Review threads
              <select
                value={visibility}
                onChange={(event) => setVisibility(event.target.value)}
                className="h-9 rounded-md border border-input bg-card px-2 text-foreground"
              >
                <option value="visible">Show in sidebar</option>
                <option value="hidden">Hide from sidebar</option>
              </select>
            </label>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-sm font-semibold">Run when</h3>
            <div className="flex flex-wrap gap-1.5">
              {[
                "ready_for_review",
                "new_commits",
                "new_issue",
                "pr_description_matches",
                "comment_matches",
              ].map((trigger) => (
                <button
                  key={trigger}
                  type="button"
                  aria-pressed={triggers.includes(trigger)}
                  onClick={() =>
                    setTriggers((current) =>
                      current.includes(trigger)
                        ? current.filter((value) => value !== trigger)
                        : [...current, trigger],
                    )
                  }
                  className={`rounded-md border px-2.5 py-1 text-xs ${
                    triggers.includes(trigger)
                      ? "border-transparent bg-surface-selected font-semibold text-foreground"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {
                    (
                      {
                        ready_for_review: "PR ready for review",
                        new_commits: "New commits",
                        new_issue: "New issue",
                        pr_description_matches: "PR description matches",
                        comment_matches: "Comment matches",
                      } as Record<string, string>
                    )[trigger]
                  }
                </button>
              ))}
            </div>
          </div>

          {triggers.some((trigger) =>
            ["comment_matches", "pr_description_matches"].includes(trigger),
          ) ? (
            <div className="grid min-w-0 grid-cols-1 gap-3 @min-[480px]:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${fieldId}-keywords`}>
                <span className="text-xs font-semibold text-muted-foreground">Match keywords</span>
                <Input
                  id={`${fieldId}-keywords`}
                  value={commentKeywords}
                  onChange={(event) => setCommentKeywords(event.target.value)}
                  placeholder="@slopcop, slop check"
                />
              </label>
              {triggers.includes("comment_matches") ? (
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-xs font-semibold text-muted-foreground">
                    Who can request a review
                  </span>
                  <select
                    value={requesterTrust}
                    onChange={(event) => setRequesterTrust(event.target.value)}
                    className="h-9 rounded-md border border-input bg-card px-2 text-xs"
                  >
                    <option value="org_members">Organization members only</option>
                    <option value="write_access">Write access only</option>
                    <option value="past_contributors">Write access + past contributors</option>
                    <option value="anyone">Anyone</option>
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}

          <details className="border-t border-border pt-4">
            <summary className="cursor-pointer text-sm font-semibold">
              Filters &amp; author exclusions
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid min-w-0 grid-cols-1 gap-3 @min-[480px]:grid-cols-2">
                <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${fieldId}-paths`}>
                  <span className="text-xs font-semibold text-muted-foreground">
                    Changed paths match (PR only)
                  </span>
                  <Input
                    id={`${fieldId}-paths`}
                    value={pathGlobs}
                    onChange={(event) => setPathGlobs(event.target.value)}
                    placeholder="src/auth/**, src/payments/**"
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${fieldId}-branch`}>
                  <span className="text-xs font-semibold text-muted-foreground">
                    Base branch (PR only)
                  </span>
                  <Input
                    id={`${fieldId}-branch`}
                    value={baseBranch}
                    onChange={(event) => setBaseBranch(event.target.value)}
                    placeholder="main"
                  />
                </label>
              </div>

              <div className="flex min-w-0 flex-col gap-1.5">
                <label
                  htmlFor={excludedAuthorsId}
                  className="text-xs font-semibold text-muted-foreground"
                >
                  Exclude PR authors
                </label>
                <Input
                  id={excludedAuthorsId}
                  aria-describedby={`${excludedAuthorsId}-hint`}
                  aria-invalid={excludedAuthorsError !== null}
                  value={excludedAuthors}
                  onChange={(event) => setExcludedAuthors(event.target.value)}
                  placeholder="username, dependabot[bot]"
                />
                <span id={`${excludedAuthorsId}-hint`} className="text-xs text-muted-foreground">
                  Comma-separated GitHub usernames, with or without @. Matches ignore case. Leave
                  empty to review all qualifying authors.
                </span>
                {excludedAuthorsError !== null ? (
                  <span role="alert" className="text-xs text-destructive-text">
                    {excludedAuthorsError}
                  </span>
                ) : null}
              </div>
            </div>
          </details>
          <div className="space-y-2">
            <label className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">PR authors</span>
              <span className="flex-1" />
              <select
                value={trust}
                onChange={(event) => setTrust(event.target.value)}
                className="rounded-md border border-input bg-card px-2 py-1 text-xs"
              >
                <option value="org_members">Organization members only</option>
                <option value="write_access">Write access only</option>
                <option value="past_contributors">Write access + past contributors</option>
                <option value="anyone">Anyone</option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              Past contributors have had a commit merged into the repository.
            </p>
            {trust === "anyone" ? (
              <p className="mt-2 rounded-md bg-surface-attention p-2 text-xs leading-relaxed">
                <b className="text-warning-text">!</b> Pull request rules can check out unvetted
                code from strangers. Issue text can also carry prompt injection. Use the narrowest
                suitable permission mode below.
              </p>
            ) : null}
          </div>

          <ExecutionSettings value={request} onChange={setRequest} />
          <label className="flex min-w-0 flex-col gap-2">
            <span className="text-sm font-semibold">Review instructions</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={7}
              className="min-h-32 w-full resize-y rounded-md border border-input bg-background p-3 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="What should the agent check and report?"
            />
          </label>
        </fieldset>
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t border-border bg-background px-1 py-3">
          {saveError ? (
            <p role="alert" className="w-full text-sm text-destructive-text">
              {saveError}
            </p>
          ) : null}
          {dangerous ? (
            <span className="text-xs text-warning-text">Live reviews from any author</span>
          ) : null}
          {rule ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              className="text-destructive-text"
              onClick={() => {
                setSaving(true);
                void rpc
                  .call("deleteRule", { id: rule.id })
                  .then(onDone)
                  .catch((error: unknown) => {
                    setSaveError(
                      error instanceof Error ? error.message : "Could not delete the rule.",
                    );
                  })
                  .finally(() => setSaving(false));
              }}
            >
              Delete rule
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving…" : "Save rule"}
          </Button>
        </div>
      </form>
      {rule ? (
        <details className="mt-4 border-t border-border pt-4">
          <summary className="cursor-pointer text-sm font-semibold">Test this rule</summary>
          <div className="mt-3">
            {hasUnsavedChanges ? (
              <p className="text-xs text-muted-foreground">
                Save your changes before testing this rule.
              </p>
            ) : (
              <RunOnTarget rule={rule} />
            )}
          </div>
        </details>
      ) : null}
    </div>
  );
}
function Activity({ runs }: { runs: RunView[] }) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, CommentView[]>>({});

  const expand = (runId: string) => {
    setExpanded((current) => (current === runId ? null : runId));
    if (comments[runId] === undefined) {
      void rpc.call("getRunComments", { runId }).then((result) => {
        setComments((current) => ({
          ...current,
          [runId]: result.comments as CommentView[],
        }));
      });
    }
  };

  if (runs.length === 0) {
    return (
      <p className="py-8 text-center text-xs text-muted-foreground">
        No runs yet. Rules dispatch for new issues or matching pull requests.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {runs.map((run) => (
        <div key={run.id} className="border-b border-border py-2.5 last:border-0">
          <div className="flex gap-3">
            <span
              className={`mt-0.5 h-fit min-w-[104px] rounded-md px-1.5 py-0.5 text-center text-xs font-semibold ${
                STATUS_TONE[run.status] ?? "bg-surface-recessed"
              }`}
            >
              {run.status.replace(/_/g, " ")}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-mono text-pr-merged">
                  {run.targetKind === "issue" ? "issue" : "PR"} #{run.prNumber}
                </span>{" "}
                <span className="font-medium">{run.prTitle}</span>
              </p>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
                <span className="text-muted-foreground">{run.ruleName}</span>
                {run.mode === "shadow" ? <span>shadow</span> : null}
                <span>{run.trigger.replace(/_/g, " ")}</span>
                <span>{relative(run.startedAt)}</span>
                {run.threadId !== null ? (
                  <button
                    type="button"
                    className="text-timeline-accent hover:underline"
                    onClick={() => navigate.toThread(run.threadId as string)}
                  >
                    thread
                  </button>
                ) : null}
                {run.commentCount > 0 ? (
                  <button
                    type="button"
                    className="text-timeline-accent hover:underline"
                    onClick={() => expand(run.id)}
                  >
                    {run.commentCount} comment
                    {run.commentCount === 1 ? "" : "s"}
                  </button>
                ) : null}
              </div>
              {run.detail !== null ? (
                <p className="mt-1 text-xs text-warning-text">{run.detail}</p>
              ) : null}
              {expanded === run.id ? (
                <div className="mt-2 flex flex-col gap-1.5 border-l-2 border-border pl-2.5">
                  {(comments[run.id] ?? []).map((comment, index) => (
                    <div key={index} className="flex gap-2 text-xs">
                      <span className="min-w-[56px] shrink-0 rounded border border-border px-1 text-center font-mono text-subtle-foreground">
                        {comment.kind}
                      </span>
                      {comment.path !== null ? (
                        <span className="shrink-0 font-mono text-foreground">
                          {comment.path}
                          {comment.line === null ? "" : `:${comment.line}`}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 text-muted-foreground">
                        {comment.bodyExcerpt}
                      </span>
                      {comment.url !== null ? (
                        <a
                          href={comment.url}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-timeline-accent hover:underline"
                        >
                          open
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------

function SlopCopPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [tab, setTab] = useState<"rules" | "activity">("rules");
  const [editing, setEditing] = useState<RuleView | null | "new">(() => openRule);
  const [rules, setRules] = useState<RuleView[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [ghLogin, setGhLogin] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void rpc.call("listRules", null).then((result) => {
      setRules(result.rules as RuleView[]);
    });
    void rpc.call("listRuns", { limit: 50 }).then((result) => {
      setRuns(result.runs as RunView[]);
    });
    void rpc.call("status", null).then((result) => {
      setGhLogin(result.ghLogin);
    });
  }, [rpc]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useRealtime("runs-changed", refresh);

  if (editing !== null) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-3xl">
          <RuleEditor
            rule={editing === "new" ? null : editing}
            onDone={() => {
              ruleDrafts.delete(editing === "new" ? "new" : editing.id);
              openRule = null;
              setEditing(null);
              refresh();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-2">
        {(["rules", "activity"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-md px-2.5 py-1 text-sm capitalize ${
              tab === value
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-state-hover"
            }`}
          >
            {value}
            <span className="ml-1.5 rounded-md bg-muted px-1 text-xs text-muted-foreground">
              {value === "rules" ? rules.length : runs.length}
            </span>
          </button>
        ))}
        <span className="flex-1" />
        {ghLogin === null ? (
          <span className="text-xs text-warning-text">gh not authenticated</span>
        ) : (
          <span className="text-xs text-subtle-foreground">gh: {ghLogin}</span>
        )}
        <Button
          size="sm"
          onClick={() => {
            openRule = "new";
            setEditing("new");
          }}
        >
          New rule
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-3xl">
          {tab === "rules" ? (
            <RulesList
              rules={rules}
              onNew={() => {
                openRule = "new";
                setEditing("new");
              }}
              onEdit={(rule) => {
                openRule = rule;
                setEditing(rule);
              }}
              onToggle={(rule, enabled) => {
                void rpc.call("setRuleEnabled", { id: rule.id, enabled }).then(refresh);
              }}
            />
          ) : (
            <Activity runs={runs} />
          )}
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "slopcop",
    title: "SlopCop",
    icon: "AlertTriangle",
    path: "slopcop",
    component: SlopCopPanel,
  });
});
