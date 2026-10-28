import { z } from "zod";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query.ts";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import {
  accountSchema,
  branchIdSchema,
  branchSubPath,
  parsePrReference,
  prKey,
  prSubPath,
  sameRevision,
  sharedComparisonSubPath,
} from "../shared/schema.ts";
import type {
  ChangedFile,
  LocalBranch,
  LocalComparison,
  SharedComparisonInput,
  PrRef,
} from "../shared/schema.ts";
import { useBranchReviewed, withReviewedFiles } from "./branch-review.ts";
import { Button } from "./components/ui/button.tsx";
import { PANEL_PATH, shortSha } from "./format.ts";
import { useLocalBranch } from "./local-branch-query.ts";
import { errorText } from "./notice.tsx";
import { useRpcQuery } from "./rpc.ts";
import { useReconcile } from "./sync-state.tsx";

const REVIEW_QUERY = {
  staleTime: 30_000,
  refetchInterval: 30_000,
  refetchOnReconnect: "always",
} as const;

const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
const attributesSchema = z.union([
  z.strictObject({ branch: branchIdSchema, base: sha.optional(), head: sha.optional() }),
  z.strictObject({
    pr: z
      .string()
      .transform(parsePrReference)
      .refine((ref) => ref !== null),
    account: accountSchema.optional(),
  }),
]);

export function ReviewEmbed({ attributes, source, message }: PluginMessageDirectiveProps) {
  useReconcile();
  const parsed = attributesSchema.safeParse(attributes);
  if (!parsed.success) return <code>{source}</code>;
  return (
    <QueryClientProvider client={queryClient}>
      {"branch" in parsed.data ? (
        <BranchEmbed
          id={parsed.data.branch}
          base={parsed.data.base}
          head={parsed.data.head}
          threadId={message.threadId}
        />
      ) : (
        <PrEmbed refValue={parsed.data.pr} account={parsed.data.account} />
      )}
    </QueryClientProvider>
  );
}

function BranchEmbed({
  id,
  base,
  head,
  threadId,
}: {
  id: string;
  base?: string;
  head?: string;
  threadId: string;
}) {
  const branches = useLocalBranch(id, threadId);
  const branch = branches.data;
  if (branch)
    return (
      <LocalCard
        branch={branch}
        discoveryIssue={branches.isError ? errorText(branches.error) : undefined}
        onRetryDiscovery={() => void branches.refetch()}
        original={base && head ? { id, base, head, threadId } : undefined}
      />
    );
  if (base && head) {
    const range = { id, base, head, threadId };
    const branchCheck = {
      pending: branches.isPending || branches.isFetching,
      retry: () => void branches.refetch(),
    };
    // Keep the original reachable during slow discovery without speculatively
    // fetching every historical card's patches on a normal thread open.
    if (branches.isPending && !branches.errorUpdatedAt)
      return (
        <ReviewCard
          title="Branch changes"
          detail={`Original comparison · ${shortSha(base)} → ${shortSha(head)}`}
          subPath={sharedComparisonSubPath(range)}
          actionLabel="Review original comparison"
          branchCheck={branchCheck}
          loading
          onRetry={branchCheck.retry}
        />
      );
    return <SharedCard key={branches.errorUpdatedAt} range={range} branchCheck={branchCheck} />;
  }
  const issue = branches.isError ? errorText(branches.error) : undefined;
  return (
    <ReviewCard
      title="Branch changes"
      subPath=""
      unavailable={!!issue}
      issue={issue}
      loading={!issue}
      onRetry={() => void branches.refetch()}
    />
  );
}

type BranchCheck = { pending: boolean; retry: () => void };

function SharedCard({
  range,
  branchCheck,
}: {
  range: SharedComparisonInput;
  branchCheck: BranchCheck;
}) {
  const comparison = useRpcQuery("sharedComparison", range, { staleTime: Infinity, retry: false });
  if (comparison.data)
    return <SharedFilesCard comparison={comparison.data} range={range} branchCheck={branchCheck} />;
  return (
    <ReviewCard
      title={branchCheck.pending ? "Branch changes" : "Shared changes"}
      subPath={sharedComparisonSubPath(range)}
      actionLabel="Review original comparison"
      branchCheck={branchCheck}
      loading={!comparison.isError}
      issue={comparison.isError ? errorText(comparison.error) : undefined}
      onRetry={() => {
        branchCheck.retry();
        void comparison.refetch();
      }}
    />
  );
}

