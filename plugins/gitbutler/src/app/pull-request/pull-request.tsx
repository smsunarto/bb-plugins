/**
 * A GitButler thread's pull request above its composer and in its Info tab,
 * as bb's bundled GitHub PR Status draws it for other checkouts. The rows
 * come from `threadPullRequests`, keyed by thread: in a GitButler checkout
 * the bundled plugin, keyed by environment, reads `gitbutler/workspace`.
 */
import { forwardRef, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import {
  UrlLink,
  experimental_DetailRow as DetailRow,
  experimental_Icon as Icon,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalThreadContextSegmentInput,
  ExperimentalThreadContextSegmentProps,
  ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import { pullRequestContract } from "../../shared/pull-request-contract.ts";
import type { PullRequest, PullRequestMergeMethod } from "../../shared/pull-request.ts";
import { cn } from "../lib/utils.ts";
import {
  PULL_REQUEST_NEXT_STEP_TONE_CLASS,
  PULL_REQUEST_STATE_DISPLAY,
  describePullRequestStatus,
  getPullRequestGithubCheckStatus,
  getPullRequestNextStep,
  getPullRequestStateDisplay,
  isPullRequestAutoMergeOn,
} from "./display.ts";
import type { GithubCheckStatus, PullRequestNextStep } from "./display.ts";

// bb's own context-row and banner-action styles, as its shared UI spells them.
const CONTEXT_CARD_SEGMENT_CLASS = "min-h-6 px-2 py-1 rounded";
const BANNER_ACTION_FILL_CLASS = "bg-background shadow-xs";
const BANNER_ACTION_SEGMENT_CLASS =
  "text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

/** Threads whose row has been rechecked on GitHub since the page loaded. */
const rechecked = new Set<string>();

/** The thread's pull request, or null. Opening the thread rechecks it on GitHub once. */
function useThreadPullRequest(threadId: string | null): PullRequest | null {
  const query = useRpcKeyedQuery({
    contract: pullRequestContract,
    method: "threadPullRequests",
    keys: threadId ? [threadId] : [],
    enabled: threadId !== null,
  });
  const refresh = useRpcMutation({
    contract: pullRequestContract,
    method: "refreshThreadPullRequest",
  });
  // The latest callbacks, for the listener below to call without resubscribing.
  const latest = useRef({ refresh, refetch: query.refetch });
  useEffect(() => {
    latest.current = { refresh, refetch: query.refetch };
  });
  useEffect(() => {
    if (threadId === null) return;
    if (!rechecked.has(threadId)) {
      rechecked.add(threadId);
      latest.current.refresh.mutate({ threadId }).catch(() => undefined);
    }
    const refetchIfVisible = () => {
      if (document.visibilityState !== "hidden") void latest.current.refetch();
    };
    document.addEventListener("visibilitychange", refetchIfVisible);
    return () => document.removeEventListener("visibilitychange", refetchIfVisible);
  }, [threadId]);
  const row = threadId ? query.data?.[threadId] : undefined;
  return row?.outcome === "available" ? row.pullRequest : null;
}

const GITHUB_MARK =
  "M16 0C7.16 0 0 7.16 0 16C0 23.08 4.58 29.06 10.94 31.18C11.74 31.32 12.04 30.84 12.04 30.42C12.04 30.04 12.02 28.78 12.02 27.44C8 28.18 6.96 26.46 6.64 25.56C6.46 25.1 5.68 23.68 5 23.3C4.44 23 3.64 22.26 4.98 22.24C6.24 22.22 7.14 23.4 7.44 23.88C8.88 26.3 11.18 25.62 12.1 25.2C12.24 24.16 12.66 23.46 13.12 23.06C9.56 22.66 5.84 21.28 5.84 15.16C5.84 13.42 6.46 11.98 7.48 10.86C7.32 10.46 6.76 8.82 7.64 6.62C7.64 6.62 8.98 6.2 12.04 8.26C13.32 7.9 14.68 7.72 16.04 7.72C17.4 7.72 18.76 7.9 20.04 8.26C23.1 6.18 24.44 6.62 24.44 6.62C25.32 8.82 24.76 10.46 24.6 10.86C25.62 11.98 26.24 13.4 26.24 15.16C26.24 21.3 22.5 22.66 18.94 23.06C19.52 23.56 20.02 24.52 20.02 26.02C20.02 28.16 20 29.88 20 30.42C20 30.84 20.3 31.34 21.1 31.18C27.42 29.06 32 23.06 32 16C32 7.16 24.84 0 16 0V0Z";

/** The GitHub mark, notched by a check result in the corner. */
const CHECK_MARKS: Record<GithubCheckStatus, { mark: string; glyph: string; className: string }> = {
  success: {
    mark: "M0 16C0 7.16 7.16 0 16 0C23.037 0 29.0094 4.53712 31.1529 10.8471L26.2271 15.773C26.2356 15.5741 26.24 15.3698 26.24 15.16C26.24 13.4 25.62 11.98 24.6 10.86C24.76 10.46 25.32 8.82 24.44 6.62C24.44 6.62 23.1 6.18 20.04 8.26C18.76 7.9 17.4 7.72 16.04 7.72C14.68 7.72 13.32 7.9 12.04 8.26C8.98 6.2 7.64 6.62 7.64 6.62C6.76 8.82 7.32 10.46 7.48 10.86C6.46 11.98 5.84 13.42 5.84 15.16C5.84 20.6387 8.82119 22.3187 12 22.8976V25.2442C11.0224 25.6632 8.83035 26.2166 7.44 23.88C7.14 23.4 6.24 22.22 4.98 22.24C3.64 22.26 4.44 23 5 23.3C5.68 23.68 6.46 25.1 6.64 25.56C6.95947 26.4585 7.99655 28.1743 12 27.4437V30.6814C11.8951 31.0116 11.5751 31.2911 10.94 31.18C4.58 29.06 0 23.08 0 16Z",
    glyph:
      "M30.7071 21.2071L20.5 31.4142L15.2929 26.2071L16.7071 24.7929L20.5 28.5858L29.2929 19.7929L30.7071 21.2071Z",
    className: "fill-success",
  },
  failure: {
    mark: "M0 16C0 7.16 7.16 0 16 0C24.1626 0 30.8929 6.10479 31.8764 14H26.1444C25.9339 12.7632 25.3856 11.7226 24.6 10.86C24.76 10.46 25.32 8.82 24.44 6.62C24.44 6.62 23.1 6.18 20.04 8.26C18.76 7.9 17.4 7.72 16.04 7.72C14.68 7.72 13.32 7.9 12.04 8.26C8.98 6.2 7.64 6.62 7.64 6.62C6.76 8.82 7.32 10.46 7.48 10.86C6.46 11.98 5.84 13.42 5.84 15.16C5.84 20.6387 8.82119 22.3187 12 22.8976V25.2442C11.0224 25.6632 8.83035 26.2166 7.44 23.88C7.14 23.4 6.24 22.22 4.98 22.24C3.64 22.26 4.44 23 5 23.3C5.68 23.68 6.46 25.1 6.64 25.56C6.95947 26.4585 7.99655 28.1743 12 27.4437V30.6814C11.8951 31.0116 11.5751 31.2911 10.94 31.18C4.58 29.06 0 23.08 0 16Z",
    glyph:
      "M23.0858 24.5L18.2929 29.2929L19.7071 30.7071L24.5 25.9142L29.2929 30.7071L30.7071 29.2929L25.9142 24.5L30.7071 19.7071L29.2929 18.2929L24.5 23.0858L19.7071 18.2929L18.2929 19.7071L23.0858 24.5Z",
    className: "fill-destructive",
  },
  pending: {
    mark: "M0 16C0 7.16 7.16 0 16 0C24.84 0 32 7.16 32 16C32 16.3358 31.9896 16.6693 31.9692 17H26.1121C26.1957 16.44 26.24 15.8283 26.24 15.16C26.24 13.4 25.62 11.98 24.6 10.86C24.76 10.46 25.32 8.82 24.44 6.62C24.44 6.62 23.1 6.18 20.04 8.26C18.76 7.9 17.4 7.72 16.04 7.72C14.68 7.72 13.32 7.9 12.04 8.26C8.98 6.2 7.64 6.62 7.64 6.62C6.76 8.82 7.32 10.46 7.48 10.86C6.46 11.98 5.84 13.42 5.84 15.16C5.84 20.6387 8.82119 22.3187 12 22.8976V25.2442C11.0224 25.6632 8.83035 26.2166 7.44 23.88C7.14 23.4 6.24 22.22 4.98 22.24C3.64 22.26 4.44 23 5 23.3C5.68 23.68 6.46 25.1 6.64 25.56C6.95947 26.4585 7.99655 28.1743 12 27.4437V30.6814C11.8951 31.0116 11.5751 31.2911 10.94 31.18C4.58 29.06 0 23.08 0 16Z",
    glyph: "M31 26A5 5 0 1 1 21 26A5 5 0 1 1 31 26Z",
    className: "fill-attention",
  },
};

function GithubMark({ status = null }: { status?: GithubCheckStatus | null }) {
  const notched = status === null ? null : CHECK_MARKS[status];
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className="size-4 shrink-0">
      {notched === null ? (
        <path fillRule="evenodd" clipRule="evenodd" d={GITHUB_MARK} fill="currentColor" />
      ) : (
        <>
          <path d={notched.mark} fill="currentColor" />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d={notched.glyph}
            className={notched.className}
          />
        </>
      )}
    </svg>
  );
}

function StateIcon({ pullRequest, className }: { pullRequest: PullRequest; className?: string }) {
  const display = getPullRequestStateDisplay(pullRequest);
  return (
    <Icon
      name={display.icon}
      className={cn("size-4 shrink-0", display.className, className)}
      aria-hidden="true"
    />
  );
}

function NextStepLabel({ nextStep }: { nextStep: PullRequestNextStep }) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1",
        PULL_REQUEST_NEXT_STEP_TONE_CLASS[nextStep.tone],
      )}
    >
      {nextStep.icon ? (
        <Icon
          name={nextStep.icon}
          className={cn("size-3 shrink-0", nextStep.running && "animate-shine-icon")}
          aria-hidden
        />
      ) : null}
      <span className={cn("min-w-0 truncate", nextStep.running && "animate-shine")}>
        {nextStep.label}
      </span>
    </span>
  );
}

