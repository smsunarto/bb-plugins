import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { z } from "zod";
import { QueryClientProvider, useMutation, useMutationState } from "@tanstack/react-query";
import { queryClient } from "./query.ts";
import { experimental_Icon as Icon, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
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
import type { ChangedFile, PrRef } from "../shared/schema.ts";
import { useBranchReviewed, withReviewedFiles } from "./branch-review.ts";
import { Button } from "./components/ui/button.tsx";
import { PANEL_PATH, shortSha } from "./format.ts";
import { useLocalBranch } from "./local-branch-query.ts";
import { errorText } from "./notice.tsx";
import { useRpcQuery } from "./rpc.ts";
import { useReconcile } from "./sync-state.tsx";

const ShipContext = createContext<ReturnType<typeof useShipMutation> | null>(null);

const EmbedIdentityContext = createContext("");

function useShipMutation(threadId: string, identity: string) {
  const sdk = useSdk();
  const mutationKey = ["embed-ship", identity];
  const mutation = useMutation(
    {
      mutationKey,
      // Timeline virtualization can unmount a card while its send is in flight.
      gcTime: Infinity,
      mutationFn: () =>
        sdk.threads.send({
          threadId,
          mode: "queue-if-active",
          input: [{ type: "text", text: "ship it", mentions: [] }],
        }),
      retry: false,
    },
    queryClient,
  );
  const deliveries = useMutationState(
    {
      filters: { mutationKey, exact: true },
      select: ({ state }) => ({
        status: state.status,
        queued: isQueuedDelivery(state.data),
        error: state.error,
      }),
    },
    queryClient,
  );
  const latest = deliveries.at(-1);
  return {
    mutate: mutation.mutate,
    isPending: latest?.status === "pending",
    isSuccess: latest?.status === "success",
    isError: latest?.status === "error",
    queued: latest?.queued === true,
    error: latest?.error,
  };
}

function isQueuedDelivery(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "delivery" in value &&
    value.delivery === "queued"
  );
}

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
  const identity = JSON.stringify([message.threadId, message.id, parsed.data]);
  return (
    <QueryClientProvider client={queryClient}>
      <EmbedSession
        key={identity}
        identity={identity}
        target={parsed.data}
        threadId={message.threadId}
      />
    </QueryClientProvider>
  );
}

function EmbedSession({
  identity,
  target,
  threadId,
}: {
  identity: string;
  target: z.output<typeof attributesSchema>;
  threadId: string;
}) {
  const ship = useShipMutation(threadId, identity);
  return (
    <EmbedIdentityContext value={identity}>
      <ShipContext.Provider value={ship}>
        {"branch" in target ? (
          <BranchEmbed
            id={target.branch}
            base={target.base}
            head={target.head}
            threadId={threadId}
          />
        ) : (
          <PrEmbed refValue={target.pr} account={target.account} />
        )}
      </ShipContext.Provider>
    </EmbedIdentityContext>
  );
}

/** Data changes update one card rather than swapping loading/fallback/ready component trees. */
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
  const original = base && head ? { id, base, head, threadId } : null;
  const fallback =
    !branch && original !== null && (!branches.isPending || !!branches.errorUpdatedAt);
  const shared = useRpcQuery("sharedComparison", original, {
    enabled: fallback,
    staleTime: Infinity,
    retry: false,
  });
  const comparison = branch ?? (fallback ? shared.data : undefined);
  const files = useRpcQuery(
    "localChanges",
    comparison
      ? {
          hostId: comparison.hostId,
          path: comparison.path,
          base: comparison.base,
          head: comparison.head,
        }
      : null,
    {
      enabled: !!comparison,
      staleTime: 30_000,
      retry: branch ? 1 : false,
    },
  );
  const comparisonKey = comparison
    ? JSON.stringify([comparison.hostId, comparison.path, comparison.base, comparison.head])
    : null;
  const refetchFiles = files.refetch;
  useEffect(() => {
    // Verify on entry even with a warm cache, without making every focus a stale read.
    if (fallback && comparisonKey) void refetchFiles({ cancelRefetch: false });
  }, [fallback, comparisonKey, refetchFiles]);
  const reviewed = useBranchReviewed(comparison ?? null);
  const retry = () => {
    void branches.refetch();
    if (fallback) void shared.refetch();
    if (comparison) {
      void files.refetch();
      void reviewed.refetch();
    }
  };
  const data = { branches, branch, original, fallback, shared, comparison, files, reviewed };
  return <ReviewCard {...branchCardModel(data)} onRetry={retry} />;
}

