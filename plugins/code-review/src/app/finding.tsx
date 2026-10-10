import { useId } from "react";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { useMutationState } from "@tanstack/react-query";
import type { Mutation, MutationKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { sameRevision } from "../shared/schema.ts";
import type {
  DiffRevision,
  DiffSide,
  Finding,
  PullRequest,
  ReviewThread,
} from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";

/**
 * Window event that asks the Changes tab to scroll a finding's line into
 * view. Dispatched after navigating there, so the tab is mounted to hear it.
 */
export const REVEAL_EVENT = "code-review:reveal";
export type RevealDetail = Pick<Finding, "path" | "line" | "side">;

/** `P0` to `P3`, as the reviewer writes them. */
export function priorityLabel(priority: number): string {
  return `P${priority}`;
}

// What each priority means, from the review rubric.
const PRIORITY_MEANING = ["Blocks release", "Urgent", "Normal", "Low impact"];

// P0 reads as an error, P1 as a warning, and the rest stay quiet.
const PRIORITY_TONE = [
  "border-surface-destructive-border bg-surface-destructive text-destructive-text",
  "border-transparent bg-surface-attention text-warning-text",
  "border-transparent bg-secondary text-secondary-foreground",
  "border-transparent bg-secondary text-muted-foreground",
];

/** Most urgent first, then by file and line, so a list reads like a triage queue. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings.toSorted(
    (a, b) => a.priority - b.priority || a.path.localeCompare(b.path) || a.line - b.line,
  );
}

/** `src/a.ts:12`, `src/a.ts:10-12`, with `(base)` when the lines are on the deleted side. */
export function findingLocation(finding: Finding): string {
  const lines =
    finding.startLine !== null && finding.startLine !== finding.line
      ? `${finding.startLine}-${finding.line}`
      : String(finding.line);
  return `${finding.path}:${lines}${finding.side === "LEFT" ? " (base)" : ""}`;
}

/** The draft comment a finding becomes: its priority and title in bold, then the body. */
export function findingDraftBody(finding: Finding): string {
  const heading = `**[${priorityLabel(finding.priority)}] ${finding.title}**`;
  const body = finding.body.trim();
  return body ? `${heading}\n\n${body}` : heading;
}

/**
 * The lines a finding's draft comment is written on. A finding's range never
 * crosses sides, so it starts on the side it ends on.
 */
function findingLines(finding: Finding): {
  line: number;
  side: DiffSide;
  startLine: number | null;
  startSide: DiffSide | null;
} {
  return {
    line: finding.line,
    side: finding.side,
    startLine: finding.startLine,
    startSide: finding.startLine === null ? null : finding.side,
  };
}

type DraftMutation = ReturnType<typeof rpc.addDraftComment.useMutation>;
type DraftInput = Parameters<DraftMutation["mutate"]>[0];
type SavedDraft = Awaited<ReturnType<DraftMutation["mutateAsync"]>>;
type DraftLines = Pick<ReviewThread, "path" | "line" | "side" | "startLine" | "startSide">;

/**
 * Whether a draft with this body on these lines is the finding's. The reviewer can
 * word two findings alike, so the draft has to sit on the finding's exact
 * lines too.
 */
function isDraftOf(finding: Finding, at: DraftLines, body: string): boolean {
  const lines = findingLines(finding);
  return (
    at.path === finding.path &&
    at.line === lines.line &&
    at.side === lines.side &&
    at.startLine === lines.startLine &&
    at.startSide === lines.startSide &&
    body.trim() === findingDraftBody(finding)
  );
}

/**
 * Whether the viewer's pending review already holds this finding as a draft.
 * The pull request's threads are the record: GitHub's, plus a draft just saved
 * until the next read brings it back.
 */
export function hasDraftFor(pr: PullRequest, finding: Finding): boolean {
  return pr.threads.some((thread) =>
    thread.comments.some((comment) => comment.isDraft && isDraftOf(finding, thread, comment.body)),
  );
}

/**
 * Findings' draft writes for one pull request. The mutation cache outlives
 * every card, so a card mounted again while a write is out still sees it.
 * Keyed by the pull request's node id, which stays the same however its URL
 * is cased.
 */
function draftKey(pullRequestId: string): MutationKey {
  return ["addDraftComment", pullRequestId];
}

function writesFinding(finding: Finding, mutation: Mutation<unknown, Error, unknown>): boolean {
  const draft = mutation.state.variables as DraftInput | undefined;
  return draft !== undefined && isDraftOf(finding, draft, draft.body);
}

/**
 * The pull request with a draft just saved, as GitHub will list it. The next
 * read replaces it with GitHub's own record. A read that already shows it is
 * left as it is.
 */
function withSavedDraft(pr: PullRequest, saved: SavedDraft, draft: DraftInput): PullRequest {
  if (pr.threads.some((thread) => thread.id === saved.threadId)) return pr;
  const thread: ReviewThread = {
    id: saved.threadId,
    path: draft.path,
    line: draft.line,
    startLine: draft.startLine,
    startSide: draft.startSide,
    side: draft.side,
    originalLine: draft.line,
    isResolved: false,
    isOutdated: false,
    isFileLevel: false,
    diffHunk: "",
    comments: [
      {
        id: saved.commentId,
        author: { login: pr.viewer.login, avatarUrl: null },
        body: draft.body,
        createdAt: new Date().toISOString(),
        url: "",
        isDraft: true,
      },
    ],
  };
  return {
    ...pr,
    threads: [...pr.threads, thread],
    // The pending review as the server left it. The first draft starts one,
    // and Submit and Discard need it before the next read. A review just
    // started has no summary yet.
    pendingReview: {
      ...saved.pendingReview,
      body: pr.pendingReview?.id === saved.pendingReview.id ? pr.pendingReview.body : "",
    },
  };
}

export function PriorityBadge({ priority }: { priority: number }) {
  const meaning = PRIORITY_MEANING[priority] ?? "";
  return (
    <span
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center rounded-full border px-1.5 text-[11px] font-semibold tabular-nums",
        PRIORITY_TONE[priority] ?? PRIORITY_TONE[3],
      )}
      title={meaning}
    >
      {priorityLabel(priority)}
      <span className="sr-only">, {meaning}</span>
    </span>
  );
}

