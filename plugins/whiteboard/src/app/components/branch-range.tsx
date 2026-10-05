import { type ReactElement, useEffect, useRef, useState } from "react";
import { copyText } from "../vendor/review/app/src/copy-text.tsx";
import {
  shortRef,
  ReviewBranchRange as VendoredBranchRange,
} from "../vendor/review/app/src/review-branch-range.tsx";
import { useTooltip } from "../vendor/review/app/src/use-tooltip.ts";

export { shortRef };

/**
 * The document header's commit range. A session pinned to one commit (plan
 * and architecture Whiteboards) shows that commit once instead of upstream's
 * `X ← X`. review-doc-meta.tsx reaches this through a redirect row; the
 * Commits view keeps the vendored range.
 */
export function ReviewBranchRange({
  baseRef,
  headRef,
}: {
  baseRef: string;
  headRef: string;
}): ReactElement {
  if (baseRef !== headRef) return <VendoredBranchRange baseRef={baseRef} headRef={headRef} />;
  return <SessionCommit commit={headRef} />;
}

/** Upstream's copyable chip (review-branch-range.tsx `BranchRef`, not exported) for one commit. */
function SessionCommit({ commit }: { commit: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tooltip = useTooltip(`commit ${commit}`, { detail: "Click to copy" });

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async () => {
    if (!(await copyText(commit))) return;
    clearTimeout(resetTimer.current);
    setCopied(true);
    resetTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  // One chip needs no group. Its name says what a click does, as upstream's chips do.
  return (
    <div className="review-branch-range">
      <button
        type="button"
        className="review-branch-copy"
        data-side="head"
        data-copied={copied || undefined}
        aria-label={`Copy session commit hash ${commit}`}
        ref={tooltip}
        onClick={() => void copy()}
      >
        <span className="review-branch-name">{shortRef(commit)}</span>
        <output className="review-branch-feedback">{copied ? "Copied" : ""}</output>
      </button>
    </div>
  );
}
