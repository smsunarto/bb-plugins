// Vendored from dev.fast review/app/src/flow-graph.tsx @4ecc570 (MIT).
import {
  BaseEdge,
  Controls,
  type Edge,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal,
} from "@xyflow/react";
import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import ELK, { type ElkNode } from "../../../../lib/elk.ts";
import {
  EXPANDED_MAX_ZOOM,
  EXPANDED_ZOOM_FLOOR,
  FLOW_PADDING as PADDING,
  centerViewport,
  fitZoom,
  inlineFlowHeight,
  shouldPan,
} from "../../../../lib/flow-fit.ts";

import type {
  FlowDiagramBlock,
  FlowDiagramNode,
} from "../../../../../shared/vendor/review/src/review-api/blocks/flow_diagram.ts";
import {
  type CoverageProgress,
  coverageProgress,
} from "../../../../../shared/vendor/review/src/viewed-coverage.ts";
import { useReviewDebugSettings } from "./debug-settings.tsx";
import { useMotionPhase } from "./draw-queue-provider.tsx";
import { ElementCountsText } from "./lens-counts.tsx";
import { useReviewLenses } from "./review-lenses.tsx";

/**
 * Every flow surface: the document block, the Diff sidebar lens and the
 * fullscreen tour. ELK lays the graph out; React Flow draws it in a box that
 * fits the whole drawing to itself, so a node landing at the bottom of a
 * tall layout is still inside the box the reader is looking at. Nodes are
 * DOM, edges are paths, so the draw queue's phases apply as they do to a
 * sequence diagram. A decision is a dashed box, a terminal a pill.
 *
 * bb: inline, the box grows to the drawing's height (up to 1400px) instead
 * of shrinking the drawing into upstream's fixed box. Expanded, the fit
 * stops at a readable zoom and follows the selected node (lib/flow-fit.ts).
 */
