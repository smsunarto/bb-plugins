import type { SharedComparisonInput } from "../shared/schema.ts";
import { BranchReview } from "./changes.tsx";
import { shortSha } from "./format.ts";
import { Loading, Notice, RetryButton, errorText } from "./notice.tsx";
import { useRpcQuery } from "./rpc.ts";
import { useReconcile } from "./sync-state.tsx";

/** The original comparison, independent of the branch's later publication or deletion. */
export function SharedComparisonView({ range }: { range: SharedComparisonInput }) {
  useReconcile();
  const comparison = useRpcQuery("sharedComparison", range, { staleTime: Infinity, retry: false });
  if (!comparison.data)
    return comparison.isError ? (
      <Notice
        tone="error"
        title="Could not load shared commits"
        action={<RetryButton onRetry={() => void comparison.refetch()} />}
      >
        {errorText(comparison.error)}
      </Notice>
    ) : (
      <Loading label="Loading shared commits…" />
    );
  return (
    <>
      <header className="shrink-0 border-b border-border px-3 py-2.5">
        <h1 className="text-sm font-semibold">Shared changes</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Original comparison · {shortSha(range.base)} → {shortSha(range.head)}
        </p>
      </header>
      <BranchReview
        branch={{ ...comparison.data, branch: "Shared changes" }}
        section="changes"
        overview={null}
      />
    </>
  );
}
