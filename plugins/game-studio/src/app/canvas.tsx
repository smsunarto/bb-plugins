import {
  useBbNavigate,
  Markdown,
  experimental_useCodeTheme as useCodeTheme,
} from "@get-bb/plugin-sdk/app";
import type { GenerationJob } from "../shared/generation.ts";
import { Icon } from "./icons.tsx";
// Canvas model and layout adapted from OhMyGame; modified for BB. Apache-2.0.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import {
  ReactFlow,
  Background,
  Handle,
  NodeToolbar,
  Panel,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useViewport,
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
import {
  GenerationSettings,
  nodeModelLabel,
  nodeRecipe,
  promptField,
  runsDirectly,
} from "./generation.tsx";
import type { NodePatch } from "./generation.tsx";
import { BriefStarters } from "./brief-starters.tsx";
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
  busy?: boolean;
};
type Card = Node<CardData, "studio">;
type Tool = "select" | "hand";
// Each kind owns its port and edge color. Monokai's ANSI hues keep the canvas themed.
const kinds: { kind: NodeKind; label: string; icon: string; key?: string; color: string }[] = [
  { kind: "text", label: "Text", icon: "Type", key: "t", color: "var(--ansi-6, #51dae9)" },
  { kind: "image", label: "Image", icon: "Image", key: "i", color: "var(--ansi-3, #f1b467)" },
  { kind: "video", label: "Video", icon: "Video", key: "v", color: "var(--ansi-5, #a895fe)" },
  { kind: "asset", label: "Audio", icon: "Music", key: "a", color: "var(--ansi-10, #9ddd54)" },
  { kind: "model-3d", label: "3D", icon: "Box", color: "var(--ansi-9, #fe5d86)" },
  { kind: "document", label: "Document", icon: "FileText", color: "var(--ansi-12, #7cacfe)" },
  { kind: "table", label: "Table", icon: "Table", color: "var(--ansi-11, #f7d05c)" },
];
const kindInfo = (kind: NodeKind | undefined) =>
  kinds.find((item) => item.kind === kind) ?? {
    kind,
    label: kind ?? "Node",
    icon: "Box",
    key: undefined,
    color: "var(--muted-foreground)",
  };
