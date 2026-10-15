import {
  useBbNavigate,
  Markdown,
  experimental_useCodeTheme as useCodeTheme,
} from "@get-bb/plugin-sdk/app";
import type { GenerationJob } from "../shared/generation.ts";
import { Icon } from "./icons.tsx";
// Canvas model and layout adapted from OhMyGame; modified for BB. Apache-2.0.
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import type {
  Node,
  NodeProps,
  Connection,
  Viewport,
  Edge,
  ReactFlowInstance,
  OnSelectionChangeParams,
} from "@xyflow/react";
import type {
  Board,
  CanvasNode,
  NodeKind,
  StudioDocument,
  Asset,
  GenerationRecipe,
} from "../shared/schema.ts";
import { CanvasInputs } from "./canvas-inputs.tsx";
import { GenerationOptions } from "./generation.tsx";
import { arrangeNodes, newNodePosition, revealNode } from "./canvas-layout.ts";
import { boardSnapshot } from "./canvas-board.ts";
import "@xyflow/react/dist/style.css";
import "./canvas.css";

type CardData = {
  source: CanvasNode;
  documents: StudioDocument[];
  assets: Asset[];
  baseUrl?: string;
  job?: GenerationJob;
};
type Card = Node<CardData, "studio">;
const kinds: { kind: NodeKind; label: string; icon: string }[] = [
  { kind: "text", label: "Text", icon: "Type" },
  { kind: "document", label: "Document", icon: "FileText" },
  { kind: "image", label: "Image", icon: "Image" },
  { kind: "model-3d", label: "3D", icon: "Box" },
  { kind: "video", label: "Video", icon: "Video" },
  { kind: "asset", label: "Audio", icon: "Music" },
  { kind: "table", label: "Table", icon: "Table" },
];
const kindInfo = (kind: NodeKind) =>
  kinds.find((item) => item.kind === kind) ?? { label: kind, icon: "Box" };
