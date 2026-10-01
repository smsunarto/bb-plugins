import type {
  ReviewInlineEditorFactory,
  ReviewInlineEditorHandle,
  ReviewSourceView,
} from "../../shared/vendor/review-protocol/src/index.ts";
import type { WhiteboardRpcClient } from "../rpc.ts";
import {
  createDocumentView,
  createSourceReader,
  documentScope,
  findDocument,
  type Request,
} from "./diff-view.tsx";
import type { SurfaceEvents } from "./events.ts";
import type { Portals } from "./portals.tsx";

/**
 * Code peeks rendered with bb code surfaces (design §1.5, §3.8). As in the
 * Desktop host (`reviewApiSourceService.ts` `canvas().inlineEditors`), a peek
 * is a document-mode diff view scoped by a lens built from its ranges, read at
 * its own pins when it names them.
 *
 * `create` returns at once; the peek reads `/diff?format=files` and both
 * sides through `/file`, then reports its height. `find` counts matches for
 * a peek that is not mounted yet, with the same lens and order `setFindQuery`
 * uses, so the canvas find can index into either.
 */
export function createInlineEditors(deps: {
  request: Request;
  rpc: WhiteboardRpcClient;
  reviewId?: string;
  portals: Portals;
  events: SurfaceEvents;
  /** The comparison the canvas shows (`ReviewCanvasContent.setSourceView`). */
  sourceView?: () => ReviewSourceView | undefined;
}): ReviewInlineEditorFactory {
  const reader = createSourceReader(deps.request);
  const scope = (spec: Parameters<ReviewInlineEditorFactory["find"]>[0]) => {
    const reviewId = deps.sourceView?.()?.reviewId ?? deps.reviewId;

    if (!reviewId) throw new Error("No Whiteboard session is open.");

    return documentScope(deps.sourceView?.(), reviewId, spec);
  };

  // Own enumerable members: the canvas spreads this factory (`api-canvas.tsx`).
  return {
    create: (spec): ReviewInlineEditorHandle => {
      const { lens, comparison } = scope(spec);

      return createDocumentView(spec, lens, { reader, comparison }, deps);
    },
    find: async (spec, query) => {
      const { lens, comparison } = scope(spec);

      return { matchCount: (await findDocument({ reader, comparison }, lens, query)).length };
    },
  };
}