function SharedFilesCard({
  comparison,
  range,
  branchCheck,
}: {
  comparison: LocalComparison;
  range: SharedComparisonInput;
  branchCheck: BranchCheck;
}) {
  const { id: _id, ...location } = comparison;
  // A discovery failure may mean the checkout disconnected. Verify the pinned
  // range on each fallback entry, even if its cached files are still fresh.
  const files = useRpcQuery("localChanges", location, {
    staleTime: 30_000,
    refetchOnMount: "always",
    retry: false,
  });
  const reviewed = useBranchReviewed(comparison);
  return (
    <ReviewCard
      title={branchCheck.pending ? "Branch changes" : "Shared changes"}
      detail={`Original comparison · ${shortSha(range.base)} → ${shortSha(range.head)}`}
      subPath={sharedComparisonSubPath(range)}
      actionLabel="Review original comparison"
      branchCheck={branchCheck}
      files={files.data ? withReviewedFiles(files.data.files, reviewed.data?.paths) : undefined}
      loading={branchCheck.pending || !files.isFetchedAfterMount || !files.data || !reviewed.data}
      issue={
        files.isError
          ? errorText(files.error)
          : reviewed.isError
            ? errorText(reviewed.error)
            : undefined
      }
      onRetry={() => {
        branchCheck.retry();
        void files.refetch();
        void reviewed.refetch();
      }}
    />
  );
}

function LocalCard({
  branch,
  discoveryIssue,
  onRetryDiscovery,
  original,
}: {
  branch: LocalBranch;
  discoveryIssue?: string;
  onRetryDiscovery: () => void;
  original?: SharedComparisonInput;
}) {
  const files = useRpcQuery(
    "localChanges",
    { hostId: branch.hostId, path: branch.path, base: branch.base, head: branch.head },
    { staleTime: 30_000 },
  );
  const reviewed = useBranchReviewed(branch);
  const issue =
    discoveryIssue ??
    (files.isError
      ? errorText(files.error)
      : reviewed.isError
        ? errorText(reviewed.error)
        : undefined);
  const readyFiles = files.data
    ? withReviewedFiles(files.data.files, reviewed.data?.paths)
    : undefined;
  return (
    <ReviewCard
      title={branch.branch}
      detail={`${branch.repoName} · ${shortSha(branch.base)} → ${shortSha(branch.head)}`}
      subPath={branchSubPath(branch.id, "changes")}
      files={readyFiles}
      loading={!files.data || !reviewed.data}
      issue={issue}
      fallbackSubPath={discoveryIssue && original ? sharedComparisonSubPath(original) : undefined}
      onRetry={() => {
        onRetryDiscovery();
        void files.refetch();
        void reviewed.refetch();
      }}
    />
  );
}

function PrEmbed({ refValue, account: requested }: { refValue: PrRef; account?: string }) {
  const status = useRpcQuery("status", null, { staleTime: 5 * 60_000 });
  const account = requested ?? (status.data?.ok ? status.data.login : undefined);
  if (account) return <PrCard refValue={refValue} account={account} />;
  const issue = status.isError
    ? errorText(status.error)
    : status.data && !status.data.ok
      ? status.data.message
      : undefined;
  return (
    <ReviewCard
      title={prKey(refValue)}
      subPath={prSubPath(refValue, "changes")}
      loading={!issue}
      issue={issue}
      onRetry={() => void status.refetch()}
    />
  );
}

function PrCard({ refValue, account }: { refValue: PrRef; account: string }) {
  const pr = useRpcQuery("pullRequest", { account, ref: refValue }, REVIEW_QUERY);
  const changed = useRpcQuery("changedFiles", { account, ref: refValue }, REVIEW_QUERY);
  const issue = pr.isError
    ? errorText(pr.error)
    : changed.isError
      ? errorText(changed.error)
      : pr.data && changed.data && !sameRevision(changed.data, pr.data)
        ? "The diff is behind the pull request. Refresh to review the latest changes."
        : undefined;
  return (
    <ReviewCard
      title={pr.data?.title ?? prKey(refValue)}
      detail={prKey(refValue)}
      subPath={prSubPath(refValue, "changes", account)}
      files={changed.data?.files}
      loading={!pr.data || !changed.data}
      issue={issue}
      onRetry={() => {
        void pr.refetch();
        void changed.refetch();
      }}
    />
  );
}

