import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Check, ChecksState, PrState, ReviewDecision, ReviewState } from "../shared/schema.ts";
import { absoluteTime, relativeTime } from "./format.ts";
import { cn } from "./lib/utils.ts";

/*
 * Every status the panel shows, in bb's feedback colours, and said in words
 * too: an icon alone leaves the reader to guess what a green tick is about.
 */

type Look = { icon: string; tone: string; label: string };

const CHIP =
  "inline-flex h-4.5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset ring-current/30";

/**
 * A small outlined pill: a word, and an icon when there is one, coloured by
 * what it reports. Every status chip in the panel is one of these.
 */
export function Chip({
  icon,
  tone,
  title,
  className,
  children,
}: {
  icon?: string;
  tone: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn(CHIP, tone, className)} title={title}>
      {icon ? <Icon name={icon} className="size-3" aria-hidden /> : null}
      {children}
    </span>
  );
}

function LookChip({ look, className }: { look: Look; className?: string }) {
  return (
    <Chip icon={look.icon} tone={look.tone} className={className}>
      {look.label}
    </Chip>
  );
}

const CHECK_LOOK: Readonly<Record<ChecksState | Check["state"], Look>> = {
  success: { icon: "CircleCheck", tone: "text-success", label: "Passed" },
  failure: { icon: "CircleX", tone: "text-destructive-text", label: "Failed" },
  pending: { icon: "Clock", tone: "text-warning-text", label: "In progress" },
  neutral: { icon: "Circle", tone: "text-muted-foreground", label: "Neutral" },
  skipped: { icon: "Circle", tone: "text-subtle-foreground", label: "Skipped" },
  cancelled: { icon: "CircleX", tone: "text-subtle-foreground", label: "Cancelled" },
};

/** The word for a check state, e.g. "Failed". */
export function checksLabel(state: ChecksState | Check["state"]): string {
  return CHECK_LOOK[state].label;
}

/**
 * One check's or the whole head commit's state as an icon. Its accessible
 * name is the state's word unless `label` says more ("Checks failed").
 * Nothing at all when there are no checks.
 */
export function ChecksStateIcon({
  state,
  label,
  className,
}: {
  state: ChecksState | Check["state"] | null;
  label?: string;
  className?: string;
}) {
  if (!state) return null;
  const look = CHECK_LOOK[state];
  const name = label ?? look.label;
  return (
    <span title={name} className={cn("inline-flex shrink-0", look.tone)}>
      <Icon name={look.icon} className={cn("size-3.5", className)} aria-hidden />
      <span className="sr-only">{name}</span>
    </span>
  );
}

const REVIEW_LOOK: Readonly<Record<ReviewState | "requested", Look>> = {
  approved: { icon: "Check", tone: "text-success", label: "Approved" },
  changes_requested: {
    icon: "AlertCircle",
    tone: "text-destructive-text",
    label: "Changes requested",
  },
  commented: { icon: "MessageSquare", tone: "text-muted-foreground", label: "Commented" },
  dismissed: { icon: "X", tone: "text-subtle-foreground", label: "Dismissed" },
  pending: { icon: "Edit", tone: "text-attention", label: "Draft review" },
  requested: { icon: "Clock", tone: "text-warning-text", label: "Review requested" },
};

/** One reviewer's latest review, or that it is still outstanding. */
export function ReviewStateBadge({
  state,
  className,
}: {
  state: ReviewState | "requested";
  className?: string;
}) {
  return <LookChip look={REVIEW_LOOK[state]} className={className} />;
}

const DECISION_LOOK: Readonly<Record<ReviewDecision, Look>> = {
  approved: REVIEW_LOOK.approved,
  changes_requested: REVIEW_LOOK.changes_requested,
  review_required: { icon: "Clock", tone: "text-warning-text", label: "Review required" },
};

