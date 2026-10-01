// Vendored from dev.fast review/app/src/lens-counts.tsx @4ecc570 (MIT).
import type { CoverageProgress } from "../../../../../shared/vendor/review/src/viewed-coverage.ts";
import { compactDiffCount as compact } from "./diff-count.tsx";

export function ElementCounts({ progress }: { progress: CoverageProgress }) {
  return progress.state === "viewed" ? (
    <tspan>✓</tspan>
  ) : progress.state === "folded" ? (
    <tspan>Folded</tspan>
  ) : (
    <>
      <tspan className="diff-count-added">
        +{compact(progress.remaining.additions)}
      </tspan>
      <tspan dx="6" className="diff-count-removed">
        −{compact(progress.remaining.deletions)}
      </tspan>
    </>
  );
}

/** The same counts for an HTML caption, outside SVG text. */
export function ElementCountsText({
  progress,
}: {
  progress: CoverageProgress;
}) {
  return progress.state === "viewed" ? (
    <span>✓</span>
  ) : progress.state === "folded" ? (
    <span>Folded</span>
  ) : (
    <>
      <span className="diff-count-added">
        +{compact(progress.remaining.additions)}
      </span>{" "}
      <span className="diff-count-removed">
        −{compact(progress.remaining.deletions)}
      </span>
    </>
  );
}