const ACTION = "h-6 gap-1.5 px-2 text-xs font-normal [&_[data-icon-root]]:size-3";

/**
 * One bb finding: priority, title, where it is, and why. `onReveal` adds
 * "Show in Changes". With `pr`, the finding can also become a draft comment
 * in the viewer's pending review, unless the review ran on another head or
 * base, whose line numbers may not match the diff any more.
 */
export function FindingCard({
  finding,
  stale,
  reviewed,
  onReveal,
  pr,
}: {
  finding: Finding;
  stale: boolean;
  /**
   * The diff the finding's line numbers refer to. The pull request's own
   * head and base when left out.
   */
  reviewed?: DiffRevision;
  onReveal?: () => void;
  pr?: PullRequest;
}) {
  const titleId = useId();
  return (
    <article
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-background px-2.5 py-2"
      aria-labelledby={titleId}
    >
      <header className="flex min-w-0 items-start gap-2">
        <PriorityBadge priority={finding.priority} />
        <h3 id={titleId} className="min-w-0 flex-1 font-semibold leading-snug">
          {finding.title}
        </h3>
      </header>
      <p
        className="truncate font-mono text-[11px] text-muted-foreground"
        title={findingLocation(finding)}
        translate="no"
      >
        {findingLocation(finding)}
      </p>
      {finding.body.trim() ? (
        <Markdown content={finding.body} className="min-w-0 text-xs [overflow-wrap:anywhere]" />
      ) : null}
      {onReveal || pr ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {onReveal ? (
            <Button variant="outline" size="sm" className={ACTION} onClick={onReveal}>
              <Icon name="FileDiff" aria-hidden />
              Show in Changes
            </Button>
          ) : null}
          {pr ? (
            <DraftCommentButton pr={pr} finding={finding} reviewed={reviewed ?? pr} stale={stale} />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function DraftCommentButton({
  pr,
  finding,
  reviewed,
  stale,
}: {
  pr: PullRequest;
  finding: Finding;
  reviewed: DiffRevision;
  stale: boolean;
}) {
  const mutationKey = draftKey(pr.id);
  const pullRequestKey = rpc.pullRequest.queryKey({ ref: pr.ref });
  const add = rpc.addDraftComment.useMutation({
    mutationKey,
    async onSuccess(saved, draft) {
      // A read sent before the write would land after it without the draft,
      // so it is dropped first.
      await pluginQueryClient.cancelQueries({ queryKey: pullRequestKey });
      // Until the read below lands, the cached pull request every card renders
      // from holds the draft, so each shows the finding saved, also one
      // mounted meanwhile. From that read on GitHub is the record, whether or
      // not it shows the draft: a review submitted or discarded first leaves
      // nothing, and the finding can be added again.
      pluginQueryClient.setQueryData<PullRequest>(
        pullRequestKey,
        (cached) => cached && withSavedDraft(cached, saved, draft),
      );
      toast.success(`Added a draft comment on ${findingLocation(finding)}`);
      // Read again also when the viewer left the page meanwhile, so the cache
      // they come back to is GitHub's. The first draft also starts the
      // pending review the inbox shows.
      void pluginQueryClient.invalidateQueries({ queryKey: pullRequestKey, refetchType: "all" });
      if (!pr.pendingReview) {
        void pluginQueryClient.invalidateQueries({ queryKey: rpc.inbox.queryKey() });
      }
    },
    onError(error) {
      toast.error(errorText(error));
    },
  });
  // A write still out lives in the mutation cache, not in this card, so a
  // card mounted again meanwhile shows it too.
  const saving = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (mutation) => writesFinding(finding, mutation),
  }).includes(true);
  // Line numbers from another diff would land on the wrong lines, and the
  // server turns them away once the pull request has moved on.
  const outdated = stale || !sameRevision(reviewed, pr);
  if (hasDraftFor(pr, finding)) {
    return (
      <span className="inline-flex h-6 items-center gap-1.5 px-1 text-muted-foreground">
        <Icon name="Check" className="size-3 text-success" aria-hidden />
        In your pending review
      </span>
    );
  }
  const button = (
    <Button
      variant="outline"
      size="sm"
      className={ACTION}
      disabled={outdated || saving}
      aria-busy={saving}
      onClick={() => {
        // A second click can land before the render that disables the
        // button, so the caches decide whether the finding is out or saved.
        const latest = pluginQueryClient.getQueryData<PullRequest>(pullRequestKey) ?? pr;
        const out = pluginQueryClient.isMutating({
          mutationKey,
          predicate: (mutation) => writesFinding(finding, mutation),
        });
        if (out > 0 || hasDraftFor(latest, finding)) return;
        add.mutate({
          pullRequestId: pr.id,
          headRefOid: reviewed.headRefOid,
          baseRefName: reviewed.baseRefName,
          path: finding.path,
          body: findingDraftBody(finding),
          ...findingLines(finding),
        });
      }}
    >
      <Icon
        name={saving ? "Loading" : "MessageSquarePlus"}
        className={cn(saving && "motion-safe:animate-spin")}
        aria-hidden
      />
      Add as draft comment
    </Button>
  );
  // A disabled button shows no tooltip of its own, so the reason sits on a wrapper.
  return outdated ? (
    <span title="bb reviewed an older version of this diff, so this line may not match it.">
      {button}
    </span>
  ) : (
    button
  );
}
