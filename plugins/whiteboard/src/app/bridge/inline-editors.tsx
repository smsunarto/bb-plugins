import type {
  ReviewInlineEditorFactory,
  ReviewInlineEditorHandle,
} from "../../shared/vendor/review-protocol/src/index.ts";
import {
  CodeFile,
  createSourceReader,
  documentHeight,
  documentScope,
  loadFiles,
  surfaceErrors,
  type CodeSurfaceDeps,
} from "./diff-view.tsx";
import { lensRangesFor } from "./two-side.ts";

/** Code peeks host bb viewers. Monaco-only find/selection/folding stay inert (§0.1). */
export function createInlineEditors(deps: CodeSurfaceDeps): ReviewInlineEditorFactory {
  const reader = createSourceReader(deps.request);
  return {
    find: async () => ({ matchCount: 0 }),
    create(spec): ReviewInlineEditorHandle {
      const errors = surfaceErrors();
      const heights = new Set<(height: number) => void>();
      const id = `peek:${crypto.randomUUID()}`;
      let disposed = false;
      let collapsed = false;
      let contentHeight = documentHeight(
        36 +
          20 *
            Math.max(
              1,
              spec.ranges.reduce((sum, range) => sum + range.endLine - range.startLine + 7, 0),
            ),
        spec.heightMode,
      );
      let height = contentHeight;
      const reportHeight = (value: number) => {
        contentHeight = documentHeight(value, spec.heightMode);
        const next = collapsed ? 40 : contentHeight;
        if (height === next) return;
        height = next;
        for (const listener of heights) listener(height);
      };
      const onError = errors.fire;
      const unmount = deps.portals.mount({
        id,
        container: spec.container,
        element: <output>Loading source…</output>,
      });
      spec.container.classList.toggle("review-document-code-active", spec.active);
      const applyCollapsed = () => {
        const root = spec.container.querySelector<HTMLElement>("[data-wb-peek]");
        if (root) root.hidden = collapsed;
        reportHeight(contentHeight);
      };
      // Progress re-renders the peek. Its files and ranges keep their identity, so it does not reload.
      let progress = spec.progress;
      let render: (() => void) | undefined;
      try {
        const view = deps.sourceView?.();
        const reviewId = view?.reviewId ?? deps.reviewId;
        if (!reviewId) throw new Error("No Whiteboard session is open.");
        const { lens, comparison } = documentScope(view, reviewId, spec);
        void loadFiles(reader, comparison, lens).then((files) => {
          const peeks = files.map((file) => ({ file, ranges: lensRangesFor(lens.ranges, file) }));
          render = () => {
            if (disposed) return;
            deps.portals.update(
              id,
              <div
                data-wb-peek=""
                hidden={collapsed}
                className={
                  spec.heightMode === "capped" ? "flex max-h-[400px] flex-col overflow-hidden" : ""
                }
                onFocus={spec.onDidFocus}
              >
                {peeks.map(({ file, ranges }) => (
                  <CodeFile
                    key={file.path}
                    file={file}
                    reader={reader}
                    comparison={comparison}
                    ranges={ranges}
                    side={spec.side}
                    label={spec.title}
                    progress={progress?.files.find((item) => item.path === file.path)}
                    openFile={deps.openFile}
                    onError={onError}
                    onHeight={reportHeight}
                    heightMode={spec.heightMode}
                  />
                ))}
              </div>,
            );
          };
          render();
          return undefined;
        }, onError);
      } catch (error) {
        onError(error);
      }
      return {
        get height() {
          return height;
        },
        setProgress(value) {
          progress = value;
          render?.();
        },
        setActive(active) {
          spec.container.classList.toggle("review-document-code-active", active);
        },
        setCollapsed(value) {
          collapsed = value;
          applyCollapsed();
        },
        onDidChangeHeight(listener) {
          heights.add(listener);
          return {
            dispose: () => {
              heights.delete(listener);
            },
          };
        },
        onDidError: errors.subscribe,
        setFindQuery: async () => ({ matchCount: 0 }),
        revealFindMatch() {},
        clearActiveFindMatch() {},
        clearFind() {},
        dispose() {
          disposed = true;
          errors.dispose();
          heights.clear();
          spec.container.classList.remove("review-document-code-active");
          unmount();
        },
      };
    },
  };
}
