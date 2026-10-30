import type { ReviewCommitSummary } from "../../shared/review-protocol/index.ts";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { DiffSelection } from "../../shared/review/lens-selection.ts";
import {
  type Block,
  elements,
  resourceReferences,
  selectionReferences,
} from "../../shared/review/document.ts";
import type { LiveSnapshot } from "../../server/lib/review/store.ts";
import type { DocumentPeekableAnchor } from "../../shared/review/review-document-data.ts";
import type { NormalizedSoftwareModel } from "../../shared/review/software-map-model.ts";
import { base64Bytes } from "../lib/base64.ts";
import { markdownHasTitle } from "../markdown/agent-markdown.tsx";
import type { WhiteboardRpcClient } from "../rpc.ts";
import { type ApiHeadingIds, apiHeadingIds } from "./api-document-headings.ts";
import { AuthoringActivityContext } from "./authoring-activity.tsx";
import { scopeLive } from "./authoring-cursor.ts";
import { BlockErrorBoundary, renderBlock, stored } from "./blocks.tsx";
import { AuthoringCursorContext, Courier } from "./courier.tsx";
import { withErasedBlocks } from "./draw-queue.ts";
import { useMotionPhase, useMotionPhases } from "./draw-queue-provider.tsx";
import { useReviewSession } from "./host/review-session.tsx";
import { reportReviewDocumentRenderError } from "./review-document-error-report.ts";
import { ReviewDocumentTitle } from "./review-document-surface.tsx";
import { cssIdentifier, scrollToReviewHeading } from "./review-heading-scroll.ts";
import { useReviewRoots } from "./review-root-context.tsx";
import type { SoftwareMapResolvedDataPayload } from "./software-map/software-map-snapshot.ts";

import "./api-document.css";

interface Trace {
  label: string;
  events: { id: string; role: string; text: string }[];
}

/** A reference the canvas does not resolve: its authored range no longer
 * exists, or its own checkout is gone for now. */
function staleReference(snapshot: LiveSnapshot, id: string) {
  return (
    snapshot.staleSources?.includes(id) === true ||
    (snapshot.live.kind === "available" && snapshot.live.unavailableAnchors.includes(id))
  );
}

export interface ApiDocumentData {
  snapshot: LiveSnapshot;
  headings: ApiHeadingIds;
  commits: ReviewCommitSummary[];
  anchors: Map<string, DocumentPeekableAnchor>;
  images: Map<string, string>;
  traces: Map<string, Trace>;
  maps: Map<
    string,
    NormalizedSoftwareModel & {
      pinnedData: SoftwareMapResolvedDataPayload & {
        side: "base" | "head";
        diagramId?: string;
      };
    }
  >;
}

