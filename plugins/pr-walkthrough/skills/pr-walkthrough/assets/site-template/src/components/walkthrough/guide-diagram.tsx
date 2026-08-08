"use client"

import { Background, ReactFlow, type Edge, type Node } from "@xyflow/react"
import { useMemo } from "react"

import { REVIEW_SURFACE_CLASS } from "./review-surface"

import "@xyflow/react/dist/style.css"

type DiagramNode = {
  id: string
  label: string
  detail?: string
  x?: number
  y?: number
  position?: { x: number; y: number }
}

type DiagramEdge = {
  id: string
  source: string
  target: string
  label?: string
}

type GuideDiagramProps = {
  diagram: {
    summary: string
    nodes: DiagramNode[]
    edges: DiagramEdge[]
  }
}

export function GuideDiagram({ diagram }: GuideDiagramProps) {
  const nodes = useMemo<Node[]>(() => diagram.nodes.map((node) => ({
    data: {
      label: (
        <span className="block max-w-48 text-left">
          <span className="block text-xs font-medium">{node.label}</span>
          {node.detail ? <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{node.detail}</span> : null}
        </span>
      ),
    },
    id: node.id,
    position: node.position ?? { x: node.x ?? 0, y: node.y ?? 0 },
  })), [diagram.nodes])
  const edges = useMemo<Edge[]>(() => diagram.edges.map((edge) => ({
    id: edge.id,
    label: edge.label,
    source: edge.source,
    target: edge.target,
  })), [diagram.edges])

  return (
    <figure className="space-y-2">
      <div className={`${REVIEW_SURFACE_CLASS} h-72 w-full min-w-0 bg-muted/20 sm:h-80`}>
        <ReactFlow
          aria-label={diagram.summary}
          colorMode="dark"
          edges={edges}
          elementsSelectable={false}
          fitView
          maxZoom={1.35}
          minZoom={0.45}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          panOnDrag
          proOptions={{ hideAttribution: true }}
          zoomOnDoubleClick={false}
          zoomOnScroll={false}
        >
          <Background color="var(--border)" gap={20} size={1} />
        </ReactFlow>
      </div>
      <figcaption className="text-xs leading-5 text-muted-foreground">{diagram.summary}</figcaption>
    </figure>
  )
}