function needsAttention(pullRequest: PullRequest): boolean {
  return (
    pullRequest.attention === "changes_requested" ||
    pullRequest.attention === "review_requested" ||
    pullRequest.attention === "conflicts" ||
    pullRequest.attention === "blocked"
  );
}

const CHANGED_FILES_SEGMENT_KEY = "bb--git/changed-files";

export function usePullRequestSegmentVisible(
  input: ExperimentalThreadContextSegmentInput,
): boolean {
  return useThreadPullRequest(input.environment ? input.threadId : null) !== null;
}

export function PullRequestSegmentSummary({
  threadId,
  segments,
}: ExperimentalThreadContextSegmentProps) {
  const pullRequest = useThreadPullRequest(threadId);
  if (pullRequest === null) return null;
  const alone = segments.length === 1;
  const showLabel =
    alone || (segments.length === 2 && segments.some((s) => s.key === CHANGED_FILES_SEGMENT_KEY));
  const nextStep = getPullRequestNextStep(pullRequest);
  const checkStatus = getPullRequestGithubCheckStatus(pullRequest);
  return (
    <UrlLink
      href={pullRequest.url}
      aria-label={`Pull request ${pullRequest.number}: ${describePullRequestStatus(pullRequest)}`}
      title={`${pullRequest.headRefName} · ${describePullRequestStatus(pullRequest)}`}
      className={cn(
        "flex items-center gap-1.5 overflow-hidden text-xs text-muted-foreground no-underline transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        CONTEXT_CARD_SEGMENT_CLASS,
        checkStatus !== null ? "min-w-13" : "min-w-8",
      )}
    >
      <span className="flex h-4 shrink-0 items-center gap-1">
        <StateIcon pullRequest={pullRequest} />
        {checkStatus === null ? null : <GithubMark status={checkStatus} />}
      </span>
      {showLabel ? (
        <span className="min-w-0 truncate" data-promptbox-hide-compact={alone ? undefined : ""}>
          PR #{pullRequest.number}
          {alone && pullRequest.state !== "open"
            ? ` · ${PULL_REQUEST_STATE_DISPLAY[pullRequest.state].label}`
            : ""}
        </span>
      ) : null}
      {showLabel && nextStep && needsAttention(pullRequest) ? (
        <>
          <span aria-hidden>·</span>
          <NextStepLabel nextStep={nextStep} />
        </>
      ) : null}
      {showLabel && isPullRequestAutoMergeOn(pullRequest) ? (
        <Icon
          name="Zap"
          aria-label="Auto-merge on"
          className="size-3 shrink-0 text-subtle-foreground"
        />
      ) : null}
    </UrlLink>
  );
}