/** Cache only immutable resources and commit-addressed quotes, for this canvas. */
export function createDocumentLoader(
  rpc: Pick<WhiteboardRpcClient, "commits" | "map" | "resource">,
) {
  const cache = new Map<string, Promise<unknown>>();
  const urls = new Set<string>();
  let disposed = false;

  const once = <T,>(key: string, read: () => Promise<T>): Promise<T> => {
    if (!cache.has(key))
      cache.set(
        key,
        read().catch((error) => {
          cache.delete(key);
          throw error;
        }),
      );

    // SAFETY: each key identifies one immutable resource and its loader's result type.
    return cache.get(key) as Promise<T>;
  };

  return {
    dispose() {
      disposed = true;

      for (const url of urls) URL.revokeObjectURL(url);
      cache.clear();
    },
    async load(snapshot: LiveSnapshot, generation?: string): Promise<ApiDocumentData> {
      const data: ApiDocumentData = {
        snapshot,
        headings: apiHeadingIds(snapshot.document),
        commits:
          snapshot.live.kind === "unavailable" || !snapshot.source
            ? []
            : await once(`commits:${JSON.stringify(snapshot.source.pins)}`, () =>
                rpc.commits({ sessionId: snapshot.reviewId, version: snapshot.version }),
              ),
        anchors: new Map(),
        images: new Map(),
        traces: new Map(),
        maps: new Map(),
      };

      for (const { id, source, label } of selectionReferences(snapshot.document, {
        tolerant: true,
      })) {
        if (staleReference(snapshot, id)) continue;
        data.anchors.set(
          id,
          sourceAnchor(id, source, label ?? `${source.file}:${source.start.line}`),
        );
      }

      await Promise.all(
        resourceReferences(snapshot.document).map(async (node) => {
          if (node.type === "image") {
            const url = await once(`image:${node.assetId}`, async () => {
              const { contentType, base64 } = await rpc.resource({
                sessionId: snapshot.reviewId,
                resourceId: node.assetId,
              });

              if (disposed) throw new Error("Canvas closed.");
              const url = URL.createObjectURL(
                new Blob([base64Bytes(base64)], { type: contentType }),
              );
              urls.add(url);

              return url;
            });

            data.images.set(node.assetId, url);
          }

          // A trace that cannot be loaded leaves its quote to render as text.
          if (node.type === "trace_quote") {
            const loaded = await once(`trace:${node.traceId}`, async () => {
              const { base64 } = await rpc.resource({
                sessionId: snapshot.reviewId,
                resourceId: node.traceId,
              });
              // SAFETY: a trace resource is the JSON trace its upload stored.
              return JSON.parse(new TextDecoder().decode(base64Bytes(base64))) as Trace;
            }).catch(() => undefined);

            if (loaded) data.traces.set(node.traceId, loaded);
          }

          if (node.type === "software_map") {
            const model = await once(
              `map:${node.mapVersionId}:${JSON.stringify(snapshot.source?.pins ?? null)}:${generation ?? ""}`,
              async () => {
                const saved = await rpc.map({
                  sessionId: snapshot.reviewId,
                  resourceId: node.mapVersionId,
                  version: snapshot.version,
                  generation,
                });

                return {
                  ...saved,
                  pinnedData: {
                    side: saved.side,
                    counts: new Map(Object.entries(saved.countsByElementPath)),
                    unmappedByElementPath: new Map(Object.entries(saved.unmappedByElementPath)),
                  },
                  elementsByPath: new Map(saved.elements.map((element) => [element.path, element])),
                };
              },
            );

            if (!data.maps.has(node.mapVersionId))
              data.maps.set(node.mapVersionId, {
                ...model,
                pinnedData: { ...model.pinnedData, diagramId: node.id },
              });
          }
        }),
      );

      return data;
    },
  };
}

export function sourceAnchor(
  id: string,
  source: DiffSelection,
  title: string,
): DocumentPeekableAnchor {
  return { __kind: "db-anchor-ref", id, title, peek: source };
}

export function ApiDocument({
  data,
  softwareMapEnabled = true,
}: {
  data: ApiDocumentData;
  softwareMapEnabled?: boolean;
}) {
  useHeadingFragments();

  const hasTitle = useMemo(
    () =>
      elements(data.snapshot.document).some(
        (node) => node.type === "markdown" && markdownHasTitle(node.markdown),
      ),
    [data.snapshot.document],
  );

  // The scratchpad is a napkin, not a titled document: no heading, no
  // updated-ago line, just the blocks.
  const scratchpad = data.snapshot.kind === "scratchpad";
  const region = useEditingRegion(data.snapshot.document);

  return (
    <>
      {!hasTitle && !scratchpad && <ReviewDocumentTitle>{data.snapshot.title}</ReviewDocumentTitle>}
      {(data.snapshot.source?.target.kind === "worktree" ||
        data.snapshot.live.kind === "unavailable") && (
        <p className="review-source-context">
          {data.snapshot.live.kind === "unavailable"
            ? "Local checkout unavailable. Showing retained source."
            : "Working tree"}
        </p>
      )}
      <DocumentBlocks
        nodes={data.snapshot.document}
        data={data}
        softwareMapEnabled={softwareMapEnabled}
        region={region}
      />
      <Courier />
    </>
  );
}

/** How long after the courier's last move the agent still counts as
 * writing; the courier sits down at the same moment. */
const WRITING_MS = 3000;

/** The top-level block the agent is editing, the one holding the courier,
 * while the document lease is live: writing while the courier keeps moving,
 * idle once he sits. */
