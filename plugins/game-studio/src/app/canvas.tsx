import { Icon } from "./icons.tsx";
// Canvas model and layout adapted from OhMyGame; modified for BB. Apache-2.0.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import type { Node, NodeProps, Connection, Viewport, Edge, ReactFlowInstance } from "@xyflow/react";
import { Markdown, experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import type {
  Board,
  CanvasNode,
  NodeKind,
  StudioDocument,
  Asset,
  GenerationRecipe,
} from "../shared/schema.ts";
import { GenerationOptions } from "./generation.tsx";
import "@xyflow/react/dist/style.css";
import "./canvas.css";

type CardData = {
  source: CanvasNode;
  documents: StudioDocument[];
  assets: Asset[];
  baseUrl?: string;
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
  const asset = data.assets.find((item) => item.id === node.data.assetId);
  const document = data.documents.find((item) => item.id === node.data.documentId);
  const url =
    asset && data.baseUrl
      ? `${data.baseUrl.replace(/\/$/, "")}/${asset.path.split("/").map(encodeURIComponent).join("/")}`
      : undefined;
  return (
    <div className="gs-canvas-card" data-selected={selected || undefined}>
      <Handle type="target" position={Position.Left} />
      <header>
        <Icon name={kindInfo(node.type).icon} />
        <strong>{node.title || kindInfo(node.type).label}</strong>
        {asset && (
          <span className="gs-node-badge">
            {asset.path.startsWith("Assets/") ? "In Assets" : "Staged"}
          </span>
        )}
      </header>
      <div
        className="gs-node-content"
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
export function StudioCanvas({
  board,
  revision,
  documents,
  assets,
  previewBaseUrl,
  onSave,
  onGenerate,
  onOpenDocument,
  onUpload,
  onStatus,
}: {
  board: Board;
  revision: string;
  documents: StudioDocument[];
  assets: Asset[];
  previewBaseUrl?: string;
  onSave: (board: Board, expectedRevision: string) => Promise<{ revision: string }>;
  onGenerate: (nodeId: string, recipe: GenerationRecipe) => void;
  onOpenDocument: (id: string) => void;
  onUpload: () => void;
  onStatus?: (status: "saved" | "saving" | "dirty" | "error") => void;
}) {
  const { mode: colorMode } = useCodeTheme();
  const cards = (source: Board): Card[] =>
    source.nodes.map((node) => ({
      id: node.id,
      type: "studio",
      position: source.editorLayout.nodes[node.id] ?? node.position,
      data: { source: node, documents, assets, baseUrl: previewBaseUrl },
    }));
  const [nodes, setNodes, onNodesChange] = useNodesState<Card>(cards(board));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(board.edges);
  const [selectedId, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const baseline = useRef(revision);
  const editVersion = useRef(0);
  const viewport = useRef<Viewport>(board.editorLayout.viewport);
  const selected = nodes.find((node) => node.id === selectedId);
  const stage = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<Card>>(null);
  const focusNode = useRef<string | null>(selected?.id ?? null);
  const firstFit = useRef(false);
  const frame = useRef(0);
  useEffect(() => {
    focusNode.current = selected?.id ?? null;
  }, [selected?.id]);
  const recoverViewport = useCallback((force = false) => {
    const instance = flow.current;
    const bounds = stage.current?.getBoundingClientRect();
    if (!instance || !bounds?.width || !bounds.height || !instance.getNodes().length) return;
    const view = instance.getViewport();
    const visible = instance.getIntersectingNodes(
      {
        x: -view.x / view.zoom,
        y: -view.y / view.zoom,
        width: bounds.width / view.zoom,
        height: bounds.height / view.zoom,
      },
      true,
    );
    if (force || !firstFit.current || visible.length === 0) {
      void instance
        .fitView({
          ...(focusNode.current ? { nodes: [{ id: focusNode.current }] } : {}),
          maxZoom: 1,
          minZoom: 0.15,
          padding: 0.15,
        })
        .then((fitted) => {
          if (fitted) firstFit.current = true;
          return fitted;
        });
    }
  }, []);
  const scheduleFit = useCallback(
    (force = false) => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => recoverViewport(force));
    },
    [recoverViewport],
  );
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => scheduleFit(Boolean(focusNode.current)));
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [scheduleFit]);
  useEffect(() => {
    scheduleFit(Boolean(selected?.id));
  }, [selected?.id, scheduleFit]);
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
  const add = (kind: NodeKind) => {
    const id = crypto.randomUUID();
    const position = {
      x: 80 + (nodes.length % 3) * 340,
      y: 100 + Math.floor(nodes.length / 3) * 260,
    };
    const source: CanvasNode = {
      id,
      type: kind,
      position,
      title: kindInfo(kind).label,
      data: initialData(kind, documents),
    };
    setNodes((current) => [
      ...current,
      {
        id,
        type: "studio",
        position,
        data: { source, documents, assets, baseUrl: previewBaseUrl },
      },
    ]);
    setSelected(id);
    change();
  };
  const connect = (connection: Connection) => {
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
    if (saving) return;
    setSaving(true);
    setError("");
    onStatus?.("saving");
    const savedVersion = editVersion.current;
    const ids = new Set(nodes.map((node) => node.id));
    const nextNodes = nodes.map((node) => {
      const data = { ...node.data.source.data };
      for (const key of ["images", "references"])
        if (Array.isArray(data[key]))
          data[key] = data[key].filter(
            (ref) =>
              typeof ref !== "object" ||
              ref === null ||
              Array.isArray(ref) ||
              ref.type !== "node" ||
              ids.has(String(ref.nodeId)),
          );
      return Object.assign({}, node.data.source, { position: node.position, data });
    });
    const next: Board = {
      ...board,
      nodes: nextNodes,
      edges: edges
        .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        .map(({ id, source, target, sourceHandle }) => ({
          id,
          source,
          target,
          sourceHandle: sourceHandle || undefined,
        })),
      editorLayout: {
        ...board.editorLayout,
        fitView: false,
        viewport: viewport.current,
        nodes: Object.fromEntries(
          nodes.map((node) => [
            node.id,
            { ...board.editorLayout.nodes[node.id], ...node.position },
          ]),
        ),
      },
    };
    try {
      const result = await onSave(next, baseline.current);
      baseline.current = result.revision;
      const clean = editVersion.current === savedVersion;
      setDirty(!clean);
      onStatus?.(clean ? "saved" : "dirty");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      onStatus?.("error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="gs-canvas-root" data-inspecting={selected ? true : undefined}>
      <div className="gs-canvas-stage" ref={stage}>
        {revision !== baseline.current && (
          <div className="gs-canvas-notice">
            Board changed on disk. Local draft kept.
            <button
              onClick={() => {
                setNodes(cards(board));
                setEdges(board.edges);
                baseline.current = revision;
                setDirty(false);
                setError("");
                onStatus?.("saved");
                scheduleFit(true);
              }}
            >
              Reload disk version
            </button>
          </div>
        )}
        {error && (
          <div className="gs-canvas-notice gs-notice" role="alert">
            Could not save. Draft kept. {error}
          </div>
        )}
        <ReactFlow<Card>
          onInit={(instance) => {
            flow.current = instance;
            scheduleFit(true);
          }}
          colorMode={colorMode}
          nodeTypes={nodeTypes}
          nodes={nodes.map((node) => ({
            ...node,
            data: { ...node.data, assets, documents, baseUrl: previewBaseUrl },
          }))}
          edges={edges}
          defaultViewport={board.editorLayout.viewport}
          fitView={board.nodes.length > 0}
          fitViewOptions={{ maxZoom: 1 }}
          onNodesChange={(changes) => {
            onNodesChange(changes);
            if (changes.some((item) => item.type === "dimensions"))
              scheduleFit(Boolean(focusNode.current));
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
          onNodeClick={(_, node) => setSelected(node.id)}
          onPaneClick={() => setSelected(null)}
          onMoveEnd={(event, view) => {
            const before = viewport.current;
            viewport.current = view;
            if (event && (before.x !== view.x || before.y !== view.y || before.zoom !== view.zoom))
              change();
          }}
          minZoom={0.15}
          maxZoom={2.5}
          deleteKeyCode={["Backspace", "Delete"]}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls
            showInteractive={false}
            position="bottom-right"
            fitViewOptions={{ maxZoom: 1 }}
          />
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
        {dirty && (
          <div className="gs-canvas-save">
            <span>Unsaved changes ·</span>
            <button
              className="gs-primary"
              aria-label="Save board"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
      {selected && (
        <aside className="gs-node-inspector">
          <header>
            <strong>{kindInfo(selected.data.source.type).label}</strong>
            <button
              className="gs-icon"
              aria-label="Close node inspector"
              onClick={() => setSelected(null)}
            >
              <Icon name="X" />
            </button>
          </header>
          <label>
            Title
            <input
              value={selected.data.source.title ?? ""}
              onChange={(e) => updateSelected({ title: e.target.value })}
            />
          </label>
          {selected.data.source.type === "text" ? (
            <label>
              Note
              <textarea
                value={String(selected.data.source.data.text ?? "")}
                onChange={(e) => updateData("text", e.target.value)}
              />
            </label>
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
          {!["text", "document", "table"].includes(selected.data.source.type) && (
            <>
              <GenerationOptions
                key={selected.id}
                kind={selected.data.source.type}
                hasImageReference={hasImageReference}
                disabled={dirty || saving}
                onSend={(recipe) => onGenerate(selected.id, recipe)}
              />
              {dirty && (
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
              setNodes((current) => current.filter((node) => node.id !== selectedId));
              setEdges((current) =>
                current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId),
              );
              setSelected(null);
              change();
            }}
          >
            Remove node
          </button>
        </aside>
      )}
    </div>
  );
}