const MERGE_METHODS: readonly { method: PullRequestMergeMethod; label: string }[] = [
  { method: "merge", label: "Merge" },
  { method: "squash", label: "Squash merge" },
  { method: "rebase", label: "Rebase and merge" },
];
// The bundled plugin's key, so the method chosen there is the one offered here.
const MERGE_METHOD_STORAGE_KEY = "bb.pullRequest.mergeMethod";

function readMergeMethod(): PullRequestMergeMethod {
  try {
    const stored = window.localStorage.getItem(MERGE_METHOD_STORAGE_KEY);
    return MERGE_METHODS.find(({ method }) => method === stored)?.method ?? "merge";
  } catch {
    return "merge";
  }
}

const SegmentButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function SegmentButton({ className, type = "button", ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn("px-1.5 py-0.5", BANNER_ACTION_SEGMENT_CLASS, className)}
        {...props}
      />
    );
  },
);

const MENU_ITEM =
  "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-state-hover";

export function PullRequestSegmentAction({ threadId }: ExperimentalThreadContextSegmentProps) {
  const pullRequest = useThreadPullRequest(threadId);
  const action = useRpcMutation({
    contract: pullRequestContract,
    method: "threadPullRequestAction",
  });
  const [mergeMethod, setMergeMethod] = useState(readMergeMethod);
  if (pullRequest === null) return null;

  // The action names the pull request shown, so a branch that moved on is refused.
  const shownPullRequest = { url: pullRequest.url, headRefOid: pullRequest.headRefOid };
  const run = (
    loading: string,
    input: Omit<Parameters<typeof action.mutate>[0], "url" | "headRefOid">,
  ) => {
    const id = toast.loading(loading);
    action.mutate({ ...input, ...shownPullRequest }).then(
      (result) => toast.success(result.message, { id }),
      (error: unknown) =>
        toast.error("Pull request was not updated", {
          id,
          description: error instanceof Error ? error.message : String(error),
        }),
    );
  };
  const merge = (method: PullRequestMergeMethod) => {
    try {
      window.localStorage.setItem(MERGE_METHOD_STORAGE_KEY, method);
    } catch {
      // Remembering the choice is a convenience.
    }
    setMergeMethod(method);
    run(
      `${MERGE_METHODS.find((m) => m.method === method)!.label} pull request #${pullRequest.number}`,
      {
        threadId,
        action: { operation: "merge", method },
      },
    );
  };

  if (pullRequest.state === "draft") {
    return (
      <div
        className={cn(
          "inline-flex overflow-hidden rounded border border-border",
          BANNER_ACTION_FILL_CLASS,
        )}
      >
        <SegmentButton
          disabled={action.isPending}
          onClick={() =>
            run("Marking pull request ready", { threadId, action: { operation: "ready" } })
          }
        >
          {action.isPending ? "Marking..." : "Mark ready"}
        </SegmentButton>
      </div>
    );
  }
  if (pullRequest.state !== "open" || pullRequest.mergeability.state !== "mergeable") return null;
  const selected = MERGE_METHODS.find((m) => m.method === mergeMethod) ?? MERGE_METHODS[0]!;
  return (
    <div
      className={cn(
        "inline-flex overflow-hidden rounded border border-border",
        BANNER_ACTION_FILL_CLASS,
      )}
    >
      <SegmentButton disabled={action.isPending} onClick={() => merge(selected.method)}>
        {selected.label}
      </SegmentButton>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <SegmentButton
            disabled={action.isPending}
            className="inline-flex items-center border-l border-border px-1 data-[state=open]:bg-state-active data-[state=open]:text-foreground"
            aria-label="Choose pull request merge method"
          >
            <Icon name="ChevronDown" className="size-3" aria-hidden="true" />
          </SegmentButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={2}
            className="z-50 min-w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {MERGE_METHODS.map(({ method, label }) => (
              <DropdownMenu.Item key={method} className={MENU_ITEM} onSelect={() => merge(method)}>
                {label}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
            <DropdownMenu.Item
              className={MENU_ITEM}
              onSelect={() =>
                run("Converting pull request to draft", {
                  threadId,
                  action: { operation: "draft" },
                })
              }
            >
              Convert to draft
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

/** The Info tab's Pull request row, for a GitButler thread's own branch. */
export function PullRequestInfoRow({ threadId, environment }: ExperimentalThreadInfoProps) {
  const pullRequest = useThreadPullRequest(environment ? threadId : null);
  if (pullRequest === null) return null;
  const state = getPullRequestStateDisplay(pullRequest);
  const nextStep = getPullRequestNextStep(pullRequest);
  return (
    <DetailRow icon="GitPullRequestArrow" label="Pull request">
      <span className="flex h-5 max-w-full min-w-0 items-center gap-2">
        <UrlLink
          href={pullRequest.url}
          aria-label={`Pull request ${pullRequest.number}: ${describePullRequestStatus(pullRequest)}`}
          title={pullRequest.headRefName}
          className="flex min-w-0 items-center gap-2 text-xs text-foreground no-underline transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <GithubMark />
          <span className="shrink-0 text-muted-foreground">#{pullRequest.number}</span>
          <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-1.5 text-muted-foreground">
            <StateIcon pullRequest={pullRequest} className="size-3.5" />
            <span>{state.label}</span>
          </span>
          {nextStep ? <NextStepLabel nextStep={nextStep} /> : null}
        </UrlLink>
        {isPullRequestAutoMergeOn(pullRequest) ? (
          <span title="Auto-merge on" className="flex shrink-0 items-center text-subtle-foreground">
            <Icon name="Zap" className="size-3" aria-label="Auto-merge on" />
          </span>
        ) : null}
      </span>
    </DetailRow>
  );
}