function useEditingRegion(document: Block[]): { id: string; writing: boolean } | null {
  const cursor = useContext(AuthoringCursorContext);
  const live = scopeLive(useContext(AuthoringActivityContext), "document");
  const [quietSeq, setQuietSeq] = useState<number>();
  const seq = cursor?.seq;

  useEffect(() => {
    if (seq === undefined) return;
    const timer = setTimeout(() => setQuietSeq(seq), WRITING_MS);

    return () => clearTimeout(timer);
  }, [seq]);

  const id = useMemo(() => {
    if (!cursor) return undefined;

    return document.find((top) =>
      elements([top]).some((node) => node.id === cursor.blockId || node.id === cursor.targetId),
    )?.id;
  }, [document, cursor]);

  if (!live || !cursor || id === undefined) return null;

  return { id, writing: quietSeq !== cursor.seq };
}

/** Follows a `#fragment` link to one of the document's headings, which can sit
 * in a collapsed section the browser cannot reach; other fragments are left to it. */
function useHeadingFragments(): void {
  const roots = useReviewRoots();

  useEffect(() => {
    const article = roots?.articleRef.current;

    if (!roots || !article) return;

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;

      const link =
        target instanceof Element ? target.closest<HTMLAnchorElement>('a[href^="#"]') : null;

      const id = link?.getAttribute("href")?.slice(1);

      if (!id || !article.querySelector(`#${cssIdentifier(id)}`)) return;
      event.preventDefault();
      scrollToReviewHeading(id, article, roots.scrollRegionRef.current);
    };

    article.addEventListener("click", onClick);

    return () => article.removeEventListener("click", onClick);
  }, [roots]);
}

/**
 * One list of sibling blocks. A block the latest version removed is kept on
 * the board, in its old place, for as long as the draw queue is erasing it;
 * the list remembers the version before so it still has the block to show.
 */
function DocumentBlocks({
  nodes,
  data,
  softwareMapEnabled,
  region,
}: {
  nodes: Block[];
  data: ApiDocumentData;
  softwareMapEnabled: boolean;
  /** Only the top level has a region: the block the agent is editing. */
  region?: { id: string; writing: boolean } | null;
}) {
  const phases = useMotionPhases();
  const previous = useRef(nodes);
  // oxlint-disable-next-line react/refs -- reads the list last committed, which the effect below records; render-time state would also record renders React discards
  const shown = withErasedBlocks(nodes, previous.current, phases);

  useEffect(() => {
    previous.current = shown;
  });

  return shown.map((node) => (
    <DocumentNode
      key={node.id}
      node={node}
      data={data}
      softwareMapEnabled={softwareMapEnabled}
      region={
        region === undefined
          ? undefined
          : !region || region.id !== node.id
            ? "off"
            : region.writing
              ? "writing"
              : "idle"
      }
    />
  ));
}

// Memoized: unrelated App renders must not rebuild every block's view models.
export const DocumentNode = memo(function DocumentNode({
  node,
  data,
  softwareMapEnabled,
  region,
}: {
  node: Block;
  data: ApiDocumentData;
  softwareMapEnabled: boolean;
  region?: "writing" | "idle" | "off";
}) {
  const session = useReviewSession();
  const motion = useMotionPhase(node.id);

  const children = (nodes: Block[]) => (
    <DocumentBlocks nodes={nodes} data={data} softwareMapEnabled={softwareMapEnabled} />
  );

  if (node.type === "software_map" && (!softwareMapEnabled || data.snapshot.origin?.tutorial))
    return null;

  const block = stored(node);

  const stale =
    block.type !== "section" &&
    selectionReferences([block], { tolerant: true }).some((reference) =>
      staleReference(data.snapshot, reference.id),
    );

  return (
    <div
      className="api-document-node"
      data-review-node-id={node.id}
      data-motion={motion}
      data-region={region}
      data-review-copy-prose={node.type === "markdown" || node.type === "trace_quote" || undefined}
    >
      <BlockErrorBoundary
        block={block}
        onError={(error) => reportReviewDocumentRenderError(session, error)}
      >
        {stale ? (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a status message, not a form result, which is what <output> means
          <p role="status">This source range changed. Update the reference to view it.</p>
        ) : (
          renderBlock(block.type, block, data, children)
        )}
      </BlockErrorBoundary>
    </div>
  );
});