type BranchCardData = {
  branches: ReturnType<typeof useLocalBranch>;
  branch: ReturnType<typeof useLocalBranch>["data"];
  original: import("../shared/schema.ts").SharedComparisonInput | null;
  fallback: boolean;
  shared: ReturnType<typeof useRpcQuery<"sharedComparison">>;
  comparison:
    | ReturnType<typeof useLocalBranch>["data"]
    | ReturnType<typeof useRpcQuery<"sharedComparison">>["data"];
  files: ReturnType<typeof useRpcQuery<"localChanges">>;
  reviewed: ReturnType<typeof useBranchReviewed>;
};

type CardModel = Omit<Parameters<typeof ReviewCard>[0], "onRetry">;

function queryIssue(...queries: { isError: boolean; error: unknown }[]) {
  const failed = queries.find((query) => query.isError);
  return failed ? errorText(failed.error) : undefined;
}

function branchCardModel(data: BranchCardData): CardModel {
  const { branch, branches, original, files, reviewed } = data;
  if (!branch) return originalCardModel(data);
  return {
    title: branch.branch,
    detail: `${branch.repoName} · ${shortSha(branch.base)} → ${shortSha(branch.head)}`,
    subPath: branchSubPath(branch.id, "changes"),
    files: files.data ? withReviewedFiles(files.data.files, reviewed.data?.paths) : undefined,
    loading: !files.data || !reviewed.data,
    issue: queryIssue(branches, files, reviewed),
    fallbackSubPath: branches.isError && original ? sharedComparisonSubPath(original) : undefined,
  };
}

function originalCardModel(data: BranchCardData): CardModel {
  const { branches, original, fallback, shared, comparison, files, reviewed } = data;
  if (!original) {
    const issue = queryIssue(branches);
    return { title: "Branch changes", subPath: "", loading: !issue, unavailable: !!issue, issue };
  }
  return {
    title: fallback && !branches.isFetching ? "Shared changes" : "Branch changes",
    detail: `Original comparison · ${shortSha(original.base)} → ${shortSha(original.head)}`,
    subPath: sharedComparisonSubPath(original),
    actionLabel: "Review original comparison",
    branchCheck: {
      pending: branches.isPending || branches.isFetching,
      retry: () => void branches.refetch(),
    },
    files:
      comparison && files.data
        ? withReviewedFiles(files.data.files, reviewed.data?.paths)
        : undefined,
    loading:
      !comparison ||
      !files.data ||
      !reviewed.data ||
      !files.isFetchedAfterMount ||
      branches.isFetching,
    issue: comparison ? queryIssue(files, reviewed) : fallback ? queryIssue(shared) : undefined,
  };
}

type BranchCheck = { pending: boolean; retry: () => void };

