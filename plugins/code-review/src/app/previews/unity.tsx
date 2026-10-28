import type { ReactNode } from "react";
import { UnityDiffView, UnityMetaDiffView } from "@bb-plugins/unity-inspector/app";
import type { ChangedFile, Comparison } from "../../shared/schema.ts";
import { Loading, Notice, RetryButton, errorText } from "../notice.tsx";
import { useRpcQuery } from "../rpc.ts";

/**
 * A Unity scene, prefab, asset, or `.meta` change as objects and properties.
 * The server compares the whole files, so a change outside the patch's lines
 * still shows. When it cannot, it says why, and the text diff stays a click away.
 */
export function UnityPreview({
  comparison,
  file,
  onShowText,
  fallback,
}: {
  comparison: Comparison;
  file: Pick<ChangedFile, "path" | "previousPath">;
  /** Switches the card to its text diff. Null when it has none. */
  onShowText: (() => void) | null;
  /** Shown under a reason when there is no text diff to fall back on: the file's sizes and downloads. */
  fallback: ReactNode;
}) {
  const preview = useRpcQuery(
    "unityPreview",
    { comparison, path: file.path, previousPath: file.previousPath },
    // Pinned to commits: the answer never changes.
    { staleTime: Number.POSITIVE_INFINITY, gcTime: 5 * 60_000 },
  );
  if (preview.isPending)
    return <Loading label="Comparing the asset's objects…" rows={4} className="p-3" />;
  if (preview.isError) {
    return (
      <Notice
        tone="error"
        title="Could not compare this asset"
        className="m-3"
        action={<RetryButton onRetry={() => void preview.refetch()} />}
      >
        {errorText(preview.error)}
      </Notice>
    );
  }
  const answer = preview.data;
  if (answer.state === "unavailable") {
    const notice = (
      <Notice
        tone="info"
        title="No object view"
        className="m-3"
        action={
          onShowText ? (
            <button
              type="button"
              className="text-xs text-primary underline-offset-2 hover:underline"
              onClick={onShowText}
            >
              Show the text diff
            </button>
          ) : null
        }
      >
        {answer.reason}
      </Notice>
    );
    return onShowText ? (
      notice
    ) : (
      <>
        {notice}
        {fallback}
      </>
    );
  }
  return (
    <div className="cr-unity">
      {answer.state === "meta" ? (
        <UnityMetaDiffView diff={answer.diff} path={file.path} />
      ) : (
        <UnityDiffView diff={answer.diff} path={file.path} />
      )}
    </div>
  );
}