export function FlowGraph({
  block,
  direction = block.direction,
  selectedKey,
  onSelect,
  requireReady = false,
  interactive = false,
  height = 340,
}: {
  block: FlowDiagramBlock;
  direction?: "down" | "right";
  selectedKey?: string | null;
  requireReady?: boolean;
  /** Pan and zoom by hand, for the fullscreen tour. */
  interactive?: boolean;
  height?: number | string;
  onSelect(node: FlowDiagramNode): void;
}) {
  const { theme } = useReviewDebugSettings();
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState<Layout>();
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [frameSize, setFrameSize] = useState<FrameSize>();
  // Set by the reader's own pan or zoom; refits stop from then on.
  const moved = useRef(false);
  const markMoved = () => {
    moved.current = true;
  };

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    void layoutFlow(block, direction)
      .then((result) => {
        if (!cancelled) setLayout(result);
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [block, direction]);

  // The frame's width sizes an inline figure, and every resize refits.
  // Measured at once too, so the width is known before ELK's async layout lands.
  useEffect(() => {
    if (!frame) return;

    const measure = () => {
      const { width, height } = frame.getBoundingClientRect();

      setFrameSize((size) =>
        size?.width === width && size.height === height
          ? size
          : { width, height },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);

    return () => observer.disconnect();
  }, [frame]);

  const nodes = useMemo<FlowNodeType[]>(
    () =>
      layout
        ? block.nodes.flatMap((node) => {
            const position = layout.nodes.get(node.key);

            if (!position) return [];

            return [
              {
                id: node.key,
                type: "flowNode",
                position,
                ...SIZE,
                draggable: false,
                selectable: false,
                data: {
                  node,
                  requireReady,
                  selected: selectedKey === node.key,
                  select: () => onSelect(node),
                },
              },
            ];
          })
        : [],
    [block, layout, requireReady, selectedKey, onSelect],
  );

  const edges = useMemo<FlowEdgeType[]>(
    () =>
      layout
        ? layout.edges.map((edge) => ({
            id: `${edge.index}:${edge.section}`,
            source: block.edges[edge.index]!.from,
            target: block.edges[edge.index]!.to,
            type: "flowEdge",
            selectable: false,
            markerEnd: ARROW,
            data: {
              unitId: block.edges[edge.index]!.id,
              label: edge.label,
              dashed: block.edges[edge.index]!.style === "dashed",
              points: edge.points,
            },
          }))
        : [],
    [block, layout],
  );

  if (error) return <p role="alert">Could not lay out diagram: {error}</p>;

  // Inline only: the tour stage passes "100%" and fills its overlay.
  const frameHeight =
    !interactive && typeof height === "number" && layout && frameSize
      ? inlineFlowHeight({
          layoutWidth: layout.width,
          layoutHeight: layout.height,
          frameWidth: frameSize.width,
          minHeight: height,
        })
      : height;

  // The frame holds its default height while ELK runs, so nothing jumps.
  return (
    <div
      ref={setFrame}
      className="lens-flow"
      style={{ height: frameHeight }}
      aria-label={block.title}
    >
      {layout ? (
        <ReactFlowProvider>
          <ReactFlow
            colorMode={theme}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            minZoom={0.1}
            maxZoom={interactive ? EXPANDED_MAX_ZOOM : 1}
            onNodeClick={(_, node) => {
              if (node.type === "flowNode") node.data.select();
            }}
            // Programmatic moves carry no event; only the reader's do. A
            // press starts a gesture without moving (a node click), so a
            // drag counts from its first move.
            onMoveStart={(event) => {
              if (
                event &&
                event.type !== "mousedown" &&
                event.type !== "touchstart"
              )
                markMoved();
            }}
            onMove={(event) => {
              if (event) markMoved();
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            panActivationKeyCode={null}
            panOnDrag={interactive}
            panOnScroll={interactive}
            preventScrolling={interactive}
            zoomOnScroll={interactive}
            zoomOnPinch={interactive}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
          >
            <FitToLayout
              layout={layout}
              frame={frame}
              frameSize={frameSize}
              interactive={interactive}
              selected={selectedKey ? layout.nodes.get(selectedKey) : undefined}
              moved={moved}
            />
            <FlowEdgeLabels layout={layout} edges={edges} />
            {interactive && (
              <Controls
                showInteractive={false}
                fitViewOptions={{ padding: `${PADDING}px`, maxZoom: 1 }}
                onZoomIn={markMoved}
                onZoomOut={markMoved}
                onFitView={markMoved}
              />
            )}
          </ReactFlow>
        </ReactFlowProvider>
      ) : (
        <p className="lens-diagram-note">Laying out flow…</p>
      )}
    </div>
  );
}

interface FrameSize {
  width: number;
  height: number;
}

const motionDuration = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300;

const ARROW = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
  color: "var(--ink-muted)",
};

/**
 * Fits the box to the layout: ELK reports the drawing's size, the frame
 * reports its own, so the viewport is set outright instead of asking React
 * Flow to measure nodes first. Refits on every layout and every resize,
 * animated once the first fit has landed, until the reader pans or zooms by
 * hand. Never enlarges past 1:1. Expanded, the fit stops at a readable zoom
 * centered on the selected node, and selecting a node off screen pans to it.
 */
function FitToLayout({
  layout,
  frame,
  frameSize,
  interactive,
  selected,
  moved,
}: {
  layout: Layout;
  frame: HTMLDivElement | null;
  /** The observed size: a change refits. */
  frameSize: FrameSize | undefined;
  interactive: boolean;
  selected: { x: number; y: number } | undefined;
  moved: RefObject<boolean>;
}) {
  const flow = useReactFlow();
  const fitted = useRef(false);
  const focus = selected && { ...selected, w: SIZE.width, h: SIZE.height };

  const fit = useEffectEvent(() => {
    // Measured now: an inline frame resizes in the commit the layout lands in.
    const box = frame?.getBoundingClientRect();

    if (!box?.width || !box.height || moved.current) return;

    const zoom = interactive
      ? Math.max(fitZoom(layout, box), EXPANDED_ZOOM_FLOOR)
      : fitZoom(layout, box);

    void flow.setViewport(centerViewport(layout, box, zoom, focus), {
      duration: fitted.current ? motionDuration() : 0,
    });
    fitted.current = true;
  });

  const reveal = useEffectEvent(() => {
    const box = frame?.getBoundingClientRect();

    if (!focus || !box || !fitted.current) return;

    const viewport = flow.getViewport();

    if (!shouldPan({ ...viewport, width: box.width, height: box.height }, focus))
      return;

    void flow.setViewport(centerViewport(layout, box, viewport.zoom, focus), {
      duration: motionDuration(),
    });
  });

  useEffect(() => fit(), [layout, frameSize]);

  useEffect(() => reveal(), [selected]);

  return null;
}

/**
 * Every edge label in one SVG layer above the edges, so no later edge paints
 * over an earlier edge's label. Flow coordinates, like the edge paths.
 */
function FlowEdgeLabels({
  layout,
  edges,
}: {
  layout: Layout;
  edges: FlowEdgeType[];
}) {
  return (
    <ViewportPortal>
      <svg
        className="lens-flow-edge-labels"
        width={layout.width}
        height={layout.height}
        style={{ position: "absolute", top: 0, left: 0, overflow: "visible" }}
      >
        {edges.map((edge) =>
          edge.data?.label ? (
            <FlowEdgeLabel
              key={edge.id}
              unitId={edge.data.unitId}
              label={edge.data.label}
            />
          ) : null,
        )}
      </svg>
    </ViewportPortal>
  );
}

function FlowEdgeLabel({
  unitId,
  label,
}: {
  unitId: string | undefined;
  label: { text: string; x: number; y: number };
}) {
  const motion = useMotionPhase(unitId);

  return (
    <text
      className="lens-flow-edge-label"
      x={label.x}
      y={label.y}
      data-motion={motion}
    >
      {label.text}
    </text>
  );
}

interface Layout {
  width: number;
  height: number;
  nodes: Map<string, { x: number; y: number }>;
  edges: {
    index: number;
    section: number;
    points: { x: number; y: number }[];
    label?: { text: string; x: number; y: number };
  }[];
}

const SIZE = { width: 210, height: 62 };

// The label's 9px mono font, so ELK leaves room for it between layers.
const LABEL = { charWidth: 5.4, height: 12, maxLength: 28 };

const labelText = (label: string) =>
  label.length > LABEL.maxLength
    ? `${label.slice(0, LABEL.maxLength - 1)}…`
    : label;

async function layoutFlow(
  block: FlowDiagramBlock,
  direction: "down" | "right" | undefined,
): Promise<Layout> {
  const result = await new ELK().layout<ElkNode>({
    id: "flow",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "right" ? "RIGHT" : "DOWN",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "44",
    },
    children: block.nodes.map((node) => ({ id: node.key, ...SIZE })),
    edges: block.edges.map((edge, index) => {
      const text = edge.label && labelText(edge.label);

      return {
        id: String(index),
        sources: [edge.from],
        targets: [edge.to],
        labels: text
          ? [
              {
                text,
                width: text.length * LABEL.charWidth,
                height: LABEL.height,
                // Beside the source, so the label widens its own gap
                // instead of getting a layer of its own.
                layoutOptions: { "elk.edgeLabels.placement": "TAIL" },
              },
            ]
          : [],
      };
    }),
  });

  return {
    width: result.width ?? 240,
    height: result.height ?? 100,
    nodes: new Map(
      result.children?.map((node) => [
        node.id,
        { x: node.x ?? 0, y: node.y ?? 0 },
      ]),
    ),
    edges: (result.edges ?? []).flatMap((edge) =>
      (edge.sections ?? []).map((section, index) => {
        const label = index ? undefined : edge.labels?.[0];

        return {
          index: Number(edge.id),
          section: index,
          points: [
            section.startPoint,
            ...(section.bendPoints ?? []),
            section.endPoint,
          ],
          label: label && {
            text: label.text ?? "",
            x: label.x ?? 0,
            y: (label.y ?? 0) + LABEL.height - 3,
          },
        };
      }),
    ),
  };
}

interface FlowNodeData extends Record<string, unknown> {
  node: FlowDiagramNode;
  requireReady: boolean;
  selected: boolean;
  select(): void;
}

type FlowNodeType = Node<FlowNodeData, "flowNode">;

interface FlowEdgeData extends Record<string, unknown> {
  unitId: string | undefined;
  label: { text: string; x: number; y: number } | undefined;
  dashed: boolean;
  points: { x: number; y: number }[];
}

type FlowEdgeType = Edge<FlowEdgeData, "flowEdge">;

const change = (progress: CoverageProgress) =>
  progress.total.additions && progress.total.deletions
    ? "modified"
    : progress.total.additions
      ? "added"
      : progress.total.deletions
        ? "removed"
        : "unchanged";

function FlowNode({ data }: NodeProps<FlowNodeType>) {
  const { node, requireReady, selected } = data;
  const lenses = useReviewLenses();
  const motion = useMotionPhase(node.id);

  const sources = node.attachments.flatMap((attachment) => attachment.sources);

  const availability = requireReady ? lenses?.availability(sources) : "ready";
  const unavailable = availability !== "ready";

  const progress =
    lenses?.stats(lenses.resolve(sources)) ?? coverageProgress([]);

  // The flow's onNodeClick handles the mouse; the keyboard lands here.
  const select = () => {
    if (!unavailable) data.select();
  };

  return (
    <div
      className={[
        "flow-node",
        "lens-flow-node",
        `lens-flow-node--${change(progress)}`,
        `lens-flow-node--${node.kind ?? "process"}`,
        selected ? "is-selected" : "",
        progress.state === "viewed" ? "is-viewed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width: SIZE.width, height: SIZE.height }}
      role="button"
      tabIndex={unavailable ? -1 : 0}
      aria-disabled={unavailable}
      aria-pressed={selected}
      aria-label={node.label}
      data-review-unit-id={node.id}
      data-motion={motion}
      title={
        unavailable
          ? availability === "pending"
            ? "Waiting for diff…"
            : "Source unavailable at these pins"
          : `${node.label} · Total +${progress.total.additions} −${progress.total.deletions}`
      }
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="flow-node-handle"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="flow-node-handle"
      />
      <svg
        className="flow-node-shape"
        viewBox={`0 0 ${SIZE.width} ${SIZE.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect
          pathLength={1}
          x={0.5}
          y={0.5}
          width={SIZE.width - 1}
          height={SIZE.height - 1}
          rx={node.kind === "terminal" ? SIZE.height / 2 : 6}
        />
      </svg>
      <div className="flow-node-text">
        <span className="flow-node-label">{node.label}</span>
        <span className="flow-node-caption lens-flow-caption">
          {unavailable ? (
            availability === "pending" ? (
              "…"
            ) : (
              "Unavailable"
            )
          ) : sources.length ? (
            <ElementCountsText progress={progress} />
          ) : (
            "Concept"
          )}
        </span>
      </div>
    </div>
  );
}

function FlowEdge({ id, data, markerEnd }: EdgeProps<FlowEdgeType>) {
  const motion = useMotionPhase(data?.unitId);

  if (!data) return null;

  const path = data.points
    .map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`)
    .join(" ");

  // The label draws in FlowEdgeLabels, above every edge.
  return (
    <BaseEdge
      id={id}
      path={path}
      className="lens-flow-edge"
      // The arrowhead is the last stroke.
      markerEnd={
        motion === "outline" || motion === "stroke" ? undefined : markerEnd
      }
      strokeDasharray={data.dashed ? "6 4" : undefined}
      pathLength={1}
      interactionWidth={0}
      data-review-unit-id={data.unitId}
      data-motion={motion}
    />
  );
}

const nodeTypes = { flowNode: FlowNode };

const edgeTypes = { flowEdge: FlowEdge };
