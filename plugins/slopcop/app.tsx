import { MarkdownEditor } from "@bb-plugins/markdown-editor";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ExecutionSettings } from "./execution-settings";
import type { Run, RunStatus, ThreadRequest } from "./lib/types";

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

const STATUS_TONE: Record<RunStatus, string> = {
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

const CHIP_TONE = {
  default: "secondary",
  trigger: "info",
  guard: "success",
  warn: "warning",
} as const satisfies Record<string, BadgeProps["variant"]>;

function Chip({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: keyof typeof CHIP_TONE;
}) {
  return (
    <Badge
      variant={CHIP_TONE[tone]}
      className="max-w-full"
      title={typeof children === "string" ? children : undefined}
    >
      <span className="truncate">{children}</span>
    </Badge>
  );
}

/** One value picker for the rule form's fixed option lists. */
function OptionSelect({
  id,
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  label?: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map(([option, text]) => (
            <SelectItem key={option} value={option}>
              {text}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** Rule triggers in the order the editor offers them. */
const TRIGGER_LABEL: Record<string, string> = {
  ready_for_review: "PR ready for review",
  new_commits: "New commits",
  new_issue: "New issue",
  pr_description_matches: "PR description matches",
  comment_matches: "Comment matches",
};

const TRUST_OPTIONS = [
  ["org_members", "Organization members only"],
  ["write_access", "Write access only"],
  ["past_contributors", "Write access + past contributors"],
  ["anyone", "Anyone"],
] as const;

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
          <div className="flex items-start gap-2">
            {/* The name, repository and mode wrap as whole items, so a long
                name truncates on its own line instead of overrunning the chips. */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
              <Button
                variant="link"
                size="sm"
                onClick={() => onEdit(rule)}
                className="h-auto min-h-6 max-w-full min-w-0 justify-start p-0 text-sm font-semibold text-foreground"
              >
                <span className="truncate" title={rule.name}>
                  {rule.name}
                </span>
              </Button>
              <Badge
                variant="outline"
                className="max-w-full font-mono text-muted-foreground"
                title={rule.repo}
              >
                <span className="truncate">{rule.repo}</span>
              </Badge>
              {rule.mode === "shadow" ? (
                <Chip tone="trigger">shadow</Chip>
              ) : (
                <Chip tone="guard">live</Chip>
              )}
            </div>
            {/* As tall as the title line, so the toggle centers on it. */}
            <div className="flex h-6 shrink-0 items-center">
              <Switch
                aria-label={`Enable ${rule.name}`}
                checked={rule.enabled}
                onClick={(event) => event.stopPropagation()}
                onCheckedChange={(next) => onToggle(rule, next)}
              />
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {rule.triggers.map((trigger) => (
              <Chip key={trigger} tone="trigger">
                {TRIGGER_LABEL[trigger] ?? trigger}
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
          <OptionSelect
            label="Target kind"
            value={targetKind}
            onValueChange={(value) => setTargetKind(value as "pull_request" | "issue")}
            options={[
              ["pull_request", "PR"],
              ["issue", "Issue"],
            ]}
            className="h-7 w-24 text-xs"
          />
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
            <div className="flex min-w-0 flex-col gap-1">
              <Label
                htmlFor={`${fieldId}-name`}
                className="text-xs font-semibold text-muted-foreground"
              >
                Rule name
              </Label>
              <Input
                id={`${fieldId}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="security-sweep"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label
                htmlFor={`${fieldId}-repo`}
                className="text-xs font-semibold text-muted-foreground"
              >
                Repository
              </Label>
              <Input
                id={`${fieldId}-repo`}
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="owner/repo"
              />
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-3 @min-[480px]:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <Label
                htmlFor={`${fieldId}-mode`}
                className="text-xs font-semibold text-muted-foreground"
              >
                Review mode
              </Label>
              <OptionSelect
                id={`${fieldId}-mode`}
                value={mode}
                onValueChange={setMode}
                options={[
                  ["shadow", "Shadow — review without posting"],
                  ["live", "Live — post to GitHub"],
                ]}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label
                htmlFor={`${fieldId}-visibility`}
                className="text-xs font-semibold text-muted-foreground"
              >
                Review threads
              </Label>
              <OptionSelect
                id={`${fieldId}-visibility`}
                value={visibility}
                onValueChange={setVisibility}
                options={[
                  ["visible", "Show in sidebar"],
                  ["hidden", "Hide from sidebar"],
                ]}
              />
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="text-sm font-semibold">Run when</h3>
            <ToggleGroup
              type="multiple"
              size="sm"
              variant="outline"
              value={triggers}
              onValueChange={setTriggers}
              className="flex-wrap justify-start"
            >
              {Object.entries(TRIGGER_LABEL).map(([trigger, text]) => (
                <ToggleGroupItem key={trigger} value={trigger} className="text-xs">
                  {text}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          {triggers.some((trigger) =>
            ["comment_matches", "pr_description_matches"].includes(trigger),
          ) ? (
            <div className="grid min-w-0 grid-cols-1 gap-3 @min-[480px]:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1">
                <Label
                  htmlFor={`${fieldId}-keywords`}
                  className="text-xs font-semibold text-muted-foreground"
                >
                  Match keywords
                </Label>
                <Input
                  id={`${fieldId}-keywords`}
                  value={commentKeywords}
                  onChange={(event) => setCommentKeywords(event.target.value)}
                  placeholder="@slopcop, slop check"
                />
              </div>
              {triggers.includes("comment_matches") ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <Label
                    htmlFor={`${fieldId}-requester`}
                    className="text-xs font-semibold text-muted-foreground"
                  >
                    Who can request a review
                  </Label>
                  <OptionSelect
                    id={`${fieldId}-requester`}
                    value={requesterTrust}
                    onValueChange={setRequesterTrust}
                    options={TRUST_OPTIONS}
                    className="text-xs"
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <Collapsible className="border-t border-border pt-4">
            <CollapsibleTrigger className="cursor-pointer text-sm font-semibold max-md:pointer-coarse:py-2">
              Filters &amp; author exclusions
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 flex flex-col gap-3">
              <div className="grid min-w-0 grid-cols-1 gap-3 @min-[480px]:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <Label
                    htmlFor={`${fieldId}-paths`}
                    className="text-xs font-semibold text-muted-foreground"
                  >
                    Changed paths match (PR only)
                  </Label>
                  <Input
                    id={`${fieldId}-paths`}
                    value={pathGlobs}
                    onChange={(event) => setPathGlobs(event.target.value)}
                    placeholder="src/auth/**, src/payments/**"
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <Label
                    htmlFor={`${fieldId}-branch`}
                    className="text-xs font-semibold text-muted-foreground"
                  >
                    Base branch (PR only)
                  </Label>
                  <Input
                    id={`${fieldId}-branch`}
                    value={baseBranch}
                    onChange={(event) => setBaseBranch(event.target.value)}
                    placeholder="main"
                  />
                </div>
              </div>

              <div className="flex min-w-0 flex-col gap-1">
                <Label
                  htmlFor={excludedAuthorsId}
                  className="text-xs font-semibold text-muted-foreground"
                >
                  Exclude PR authors
                </Label>
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
            </CollapsibleContent>
          </Collapsible>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`${fieldId}-trust`} className="text-sm font-semibold">
                PR authors
              </Label>
              <span className="flex-1" />
              <OptionSelect
                id={`${fieldId}-trust`}
                value={trust}
                onValueChange={setTrust}
                options={TRUST_OPTIONS}
                className="h-7 w-auto text-xs"
              />
            </div>
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
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm font-semibold">Review instructions</span>
            <MarkdownEditor
              aria-label="Review instructions"
              readOnly={saving}
              value={prompt}
              onChange={setPrompt}
              className="min-h-32 w-full resize-y rounded-md border border-input bg-background p-3 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="What should the agent check and report?"
            />
          </div>
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
        <Collapsible className="mt-4 border-t border-border pt-4">
          <CollapsibleTrigger className="cursor-pointer text-sm font-semibold max-md:pointer-coarse:py-2">
            Test this rule
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">
            {hasUnsavedChanges ? (
              <p className="text-xs text-muted-foreground">
                Save your changes before testing this rule.
              </p>
            ) : (
              <RunOnTarget rule={rule} />
            )}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
function Activity({ runs }: { runs: Run[] }) {
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
        <div key={run.id} className="min-h-10 border-b border-border py-2 last:border-0">
          <div className="flex gap-3">
            <span
              className={`inline-flex h-5 min-w-[104px] items-center justify-center rounded-md px-1 text-xs font-semibold ${
                STATUS_TONE[run.status]
              }`}
            >
              {run.status.replace(/_/g, " ")}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm wrap-break-word">
                <span className="font-mono text-pr-merged">
                  {run.targetKind === "issue" ? "issue" : "PR"} #{run.prNumber}
                </span>{" "}
                <span className="font-medium">{run.prTitle}</span>
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
                <span className="text-muted-foreground">{run.ruleName}</span>
                {run.mode === "shadow" ? <span>shadow</span> : null}
                <span>{run.trigger.replace(/_/g, " ")}</span>
                <span>{relative(run.startedAt)}</span>
                {run.threadId !== null ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs text-timeline-accent"
                    onClick={() => navigate.toThread(run.threadId as string)}
                  >
                    thread
                  </Button>
                ) : null}
                {run.commentCount > 0 ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs text-timeline-accent"
                    onClick={() => expand(run.id)}
                  >
                    {run.commentCount} comment
                    {run.commentCount === 1 ? "" : "s"}
                  </Button>
                ) : null}
              </div>
              {run.detail !== null ? (
                <p className="mt-1 text-xs text-warning-text">{run.detail}</p>
              ) : null}
              {expanded === run.id ? (
                <div className="mt-2 flex flex-col gap-2 border-l-2 border-border pl-3 @container">
                  {(comments[run.id] ?? []).map((comment, index) => (
                    // Below 480px the path and the excerpt each take a full line; wider,
                    // the excerpt drops below a long path rather than shrink to a sliver.
                    <div key={index} className="flex flex-wrap gap-x-2 gap-y-1 text-xs">
                      <span className="min-w-[56px] shrink-0 rounded border border-border px-1 text-center font-mono text-subtle-foreground">
                        {comment.kind}
                      </span>
                      {comment.path !== null ? (
                        <span className="min-w-0 font-mono wrap-anywhere text-foreground @max-[480px]:order-1 @max-[480px]:basis-full">
                          {comment.path}
                          {comment.line === null ? "" : `:${comment.line}`}
                        </span>
                      ) : null}
                      <span className="min-w-0 grow basis-48 text-muted-foreground @max-[480px]:order-2 @max-[480px]:basis-full">
                        {comment.bodyExcerpt}
                      </span>
                      {comment.url !== null ? (
                        <a
                          href={comment.url}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto shrink-0 text-timeline-accent hover:underline"
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

const ACCOUNT_LABEL =
  "min-w-0 flex-1 truncate text-right text-xs @max-[28rem]/panel:order-last @max-[28rem]/panel:basis-full @max-[28rem]/panel:text-left";

function SlopCopPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [tab, setTab] = useState<"rules" | "activity">("rules");
  const [editing, setEditing] = useState<RuleView | null | "new">(() => openRule);
  const [rules, setRules] = useState<RuleView[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [ghLogin, setGhLogin] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void rpc.call("listRules", null).then((result) => {
      setRules(result.rules as RuleView[]);
    });
    void rpc.call("listRuns", { limit: 50 }).then((result) => {
      setRuns(result.runs);
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
    <div className="flex h-full flex-col @container/panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Tabs value={tab} onValueChange={(value) => setTab(value as "rules" | "activity")}>
          <TabsList>
            {(["rules", "activity"] as const).map((value) => (
              <TabsTrigger key={value} value={value} className="capitalize">
                {value}
                <Badge variant="count" className="ml-1">
                  {value === "rules" ? rules.length : runs.length}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {/* The account label sits between the tabs and "New rule", truncating
            if it must; a narrow panel moves it to its own line under them. */}
        {ghLogin === null ? (
          <span className={`${ACCOUNT_LABEL} text-warning-text`}>gh not authenticated</span>
        ) : (
          <span className={`${ACCOUNT_LABEL} text-subtle-foreground`} title={`gh: ${ghLogin}`}>
            gh: {ghLogin}
          </span>
        )}
        <Button
          size="sm"
          className="ml-auto"
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
    icon: "slopcop/plugin",
    path: "slopcop",
    component: SlopCopPanel,
  });
});