type CardActionsValue = {
  edit: (id: string, patch: NodePatch) => void;
  run: (id: string) => void;
};
const CardActions = createContext<CardActionsValue>({ edit: () => {}, run: () => {} });
function CanvasCard({ id, data, selected }: NodeProps<Card>) {
  const node = data.source;
  const info = kindInfo(node.type);
  const actions = useContext(CardActions);
  const navigate = useBbNavigate();
  const pending = data.busy;
  const asset = data.assets.find((item) => item.id === node.data.assetId);
  const document = data.documents.find((item) => item.id === node.data.documentId);
  const url =
    asset && data.baseUrl
      ? `${data.baseUrl.replace(/\/$/, "")}/${asset.path.split("/").map(encodeURIComponent).join("/")}`
      : undefined;
  const field = promptField(node.type);
  const prompt = field ? String(node.data[field] ?? "") : "";
  return (
    <div
      className="gs-node"
      data-kind={node.type}
      data-selected={selected || undefined}
      data-generation={pending ? "pending" : data.job?.status}
      style={{ "--gs-kind": info.color } as CSSProperties}
    >
      {field && node.type !== "text" && (
        <NodeToolbar isVisible={selected} position={Position.Top} offset={30}>
          <div className="gs-node-toolbar">
            <GenerationSettings node={node} compact onChange={(patch) => actions.edit(id, patch)} />
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                title="Open output"
                aria-label="Open output"
              >
                <Icon name="ExternalLink" />
              </a>
            )}
          </div>
        </NodeToolbar>
      )}
      <header className="gs-node-label" title="Drag to move">
        <Icon name={info.icon} />
        <strong>{node.title || info.label}</strong>
        {field && <span>{nodeModelLabel(node)}</span>}
      </header>
      <div className="gs-node-body">
        <Handle type="target" position={Position.Left} className="gs-port">
          {selected && (
            <span className="gs-port-label" data-side="in">
              <Icon name="ArrowRightToLine" />
              Inputs
            </span>
          )}
        </Handle>
        <NodePreview
          node={node}
          asset={asset}
          document={document}
          url={url}
          placeholder={!selected && !prompt}
          pending={pending}
        />
        {field &&
          (selected ? (
            <div className="gs-node-prompt nodrag nopan nowheel">
              <textarea
                aria-label={`${info.label} brief`}
                placeholder={
                  node.type === "text"
                    ? "Write your text instruction…"
                    : `Describe the ${info.label.toLowerCase()} and its Unity consumer…`
                }
                value={prompt}
                onChange={(event) => actions.edit(id, { [field]: event.target.value })}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    actions.run(id);
                  }
                }}
              />
              <footer>
                <small>{runsDirectly(node) ? "⌘↵ to run" : "Prepares a composer request"}</small>
                <button
                  type="button"
                  className="gs-node-run"
                  title={runsDirectly(node) ? "Run node" : "Prepare request"}
                  aria-label={runsDirectly(node) ? "Run node" : "Prepare request"}
                  disabled={pending || (!prompt.trim() && node.type !== "model-3d")}
                  onClick={() => actions.run(id)}
                >
                  <Icon name={pending ? "LoaderCircle" : "ArrowUp"} />
                </button>
              </footer>
            </div>
          ) : (
            prompt.trim() && <p className="gs-node-brief">{prompt}</p>
          ))}
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
        <Handle type="source" position={Position.Right} className="gs-port">
          {selected && (
            <span className="gs-port-label" data-side="out">
              <Icon name="ArrowRightFromLine" />
              {info.label}
            </span>
          )}
        </Handle>
      </div>
    </div>
  );
}
function NodePreview({
  node,
  asset,
  document,
  url,
  placeholder,
  pending,
}: {
  node: CanvasNode;
  asset?: Asset;
  document?: StudioDocument;
  url?: string;
  placeholder: boolean;
  pending?: boolean;
}) {
  const info = kindInfo(node.type);
  const aspectRatio =
    typeof node.data.aspectRatio === "string"
      ? node.data.aspectRatio.replace(":", " / ")
      : undefined;
  if (url && (asset?.type === "image" || asset?.type === "video"))
    return (
      <div className="gs-node-media" style={{ aspectRatio }}>
        {asset.type === "image" ? (
          <img src={url} alt={asset.name} />
        ) : (
          <video src={url} muted preload="metadata" />
        )}
        <span className="gs-node-badge">
          {asset.path.startsWith("Assets/") ? "In Assets" : "Staged"}
        </span>
      </div>
    );
  if (node.type === "image" || node.type === "video")
    return (
      <div className="gs-node-media" data-empty style={{ aspectRatio }}>
        <Icon name={info.icon} />
        <span>{pending ? "Generating…" : "No output yet"}</span>
      </div>
    );
  const markdown = document ? document.markdown.slice(0, 800) || "Empty document" : node.data.text;
  if (markdown)
    return (
      <div className="gs-node-text nodrag nopan nowheel">
        <Markdown content={String(markdown)} />
      </div>
    );
  if (node.type === "text")
    return placeholder ? <p className="gs-node-placeholder">Add a design note…</p> : null;
  return (
    <p className="gs-node-placeholder">
      <Icon name={info.icon} />
      {asset?.name ||
        node.description ||
        (promptField(node.type) ? "No output yet" : "Select to edit")}
    </p>
  );
}
/** Melius-style bottom bar: add menu, pointer tools, layout, and zoom. Lives inside React Flow. */
function CanvasToolbar({
  tool,
  onTool,
  onAdd,
  onUpload,
  onArrange,
  canArrange,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  onAdd: (kind: NodeKind) => void;
  onUpload: () => void;
  onArrange: () => void;
  canArrange: boolean;
}) {
  const [menu, setMenu] = useState<"add" | "zoom" | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const { zoom } = useViewport();
  const flow = useReactFlow();
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!bar.current?.contains(event.target as globalThis.Node)) setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  const choose = (action: () => unknown) => () => {
    setMenu(null);
    void action();
  };
  return (
    <Panel position="bottom-center" className="gs-canvas-toolbar-panel">
      <div
        className="gs-canvas-toolbar"
        role="toolbar"
        aria-label="Canvas tools"
        tabIndex={-1}
        ref={bar}
        onKeyDown={(event) => {
          if (event.key === "Escape" && menu) {
            event.stopPropagation();
            setMenu(null);
          }
        }}
      >
        {menu === "add" && (
          <div className="gs-canvas-menu" role="menu" aria-label="Add node" data-align="start">
            {kinds
              .filter((item) => item.key)
              .map((item) => (
                <button
                  key={item.kind}
                  role="menuitem"
                  onClick={choose(() => onAdd(item.kind))}
                  style={{ "--gs-kind": item.color } as CSSProperties}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  <kbd>{item.key!.toUpperCase()}</kbd>
                </button>
              ))}
            <details className="gs-canvas-utilities">
              <summary>
                <Icon name="Wrench" />
                <span>Utilities</span>
                <Icon name="ChevronDown" />
              </summary>
              {kinds
                .filter((item) => !item.key)
                .map((item) => (
                  <button key={item.kind} role="menuitem" onClick={choose(() => onAdd(item.kind))}>
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                ))}
              <button role="menuitem" onClick={choose(onUpload)}>
                <Icon name="Upload" />
                <span>Upload to staging</span>
              </button>
            </details>
          </div>
        )}
        {menu === "zoom" && (
          <div className="gs-canvas-menu" role="menu" aria-label="Zoom" data-align="end">
            <button role="menuitem" onClick={choose(() => flow.zoomIn())}>
              <span>Zoom in</span>
            </button>
            <button role="menuitem" onClick={choose(() => flow.zoomOut())}>
              <span>Zoom out</span>
            </button>
            <button role="menuitem" onClick={choose(() => flow.zoomTo(1))}>
              <span>Zoom to 100%</span>
            </button>
            <button
              role="menuitem"
              onClick={choose(() => flow.fitView({ maxZoom: 1, minZoom: 0.15, padding: 0.15 }))}
            >
              <span>Zoom to fit</span>
            </button>
          </div>
        )}
        <button
          className="gs-canvas-add"
          title="Add node"
          aria-label="Add node"
          aria-haspopup="menu"
          aria-expanded={menu === "add"}
          onClick={() => setMenu(menu === "add" ? null : "add")}
        >
          <Icon name="Plus" />
        </button>
        <div className="gs-canvas-segment">
          <button
            title="Select"
            aria-label="Select tool"
            aria-pressed={tool === "select"}
            onClick={() => onTool("select")}
          >
            <Icon name="MousePointer2" />
          </button>
          <button
            title="Hand (H)"
            aria-label="Hand tool"
            aria-pressed={tool === "hand"}
            onClick={() => onTool("hand")}
          >
            <Icon name="Hand" />
          </button>
        </div>
        <span className="gs-canvas-divider" />
        <button
          title="Arrange nodes"
          aria-label="Arrange nodes"
          disabled={!canArrange}
          onClick={onArrange}
        >
          <Icon name="Workflow" />
        </button>
        <button
          title="Zoom to fit"
          aria-label="Zoom to fit"
          onClick={() => void flow.fitView({ maxZoom: 1, minZoom: 0.15, padding: 0.15 })}
        >
          <Icon name="Scan" />
        </button>
        <span className="gs-canvas-divider" />
        <button
          className="gs-canvas-zoom"
          aria-label="Zoom options"
          aria-haspopup="menu"
          aria-expanded={menu === "zoom"}
          onClick={() => setMenu(menu === "zoom" ? null : "zoom")}
        >
          {Math.round(zoom * 100)}%
        </button>
      </div>
    </Panel>
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
        position: source.editorLayout.nodes[node.id] ?? node.position,
        data: { source: node, documents, assets, baseUrl: previewBaseUrl },
      })),
    [documents, assets, previewBaseUrl],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Card>(cards(board));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(board.edges);
  const [selectedId, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  // Cards read the latest handlers through a stable context value.
  const latestActions = useRef<CardActionsValue>({ edit: () => {}, run: () => {} });
  const [cardActions] = useState<CardActionsValue>(() => ({
    edit: (id, patch) => latestActions.current.edit(id, patch),
    run: (id) => latestActions.current.run(id),
  }));
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
  const selectedAsset = assets.find((asset) => asset.id === selected?.data.source.data.assetId);
  const selectedJob = generationJobs.find(
    (job) => job.target?.boardId === board.id && job.target.nodeId === selectedId,
  );
  const busy = (id: string | null) =>
    starting === id ||
    generationJobs.some(
      (job) =>
        job.target?.boardId === board.id &&
        job.target.nodeId === id &&
        ["queued", "running"].includes(job.status),
    );
  const generating = busy(selectedId);
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
  const hasImageReference = (source: CanvasNode) =>
    [source.data.images, source.data.references]
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
      });
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
  const editData = (id: string, patch: NodePatch) => {
    setNodes((current) =>
      current.map((node) =>
        node.id === id
          ? {
              ...node,
              data: {
                ...node.data,
                source: {
                  ...node.data.source,
                  data: { ...node.data.source.data, ...patch },
                },
              },
            }
          : node,
      ),
    );
    change();
  };
  const updateData = (key: string, value: string) => {
    if (selected) editData(selected.id, { [key]: value });
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
  const generate = async (id: string, model: { provider: string; id?: string }) => {
    if (startingRef.current || busy(id)) return;
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
  const run = async (id: string) => {
    const source = nodes.find((node) => node.id === id)?.data.source;
    const recipe = source && nodeRecipe(source);
    if (!source || busy(id)) return;
    if (runsDirectly(source))
      return generate(
        id,
        source.type === "text"
          ? { provider: "bb" }
          : recipe?.id === "concept-art"
            ? { provider: "midjourney" }
            : { provider: "google", id: "gemini-nano-banana-2.1" },
      );
    if (!recipe) return;
    if (recipe.id === "model-3d" && !hasImageReference(source)) {
      setError("Connect an approved image before requesting a 3D model.");
      return;
    }
    if (dirty && !(await save())) return;
    onGenerate(id, recipe.id);
  };
  useEffect(() => {
    latestActions.current = { edit: editData, run: (id) => void run(id) };
  });
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
    const shortcut = kinds.find((item) => item.key === event.key.toLowerCase());
    if (event.metaKey || event.ctrlKey || event.altKey) {
      // Leave modified keys to the browser and BB.
    } else if (shortcut) {
      event.preventDefault();
      add(shortcut.kind);
      return;
    } else if (event.key.toLowerCase() === "h") {
      event.preventDefault();
      setTool(tool === "hand" ? "select" : "hand");
      return;
    }
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
    <CardActions.Provider value={cardActions}>
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
                busy: busy(node.id),
              },
            }))}
            edges={edges.map((edge) => ({
              ...edge,
              style: {
                stroke: kindInfo(nodes.find((node) => node.id === edge.source)?.data.source.type)
                  .color,
                strokeWidth: edge.selected ? 3 : 2,
              },
            }))}
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
                    return {
                      ...node,
                      data: { ...node.data, source: { ...node.data.source, data } },
                    };
                  }),
                );
              }
              onEdgesChange(changes);
              if (changes.some((item) => item.type !== "select")) change();
            }}
            onConnect={connect}
            onSelectionChange={selectionChanged}
            onNodeDoubleClick={(event) => {
              const brief = (event.target as HTMLElement)
                .closest(".react-flow__node")
                ?.querySelector("textarea");
              (brief ?? inspector.current?.querySelector("input"))?.focus();
            }}
            onPaneClick={() => {
              clearSelection();
              root.current?.focus();
            }}
            onMoveEnd={(event, view) => {
              const before = viewport.current;
              viewport.current = view;
              if (
                event &&
                (before.x !== view.x || before.y !== view.y || before.zoom !== view.zoom)
              )
                change();
            }}
            minZoom={0.15}
            maxZoom={2.5}
            deleteKeyCode={null}
            panOnScroll
            panOnDrag={tool === "hand" ? true : [1, 2]}
            selectionOnDrag={tool === "select"}
            nodesDraggable={tool === "select"}
            zoomOnScroll={false}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
            data-tool={tool}
          >
            <Background gap={20} size={1.5} />
            <CanvasToolbar
              tool={tool}
              onTool={setTool}
              onAdd={add}
              onUpload={onUpload}
              onArrange={arrange}
              canArrange={nodes.length > 1}
            />
          </ReactFlow>
          {!nodes.length && (
            <div className="gs-canvas-empty">
              <h2>Start imagining</h2>
              <p>Connect design notes, reference art, and Unity assets.</p>
              <p>
                Press <kbd>T</kbd> for text, <kbd>I</kbd> for image, <kbd>V</kbd> for video, or{" "}
                <kbd>A</kbd> for audio.
              </p>
            </div>
          )}
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
          <aside className="gs-node-inspector" ref={inspector} aria-label="Node inspector">
            <header>
              <input
                className="gs-inspector-title"
                aria-label="Node title"
                maxLength={200}
                placeholder={kindInfo(selected.data.source.type).label}
                value={selected.data.source.title ?? ""}
                onChange={(e) => updateSelected({ title: e.target.value })}
              />
              <button
                className="gs-icon"
                aria-label="Close node inspector"
                onClick={clearSelection}
              >
                <Icon name="X" />
              </button>
            </header>
            <dl className="gs-inspector-facts">
              <div>
                <dt>Type</dt>
                <dd>{kindInfo(selected.data.source.type).label}</dd>
              </div>
              {promptField(selected.data.source.type) && (
                <div>
                  <dt>Model</dt>
                  <dd>{nodeModelLabel(selected.data.source)}</dd>
                </div>
              )}
              {selectedAsset && (
                <>
                  <div>
                    <dt>Output</dt>
                    <dd title={selectedAsset.path}>{selectedAsset.name}</dd>
                  </div>
                  <div>
                    <dt>Location</dt>
                    <dd>{selectedAsset.path.startsWith("Assets/") ? "In Assets" : "Staged"}</dd>
                  </div>
                </>
              )}
            </dl>
            {promptField(selected.data.source.type) && selected.data.source.type !== "text" && (
              <details className="gs-inspector-section" open>
                <summary>Generation settings</summary>
                <GenerationSettings
                  node={selected.data.source}
                  onChange={(patch) => editData(selected.id, patch)}
                />
              </details>
            )}
            {selected.data.source.type === "text" ? (
              <label>
                Note
                <textarea
                  value={String(selected.data.source.data.text ?? "")}
                  placeholder="Write or generate the note…"
                  onChange={(e) => updateData("text", e.target.value)}
                />
              </label>
            ) : (
              selected.data.source.type === "document" && (
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
              )
            )}
            {["text", "image", "video", "model-3d"].includes(selected.data.source.type) && (
              <BriefStarters
                key={selected.id}
                kind={selected.data.source.type}
                hasDraft={Boolean(
                  String(
                    selected.data.source.data[
                      selected.data.source.type === "text" ? "instruction" : "prompt"
                    ] ?? "",
                  ).trim(),
                )}
                onInsert={(text) => {
                  const field = selected.data.source.type === "text" ? "instruction" : "prompt";
                  const current = String(selected.data.source.data[field] ?? "").trimEnd();
                  updateData(field, current ? `${current}\n\n${text}` : text);
                }}
              />
            )}
            {["text", "image"].includes(selected.data.source.type) && (
              <>
                <CanvasInputs
                  node={selected.data.source}
                  nodes={nodes.map((node) => node.data.source)}
                  assets={assets}
                  onToggle={toggleInput}
                />
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
                          {selectedJob.request.kind === "text"
                            ? "Check BB run"
                            : "Resume saved job"}
                        </button>
                      )}
                  </div>
                )}
              </>
            )}
            {!["text", "document", "table"].includes(selected.data.source.type) && (
              <>
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
    </CardActions.Provider>
  );
}