function PrEmbed({ refValue, account: requested }: { refValue: PrRef; account?: string }) {
  const status = useRpcQuery("status", null, { enabled: !requested, staleTime: 5 * 60_000 });
  const account = requested ?? (status.data?.ok ? status.data.login : undefined);
  const input = account ? { account, ref: refValue } : null;
  const pr = useRpcQuery("pullRequest", input, { ...REVIEW_QUERY, enabled: !!account });
  const changed = useRpcQuery("changedFiles", input, { ...REVIEW_QUERY, enabled: !!account });
  const issue = queryIssue(pr, changed) ?? prRevisionIssue(pr.data, changed.data);
  const accountIssue = status.isError
    ? errorText(status.error)
    : status.data && !status.data.ok
      ? status.data.message
      : undefined;
  return (
    <ReviewCard
      title={pr.data?.title ?? prKey(refValue)}
      detail={account ? prKey(refValue) : undefined}
      subPath={prSubPath(refValue, "changes", account)}
      files={changed.data?.files}
      loading={!account || !pr.data || !changed.data}
      issue={account ? issue : accountIssue}
      onRetry={() => {
        if (!account) void status.refetch();
        else {
          void pr.refetch();
          void changed.refetch();
        }
      }}
    />
  );
}

function prRevisionIssue(
  pr: ReturnType<typeof useRpcQuery<"pullRequest">>["data"],
  changed: ReturnType<typeof useRpcQuery<"changedFiles">>["data"],
) {
  if (pr && changed && !sameRevision(changed, pr))
    return "The diff is behind the pull request. Refresh to review the latest changes.";
  return undefined;
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
  const identity = useContext(EmbedIdentityContext);
  const entrance = useEmbedEntrance(identity);
  const count = files?.filter((file) => file.viewed === "viewed").length ?? 0;
  const total = files?.length ?? 0;
  const labels = reviewLabels({ count, total, loading, issue, unavailable });
  return (
    <section
      ref={entrance}
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
        <div role="alert" className="px-3 py-2 text-[11px] text-destructive">
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
      <div className="flex flex-wrap gap-2 px-3 pt-1 pb-3">
        <Button
          size="sm"
          variant={issue ? "outline" : "default"}
          className="h-7 min-w-0 flex-1 gap-1.5 text-xs"
          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath })}
        >
          {actionLabel ?? labels.action}
          <Icon name="ArrowUpRight" className="size-3" aria-hidden />
        </Button>
        <ShipItButton />
      </div>
    </section>
  );
}

function useShipFeedback(ship: ReturnType<typeof useShipMutation> | null) {
  const feedback = useRef<HTMLSpanElement>(null);
  const pointerSend = useRef(false);
  const status = ship?.isPending
    ? "pending"
    : ship?.isSuccess
      ? "success"
      : ship?.isError
        ? "error"
        : "idle";
  useLayoutEffect(() => {
    if (!pointerSend.current) return;
    const animation = fade(feedback.current);
    if (status !== "pending") pointerSend.current = false;
    return () => animation?.cancel();
  }, [status]);
  const send = (detail: number) => {
    pointerSend.current = detail > 0;
    ship?.mutate();
  };
  return { feedback, send };
}

function ShipItButton() {
  const ship = useContext(ShipContext);
  const { feedback, send } = useShipFeedback(ship);
  if (!ship) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 text-xs"
        disabled={ship.isPending || ship.isSuccess}
        onClick={(event) => {
          send(event.detail);
        }}
      >
        <span ref={feedback}>
          {ship.isPending
            ? "Sending…"
            : ship.isSuccess
              ? ship.queued
                ? "Queued"
                : "Sent"
              : "Ship it"}
        </span>
        <Icon name={ship.isSuccess ? "Check" : "Send"} className="size-3" aria-hidden />
      </Button>
      {ship.isError ? (
        <p role="alert" className="m-0 w-full text-[11px] text-destructive">
          Could not send: {errorText(ship.error)}
        </p>
      ) : null}
    </>
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

/** Once per card per plugin session: scrolling back to a virtualized reply never replays it. */
const entered = new Set<string>();

function fade(element: HTMLElement | null) {
  if (!element?.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  return element.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 180,
    easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  });
}

function useEmbedEntrance(identity: string) {
  const element = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (entered.has(identity)) return;
    entered.add(identity);
    const animation = fade(element.current);
    return () => animation?.cancel();
  }, [identity]);
  return element;
}
