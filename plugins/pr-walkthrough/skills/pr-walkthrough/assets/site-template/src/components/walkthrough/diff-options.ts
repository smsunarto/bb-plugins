import type { FileDiffOptions } from "@pierre/diffs"

import type { WalkthroughDiffFile } from "@/data/walkthrough"

export type ReviewDiffStyle = "split" | "unified"

export function createDiffOptions<LAnnotation = undefined>(
  diffStyle: ReviewDiffStyle,
  collapsed = false,
  file?: WalkthroughDiffFile,
): FileDiffOptions<LAnnotation> {
  const options: FileDiffOptions<LAnnotation> = {
    collapsed,
    diffIndicators: "bars",
    diffStyle,
    hunkSeparators: "line-info",
    overflow: "scroll",
    stickyHeader: true,
    themeType: "dark",
    unsafeCSS: `
      [data-code] { padding-bottom: 0; scrollbar-gutter: auto; }
      [data-diffs-header="default"] { cursor: pointer; }
      [data-change-icon="change"] { color: var(--diffs-warning-dark); }
    `,
  }

  if (file?.oldContents !== undefined && file.newContents !== undefined) {
    options.loadDiffFiles = async () => ({
      oldFile: {
        contents: file.oldContents ?? "",
        name: file.previousPath ?? file.path,
      },
      newFile: {
        contents: file.newContents ?? "",
        name: file.path,
      },
    })
  }

  return options
}
