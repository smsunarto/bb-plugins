import { z } from "zod";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
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
} from "../shared/schema.ts";
import type { ChangedFile, LocalBranch, PrRef } from "../shared/schema.ts";
import { useBranchReviewed, withReviewedFiles } from "./branch-review.ts";
import { Button } from "./components/ui/button.tsx";
import { PANEL_PATH, plural, shortSha } from "./format.ts";
import { useLocalBranch } from "./local-branch-query.ts";
import { errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";
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
    <PluginQueryBoundary>
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
    </PluginQueryBoundary>
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
        updated={
          (head !== undefined && head !== branch.head) ||
          (base !== undefined && base !== branch.base)
        }
      />
    );
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

function LocalCard({
  branch,
  updated,
  discoveryIssue,
  onRetryDiscovery,
}: {
  branch: LocalBranch;
  updated: boolean;
  discoveryIssue?: string;
  onRetryDiscovery: () => void;
}) {
  const files = rpc.localChanges.useQuery(
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
      updated={updated}
      onRetry={() => {
        onRetryDiscovery();
        void files.refetch();
        void reviewed.refetch();
      }}
    />
  );
}

function PrEmbed({ refValue, account: requested }: { refValue: PrRef; account?: string }) {
  const status = rpc.status.useQuery({ staleTime: 5 * 60_000 });
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
  const pr = rpc.pullRequest.useQuery({ account, ref: refValue }, REVIEW_QUERY);
  const changed = rpc.changedFiles.useQuery({ account, ref: refValue }, REVIEW_QUERY);
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
  updated = false,
  unavailable = false,
  onRetry,
}: {
  title: string;
  detail?: string;
  subPath: string;
  files?: readonly ChangedFile[];
  loading: boolean;
  issue?: string;
  updated?: boolean;
  unavailable?: boolean;
  onRetry: () => void;
}) {
  const navigate = useBbNavigate();
  const count = files?.filter((file) => file.viewed === "viewed").length ?? 0;
  const total = files?.length ?? 0;
  const labels = reviewLabels({ count, total, loading, issue, updated, unavailable });
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
            <span>Code Review</span>
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
      {updated ? (
        <p className="m-0 border-t border-border px-3 py-2 text-[11px] text-warning-text">
          New changes since this card was shared.
        </p>
      ) : null}
      {issue ? (
        <div role="alert" className="border-t border-border px-3 py-2 text-[11px] text-destructive">
          {issue}{" "}
          <button type="button" className="cursor-pointer underline" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-2.5">
        <span aria-live="polite" className="text-[11px] text-muted-foreground tabular-nums">
          {labels.progress}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath })}
        >
          {labels.action}
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
  updated,
  unavailable,
}: {
  count: number;
  total: number;
  loading: boolean;
  issue: string | undefined;
  updated: boolean;
  unavailable: boolean;
}) {
  const ready = !loading && !issue && total > 0 && count === total;
  let status = "Needs review";
  if (issue) status = "Unavailable";
  else if (loading) status = "Loading";
  else if (ready) status = "Ready";
  else if (count > 0) status = "In review";
  const progress = issue
    ? "Progress unavailable"
    : loading
      ? "Loading changes…"
      : `${count} of ${plural(total, "file")} reviewed`;
  let action = "Review changes";
  if (unavailable) action = "Open Code Review";
  else if (updated) action = "Review latest changes";
  else if (ready) action = "Open reviewed changes";
  return { ready, status, progress, action };
}

function FilePreview({ files }: { files: readonly ChangedFile[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="m-0 list-none border-t border-border px-3 py-1.5">
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