function CanvasCard({ data, selected }: NodeProps<Card>) {
  const node = data.source;
  const navigate = useBbNavigate();
  const pending = data.job && ["queued", "running"].includes(data.job.status);
  const asset = data.assets.find((item) => item.id === node.data.assetId);
  const document = data.documents.find((item) => item.id === node.data.documentId);
  const url =
    asset && data.baseUrl
      ? `${data.baseUrl.replace(/\/$/, "")}/${asset.path.split("/").map(encodeURIComponent).join("/")}`
      : undefined;
  return (
    <div
      className="gs-canvas-card"
      data-selected={selected || undefined}
      data-generation={pending ? "pending" : data.job?.status}
    >
      <Handle type="target" position={Position.Left} />
      <header title="Drag to move">
        <Icon name={kindInfo(node.type).icon} />
        <strong>{node.title || kindInfo(node.type).label}</strong>
        {asset && (
          <span className="gs-node-badge">
            {asset.path.startsWith("Assets/") ? "In Assets" : "Staged"}
          </span>
        )}
      </header>
      <div
        className="gs-node-content nodrag nopan nowheel"
        data-empty-image={(node.type === "image" && !asset) || undefined}
      >
        {asset?.type === "image" && url ? (
          <img src={url} alt={asset.name} />
        ) : asset?.type === "video" && url ? (
          <video src={url} muted preload="metadata" />
        ) : document ? (
          <Markdown content={document.markdown.slice(0, 800) || "Empty document"} />
        ) : node.type === "text" ? (
          <Markdown content={String(node.data.text || "Add a design note…")} />
        ) : node.type === "image" && !asset ? (
          <>
            <Icon name="Image" />
            <span>No output yet</span>
          </>
        ) : (
          <>
            <Icon name={kindInfo(node.type).icon} />
            <p>
              {asset?.name ||
                String(node.data.prompt || node.description || "Select to edit this node")}
            </p>
          </>
        )}
      </div>
      {data.job && (
        <div className="gs-generation-progress nodrag nopan">
          <span>
            {pending
              ? "Generating…"
              : data.job.status === "auth-required"
                ? "Sign in required"
                : data.job.status === "succeeded"
                  ? "Ready for review"
                  : data.job.status}
          </span>
          {data.job.origin.kind === "agent" && data.job.threadId && (
            <button type="button" onClick={() => navigate.toThread(data.job!.threadId!)}>
              View in thread ↗
            </button>
          )}
          {data.job.detail && <small>{data.job.detail}</small>}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { studio: CanvasCard };
const initialData = (kind: NodeKind, documents: StudioDocument[]): CanvasNode["data"] => {
  switch (kind) {
    case "text":
      return { text: "", instruction: "", references: [] };
    case "document":
      return { documentId: documents[0]?.id ?? "", references: [] };
    case "image":
      return { prompt: "", images: [], resolution: "1K", aspectRatio: "1:1" };
    case "video":
      return { prompt: "", references: [], duration: 5, resolution: "720p", aspectRatio: "16:9" };
    case "model-3d":
      return { prompt: "", images: [], targetPolycount: 20000, texture: false, pbr: false };
    case "animate-3d":
      return { heightMeters: 1.8, actionIds: [] };
    case "asset":
      return { assetId: "", mediaType: "audio" };
    case "table":
      return { tableId: "" };
  }
};
const noGenerationJobs: GenerationJob[] = [];
export function StudioCanvas({
  gameId,
  active = true,
  board,
  revision,
  documents,
  assets,
  generationJobs = noGenerationJobs,
  previewBaseUrl,
  onSave,
  onGenerate,
  onGenerateDirect,
  onGenerationControl,
  onOpenDocument,
  onUpload,
  onStatus,
}: {
  gameId: string;
  active?: boolean;
  board: Board;
  revision: string;
  documents: StudioDocument[];
  assets: Asset[];
  generationJobs?: GenerationJob[];
  previewBaseUrl?: string;
  onSave: (board: Board, expectedRevision: string) => Promise<{ revision: string }>;
  onGenerate: (nodeId: string, recipe: GenerationRecipe) => void;
  onGenerateDirect: (
    nodeId: string,
    revision: string,
    requestId: string,
    model: { provider: string; id?: string },
  ) => Promise<void>;
  onGenerationControl: (
    jobId: string,
    action: "status" | "resume" | "cancel",
  ) => Promise<{ missing: boolean }>;
  onOpenDocument: (id: string) => void;
  onUpload: () => void;
  onStatus?: (status: "saved" | "saving" | "dirty" | "error") => void;
}) {
  const { mode: colorMode } = useCodeTheme();
  const cards = useCallback(
    (source: Board): Card[] =>
      source.nodes.map((node) => ({
        id: node.id,
        type: "studio",
        dragHandle: ".gs-canvas-card > header",
        position: source.editorLayout.nodes[node.id] ?? node.position,
        data: { source: node, documents, assets, baseUrl: previewBaseUrl },
      })),
    [documents, assets, previewBaseUrl],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Card>(cards(board));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(board.edges);
  const [selectedId, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const startingRef = useRef(false);
  const requestKey = `game-studio:canvas-requests:${gameId}:${board.id}`;
  const [requestIds] = useState(() => {
    try {
      const entries: unknown = JSON.parse(sessionStorage.getItem(requestKey) ?? "[]");
      if (Array.isArray(entries))
        return new Map<string, string>(
          entries.filter(
            (entry) =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              entry.every((value) => typeof value === "string"),
          ),
        );
    } catch {
      /* Private browser sessions can disable storage. */
    }
    return new Map<string, string>();
  });
  const rememberRequest = (nodeId: string, requestId?: string) => {
    if (requestId) requestIds.set(nodeId, requestId);
    else requestIds.delete(nodeId);
    try {
      sessionStorage.setItem(requestKey, JSON.stringify([...requestIds]));
    } catch {
      /* The current tab still retains its in-memory request identity. */
    }
  };
  const [error, setError] = useState("");
  const baseline = useRef(revision);
  const editVersion = useRef(0);
  const viewport = useRef<Viewport>(board.editorLayout.viewport);
  const selected = nodes.find((node) => node.id === selectedId);
  const selectedJob = generationJobs.find(
    (job) => job.target?.boardId === board.id && job.target.nodeId === selectedId,
  );
  const generating =
    starting === selectedId ||
    (!!selectedJob && ["queued", "running"].includes(selectedJob.status));
  const root = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<Card>>(null);
  const focusNode = useRef<string | null>(selected?.id ?? null);
  const needsInitialFit = useRef(board.editorLayout.fitView !== false);
  const frame = useRef(0);
  useEffect(() => {
    focusNode.current = selected?.id ?? null;
  }, [selected?.id]);
  const recoverViewport = useCallback(() => {
    const instance = flow.current;
    const bounds = stage.current?.getBoundingClientRect();
    if (!instance || !bounds?.width || !bounds.height || !instance.getNodes().length) return;
    const view = instance.getViewport();
    if (needsInitialFit.current) {
      needsInitialFit.current = false;
      void instance
        .fitView({
          maxZoom: 1,
          minZoom: 0.15,
          padding: 0.15,
        })
        .then((fitted) => {
          if (!fitted) needsInitialFit.current = true;
          return fitted;
        });
      return;
    }
    const node = focusNode.current ? instance.getNode(focusNode.current) : undefined;
    if (!node?.measured?.width || !node.measured.height || node.dragging) return;
    const next = revealNode(view, bounds, instance.getNodesBounds([node]));
    if (next.x !== view.x || next.y !== view.y) void instance.setViewport(next);
  }, []);
  const scheduleFit = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(recoverViewport);
  }, [recoverViewport]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [scheduleFit]);
  useEffect(() => {
    scheduleFit();
  }, [selected?.id, scheduleFit]);
  const selectionChanged = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams<Card>) => {
      setSelected(selectedNodes.length === 1 ? selectedNodes[0]!.id : null);
    },
    [],
  );
  const clearSelection = () => {
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    setSelected(null);
  };
  const arrange = () => {
    setNodes(arrangeNodes(nodes, edges));
    clearSelection();
    focusNode.current = null;
    needsInitialFit.current = true;
    scheduleFit();
    change();
  };
  const hasImageReference = selected
    ? [selected.data.source.data.images, selected.data.source.data.references]
        .flatMap((refs) => (Array.isArray(refs) ? refs : []))
        .some((ref) => {
          if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return false;
          const assetId =
            ref.type === "library"
              ? ref.assetId
              : ref.type === "node"
                ? nodes.find((node) => node.id === ref.nodeId)?.data.source.data.assetId
                : undefined;
          return assets.some((asset) => asset.id === assetId && asset.type === "image");
        })
    : false;
  const change = useCallback(() => {
    editVersion.current += 1;
    setDirty(true);
    onStatus?.("dirty");
  }, [onStatus]);
  const updateSelected = (update: Partial<CanvasNode>) => {
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedId
          ? { ...node, data: { ...node.data, source: { ...node.data.source, ...update } } }
          : node,
      ),
    );
    change();
  };
  const updateData = (key: string, value: string) => {
    if (selected) updateSelected({ data: { ...selected.data.source.data, [key]: value } });
  };
  const toggleInput = (sourceId: string, enabled: boolean) => {
    if (!selected) return;
    if (enabled) {
      connect({ source: sourceId, target: selected.id, sourceHandle: null, targetHandle: null });
      return;
    }
    setEdges((current) =>
      current.filter((edge) => !(edge.source === sourceId && edge.target === selected.id)),
    );
    const data = { ...selected.data.source.data };
    for (const key of ["images", "references"])
      if (Array.isArray(data[key]))
        data[key] = data[key].filter(
          (ref) =>
            !(
              typeof ref === "object" &&
              ref !== null &&
              !Array.isArray(ref) &&
              ref.type === "node" &&
              ref.nodeId === sourceId
            ),
        );
    const source = data.promptSource;
    if (
      typeof source === "object" &&
      source !== null &&
      !Array.isArray(source) &&
      source.nodeId === sourceId
    )
      delete data.promptSource;
    updateSelected({ data });
  };
  const add = (kind: NodeKind) => {
    const instance = flow.current;
    const bounds = stage.current?.getBoundingClientRect();
    if (!instance || !bounds?.width || !bounds.height) return;
    const id = crypto.randomUUID();
    const position = newNodePosition(
      instance.screenToFlowPosition({
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      }),
      nodes,
    );
    const source: CanvasNode = {
      id,
      type: kind,
      position,
      title: kindInfo(kind).label,
      data: initialData(kind, documents),
    };
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      {
        id,
        type: "studio",
        dragHandle: ".gs-canvas-card > header",
        selected: true,
        position,
        data: { source, documents, assets, baseUrl: previewBaseUrl },
      },
    ]);
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    setSelected(id);
    change();
  };
  const connect = (connection: Connection) => {
    if (connection.source === connection.target) return;
    if (
      edges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          (edge.sourceHandle || null) === (connection.sourceHandle || null) &&
          (edge.targetHandle || null) === (connection.targetHandle || null),
      )
    )
      return;
    const edgeId = crypto.randomUUID();
    setEdges((current) => addEdge({ ...connection, id: edgeId }, current));
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== connection.target) return node;
        const source = node.data.source;
        const key = ["image", "model-3d"].includes(source.type) ? "images" : "references";
        const refs = Array.isArray(source.data[key]) ? source.data[key] : [];
        if (
          [source.data.images, source.data.references]
            .flatMap((value) => (Array.isArray(value) ? value : []))
            .some(
              (ref) =>
                typeof ref === "object" &&
                ref !== null &&
                !Array.isArray(ref) &&
                ref.type === "node" &&
                ref.nodeId === connection.source,
            )
        )
          return node;
        return {
          ...node,
          data: {
            ...node.data,
            source: {
              ...source,
              data: {
                ...source.data,
                [key]: [...refs, { type: "node", nodeId: connection.source, studioEdgeId: edgeId }],
              },
            },
          },
        };
      }),
    );
    change();
  };
  const save = async () => {
    if (saving) return undefined;
    setSaving(true);
    setError("");
    onStatus?.("saving");
    const savedVersion = editVersion.current;
    const next = boardSnapshot(
      board,
      nodes.map((node) => ({ ...node.data.source, position: node.position })),
      edges,
      viewport.current,
    );
    try {
      const result = await onSave(next, baseline.current);
      baseline.current = result.revision;
      const clean = editVersion.current === savedVersion;
      setDirty(!clean);
      onStatus?.(clean ? "saved" : "dirty");
      return clean ? result.revision : undefined;
    } catch (cause) {
      setError(
        `Could not save. Draft kept. ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      onStatus?.("error");
      return undefined;
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    if (revision === baseline.current || dirty || saving) return;
    setNodes((current) =>
      cards(board).map((node) => ({
        ...node,
        selected: current.some((old) => old.id === node.id && old.selected),
      })),
    );
    setEdges(board.edges);
    baseline.current = revision;
  }, [board, cards, revision, dirty, saving, setNodes, setEdges]);
  const generate = async (model: { provider: string; id?: string }) => {
    if (!selected || startingRef.current || generating) return;
    const id = selected.id;
    startingRef.current = true;
    setStarting(id);
    setError("");
    try {
      const saved = dirty ? await save() : baseline.current;
      if (!saved) throw new Error("Save the current edits before generating.");
      const requestId = requestIds.get(id) ?? crypto.randomUUID();
      rememberRequest(id, requestId);
      await onGenerateDirect(id, saved, requestId, model);
      rememberRequest(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      startingRef.current = false;
      setStarting(null);
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      if (dirty) void save();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
      root.current?.focus();
      return;
    }
    const target = event.target as HTMLElement;
    if (
      target.closest("input, textarea, select, [contenteditable]") ||
      window.getSelection()?.isCollapsed === false
    )
      return;
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      const instance = flow.current;
      if (instance)
        void instance.deleteElements({
          nodes: instance.getNodes().filter((node) => node.selected),
          edges: instance.getEdges().filter((edge) => edge.selected),
        });
    }
  };
  // This graphics application owns scoped save, delete, and selection shortcuts.
  /* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      className="gs-canvas-root"
      ref={root}
      role="application"
      aria-label="Game canvas"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      data-inspecting={selected ? true : undefined}
    >
      {/* oxlint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div className="gs-canvas-stage" ref={stage}>
        {revision !== baseline.current && (
          <div className="gs-canvas-notice">
            Board changed on disk. Local draft kept.
            <button
              onClick={() => {
                setNodes(cards(board));
                setEdges(board.edges);
                setSelected(null);
                baseline.current = revision;
                setDirty(false);
                setError("");
                onStatus?.("saved");
                viewport.current = board.editorLayout.viewport;
                needsInitialFit.current = board.editorLayout.fitView !== false;
                void flow.current?.setViewport(board.editorLayout.viewport);
                scheduleFit();
              }}
            >
              Reload disk version
            </button>
          </div>
        )}
        {error && (
          <div className="gs-canvas-notice gs-notice" role="alert">
            {error}
          </div>
        )}
        <ReactFlow<Card>
          onInit={(instance) => {
            flow.current = instance;
            scheduleFit();
          }}
          colorMode={colorMode}
          nodeTypes={nodeTypes}
          nodes={nodes.map((node) => ({
            ...node,
            data: {
              ...node.data,
              assets,
              documents,
              baseUrl: previewBaseUrl,
              job: generationJobs.find(
                (job) => job.target?.boardId === board.id && job.target.nodeId === node.id,
              ),
            },
          }))}
          edges={edges}
          defaultViewport={board.editorLayout.viewport}
          onNodesChange={(changes) => {
            onNodesChange(changes);
            if (
              changes.some(
                (item) =>
                  item.type === "dimensions" &&
                  (needsInitialFit.current || item.id === focusNode.current),
              )
            )
              scheduleFit();
            if (changes.some((item) => item.type !== "select" && item.type !== "dimensions"))
              change();
          }}
          onEdgesChange={(changes) => {
            const removedIds = new Set(
              changes.filter((item) => item.type === "remove").map((item) => item.id),
            );
            if (removedIds.size > 0) {
              const removed = new Map(
                edges.filter((edge) => removedIds.has(edge.id)).map((edge) => [edge.id, edge]),
              );
              const remaining = edges.filter((edge) => !removedIds.has(edge.id));
              setNodes((current) =>
                current.map((node) => {
                  const data = { ...node.data.source.data };
                  for (const key of ["images", "references"])
                    if (Array.isArray(data[key]))
                      data[key] = data[key].flatMap((ref) => {
                        if (
                          typeof ref !== "object" ||
                          ref === null ||
                          Array.isArray(ref) ||
                          ref.type !== "node" ||
                          typeof ref.studioEdgeId !== "string"
                        )
                          return [ref];
                        const edge = removed.get(ref.studioEdgeId);
                        if (!edge || edge.target !== node.id || edge.source !== ref.nodeId)
                          return [ref];
                        const replacement = remaining.find(
                          (other) => other.source === edge.source && other.target === edge.target,
                        );
                        return replacement ? [{ ...ref, studioEdgeId: replacement.id }] : [];
                      });
                  return { ...node, data: { ...node.data, source: { ...node.data.source, data } } };
                }),
              );
            }
            onEdgesChange(changes);
            if (changes.some((item) => item.type !== "select")) change();
          }}
          onConnect={connect}
          onSelectionChange={selectionChanged}
          onNodeDoubleClick={() => inspector.current?.querySelector("input")?.focus()}
          onPaneClick={() => {
            clearSelection();
            root.current?.focus();
          }}
          onMoveEnd={(event, view) => {
            const before = viewport.current;
            viewport.current = view;
            if (event && (before.x !== view.x || before.y !== view.y || before.zoom !== view.zoom))
              change();
          }}
          minZoom={0.15}
          maxZoom={2.5}
          deleteKeyCode={null}
          panOnScroll
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} position="bottom-right" fitViewOptions={{ maxZoom: 1 }}>
            <ControlButton
              title="Arrange nodes"
              aria-label="Arrange nodes"
              disabled={nodes.length < 2}
              onClick={arrange}
            >
              <Icon name="Workflow" />
            </ControlButton>
          </Controls>
        </ReactFlow>
        {!nodes.length && (
          <div className="gs-canvas-empty">
            <h2>Start with a design note</h2>
            <p>Connect ideas, reference art, and Unity assets.</p>
            <button onClick={() => add("text")}>Add a text node</button>
          </div>
        )}
        <div className="gs-canvas-dock" role="toolbar" aria-label="Add canvas nodes">
          {kinds.map((item) => (
            <button
              key={item.kind}
              title={`Add ${item.label}`}
              aria-label={`Add ${item.label} node`}
              onClick={() => add(item.kind)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
          <button title="Upload to staging" aria-label="Upload to staging" onClick={onUpload}>
            <Icon name="Upload" />
            <span>Upload</span>
          </button>
        </div>
        <p className="gs-canvas-help">Scroll to pan · Pinch to zoom</p>
        {dirty && (
          <div className="gs-canvas-save">
            <span>Unsaved changes ·</span>
            <button
              className="gs-primary"
              aria-label="Save board"
              title="Save board (Ctrl/⌘+S)"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
      {selected && (
        <aside className="gs-node-inspector" ref={inspector}>
          <header>
            <strong>{kindInfo(selected.data.source.type).label}</strong>
            <button className="gs-icon" aria-label="Close node inspector" onClick={clearSelection}>
              <Icon name="X" />
            </button>
          </header>
          <label>
            Title
            <input
              maxLength={200}
              value={selected.data.source.title ?? ""}
              onChange={(e) => updateSelected({ title: e.target.value })}
            />
          </label>
          {selected.data.source.type === "text" ? (
            <>
              <label>
                Note
                <textarea
                  value={String(selected.data.source.data.text ?? "")}
                  onChange={(e) => updateData("text", e.target.value)}
                />
              </label>
              <label>
                Generation instruction
                <textarea
                  value={String(selected.data.source.data.instruction ?? "")}
                  placeholder="Describe the text to write…"
                  onChange={(e) => updateData("instruction", e.target.value)}
                />
              </label>
              <small className="gs-muted">Uses the provider and model selected in BB.</small>
            </>
          ) : selected.data.source.type === "document" ? (
            <>
              <label>
                Document
                <select
                  value={String(selected.data.source.data.documentId ?? "")}
                  onChange={(e) => updateData("documentId", e.target.value)}
                >
                  <option value="">Choose a document</option>
                  {documents.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!selected.data.source.data.documentId}
                onClick={() => onOpenDocument(String(selected.data.source.data.documentId))}
              >
                Open document
              </button>
            </>
          ) : (
            <label>
              Asset brief
              <textarea
                value={String(selected.data.source.data.prompt ?? "")}
                onChange={(e) => updateData("prompt", e.target.value)}
                placeholder="Describe the asset and its Unity consumer…"
              />
            </label>
          )}
          {["text", "image"].includes(selected.data.source.type) && (
            <>
              <CanvasInputs
                node={selected.data.source}
                nodes={nodes.map((node) => node.data.source)}
                assets={assets}
                onToggle={toggleInput}
              />
              {selected.data.source.type === "text" && (
                <button
                  className="gs-primary"
                  disabled={
                    generating ||
                    saving ||
                    !String(selected.data.source.data.instruction ?? "").trim()
                  }
                  onClick={() => void generate({ provider: "bb" })}
                >
                  {generating ? "Generating…" : "Generate text"}
                </button>
              )}
              {requestIds.has(selected.id) && !starting && (
                <button
                  onClick={() => {
                    const id = selected.id;
                    const requestId = requestIds.get(id)!;
                    void onGenerationControl(requestId, "status")
                      .then((result) => {
                        if (result.missing) rememberRequest(id);
                        setError(
                          result.missing ? "No submission was made. You can generate again." : "",
                        );
                      })
                      .catch((cause) => setError(String(cause)));
                  }}
                >
                  Check saved request
                </button>
              )}
              {selectedJob?.origin.kind === "canvas" && (
                <div className="gs-inline-job" role="status">
                  <span>
                    {generating
                      ? "Generating…"
                      : selectedJob.status === "succeeded"
                        ? "Generated"
                        : selectedJob.status}
                  </span>
                  {selectedJob.detail && <small>{selectedJob.detail}</small>}
                  {["queued", "running"].includes(selectedJob.status) && (
                    <button
                      onClick={() =>
                        void onGenerationControl(selectedJob.id, "cancel").catch((cause) =>
                          setError(String(cause)),
                        )
                      }
                    >
                      Cancel generation
                    </button>
                  )}
                  {!["queued", "running", "succeeded"].includes(selectedJob.status) &&
                    selectedJob.taskId && (
                      <button
                        onClick={() =>
                          void onGenerationControl(selectedJob.id, "resume").catch((cause) =>
                            setError(String(cause)),
                          )
                        }
                      >
                        {selectedJob.request.kind === "text" ? "Check BB run" : "Resume saved job"}
                      </button>
                    )}
                </div>
              )}
            </>
          )}
          {!["text", "document", "table"].includes(selected.data.source.type) && (
            <>
              <GenerationOptions
                key={selected.id}
                kind={selected.data.source.type}
                hasImageReference={hasImageReference}
                disabled={selected.data.source.type === "image" ? saving : dirty || saving}
                busy={generating}
                onGenerate={
                  selected.data.source.type === "image"
                    ? (recipe) =>
                        void generate(
                          recipe === "concept-art"
                            ? { provider: "midjourney" }
                            : { provider: "google", id: "gemini-nano-banana-2.1" },
                        )
                    : undefined
                }
                onSend={(recipe) => onGenerate(selected.id, recipe)}
              />
              {dirty && selected.data.source.type !== "image" && (
                <small className="gs-muted">Save this board before requesting an asset.</small>
              )}
              <label>
                Existing output
                <select
                  value={String(selected.data.source.data.assetId ?? "")}
                  onChange={(e) => updateData("assetId", e.target.value)}
                >
                  <option value="">No output yet</option>
                  {assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <button
            className="gs-danger"
            onClick={() => {
              void flow.current?.deleteElements({ nodes: [{ id: selected.id }] });
            }}
          >
            Remove node
          </button>
        </aside>
      )}
    </div>
  );
}