function ReviewCard({
  title,
  detail,
  subPath,
  files,
  loading,
  issue,
  unavailable = false,
  onRetry,
  actionLabel,
  branchCheck,
  fallbackSubPath,
}: {
  title: string;
  detail?: string;
  subPath: string;
  files?: readonly ChangedFile[];
  loading: boolean;
  issue?: string;
  unavailable?: boolean;
  onRetry: () => void;
  actionLabel?: string;
  branchCheck?: BranchCheck;
  fallbackSubPath?: string;
}) {
  const navigate = useBbNavigate();
  const count = files?.filter((file) => file.viewed === "viewed").length ?? 0;
  const total = files?.length ?? 0;
  const labels = reviewLabels({ count, total, loading, issue, unavailable });
  return (
    <section
      aria-label="Changes for review"
      className="not-prose my-3 w-full max-w-xl overflow-hidden rounded-lg border border-border bg-background text-xs text-foreground"
    >
      <div className="flex items-start gap-2.5 p-3">
        <Icon
          name="GitPullRequest"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>Review</span>
            <span aria-live="polite" className={labels.ready ? "text-success" : ""}>
              {labels.status}
            </span>
          </div>
          <h3 className="m-0 truncate text-xs font-medium" title={title}>
            {title}
          </h3>
          {detail ? (
            <p className="m-0 mt-1 truncate text-[11px] text-muted-foreground">{detail}</p>
          ) : null}
        </div>
      </div>
      {files ? <FilePreview files={files} /> : null}
      {branchCheck ? (
        <p className="m-0 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          {branchCheck.pending ? (
            "Checking latest branch… Original comparison available below."
          ) : (
            <>
              Latest branch unavailable. Showing the original comparison.{" "}
              <button
                type="button"
                className="cursor-pointer underline"
                onClick={branchCheck.retry}
              >
                Check latest branch
              </button>
            </>
          )}
        </p>
      ) : null}
      {issue ? (
        <div role="alert" className="border-t border-border px-3 py-2 text-[11px] text-destructive">
          {issue}{" "}
          <button type="button" className="cursor-pointer underline" onClick={onRetry}>
            Retry
          </button>
          {fallbackSubPath ? (
            <button
              type="button"
              className="ms-2 cursor-pointer underline"
              onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: fallbackSubPath })}
            >
              Review original comparison
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="px-3 pt-1 pb-3">
        <Button
          size="sm"
          variant={issue ? "outline" : "default"}
          className="h-7 w-full gap-1.5 text-xs"
          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath })}
        >
          {actionLabel ?? labels.action}
          <Icon name="ArrowUpRight" className="size-3" aria-hidden />
        </Button>
      </div>
    </section>
  );
}

function reviewLabels({
  count,
  total,
  loading,
  issue,
  unavailable,
}: {
  count: number;
  total: number;
  loading: boolean;
  issue: string | undefined;
  unavailable: boolean;
}) {
  const ready = !loading && !issue && total > 0 && count === total;
  let status: string | null = null;
  if (issue) status = "Unavailable";
  else if (loading) status = "Loading";
  else if (ready) status = "Ready";
  else if (count > 0) status = "In review";
  let action = "Review changes";
  if (unavailable) action = "Open Review";
  else if (ready) action = "Open reviewed changes";
  return { ready, status, action };
}

function FilePreview({ files }: { files: readonly ChangedFile[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="m-0 list-none px-3 py-1.5">
      {files.slice(0, 3).map((file) => (
        <li key={file.path} className="flex items-center gap-2 py-1">
          <Icon
            name={file.viewed === "viewed" ? "Check" : "File"}
            className="size-3 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={file.path}>
            {file.path}
          </span>
          <span className="shrink-0 tabular-nums">
            <span className="text-diff-added">+{file.additions}</span>{" "}
            <span className="text-diff-removed">−{file.deletions}</span>
          </span>
        </li>
      ))}
      {files.length > 3 ? (
        <li className="py-1 text-[11px] text-muted-foreground">+{files.length - 3} more files</li>
      ) : null}
    </ul>
  );
}