/** GitHub's verdict on the pull request as a whole. */
export function ReviewDecisionBadge({
  decision,
  className,
}: {
  decision: ReviewDecision;
  className?: string;
}) {
  return <LookChip look={DECISION_LOOK[decision]} className={className} />;
}

const PR_LOOK: Readonly<Record<PrState | "draft", Look>> = {
  open: { icon: "GitPullRequest", tone: "text-success", label: "Open" },
  draft: { icon: "GitPullRequestDraft", tone: "text-subtle-foreground", label: "Draft" },
  merged: { icon: "GitMerge", tone: "text-pr-merged", label: "Merged" },
  closed: { icon: "GitPullRequestClosed", tone: "text-destructive-text", label: "Closed" },
};

/** Open, draft, merged, or closed. A draft is only a draft while it is open. */
export function PrStateBadge({
  state,
  isDraft,
  className,
}: {
  state: PrState;
  isDraft: boolean;
  className?: string;
}) {
  return (
    <LookChip look={PR_LOOK[state === "open" && isDraft ? "draft" : state]} className={className} />
  );
}

const BRANCH_LOOK: Readonly<Partial<Record<string, Look & { detail: string }>>> = {
  unpushed: {
    icon: "GitBranch",
    tone: "text-muted-foreground",
    label: "Unpushed",
    detail: "Not on any remote yet",
  },
  pushed: {
    icon: "GitBranch",
    tone: "text-primary",
    label: "Pushed",
    detail: "Pushed, with no pull request yet",
  },
  ahead: {
    icon: "ArrowUp",
    tone: "text-primary",
    label: "Ahead",
    detail: "Has commits not pushed yet",
  },
  behind: {
    icon: "ArrowDown",
    tone: "text-primary",
    label: "Behind",
    detail: "The remote branch has commits this one lacks",
  },
  diverged: {
    icon: "ArrowUpDown",
    tone: "text-warning-text",
    label: "Diverged",
    detail: "The branch and its remote each have commits the other lacks",
  },
  integrated: {
    icon: "GitMerge",
    tone: "text-pr-merged",
    label: "Integrated",
    detail: "Already in the target branch",
  },
  conflicted: {
    icon: "AlertTriangle",
    tone: "text-destructive-text",
    label: "Conflicted",
    detail: "Has conflicted commits",
  },
};

/**
 * GitButler's push status for an unpublished branch. A status it has no word
 * for here shows as GitButler says it; one it does not know, not at all.
 */
export function BranchStatusChip({ status, className }: { status: string; className?: string }) {
  const look = Object.hasOwn(BRANCH_LOOK, status) ? BRANCH_LOOK[status] : undefined;
  if (look) {
    return (
      <Chip icon={look.icon} tone={look.tone} title={look.detail} className={className}>
        {look.label}
      </Chip>
    );
  }
  if (status === "" || status === "unknown") return null;
  return (
    <Chip tone="text-muted-foreground" className={className}>
      {status}
    </Chip>
  );
}

/** A GitHub avatar, or its initial when there is none. Decorative: the login sits beside it. */
export function Avatar({
  login,
  url,
  className,
}: {
  login: string;
  url: string | null;
  className?: string;
}): ReactNode {
  const box = cn("size-4 shrink-0 rounded-full bg-secondary", className);
  if (!url) {
    return (
      <span
        aria-hidden
        className={cn(box, "inline-flex items-center justify-center text-[9px] uppercase")}
      >
        {login.charAt(0)}
      </span>
    );
  }
  return <img src={url} alt="" className={box} loading="lazy" />;
}

/** A signed-in account's GitHub avatar. GitHub serves any login's at a fixed URL. */
export function AccountAvatar({ login, className }: { login: string; className?: string }) {
  return (
    <Avatar
      login={login}
      url={`https://github.com/${encodeURIComponent(login)}.png?size=40`}
      className={className}
    />
  );
}

/** How long ago, with the full date and time on hover. */
export function Timestamp({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={absoluteTime(iso)} className={className}>
      {relativeTime(iso)}
    </time>
  );
}
