import {
  useBbNavigate,
  Markdown,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useCodeTheme as useCodeTheme,
} from "@get-bb/plugin-sdk/app";
import type { AgentSelection, GenerationJob } from "../shared/generation.ts";
import { Icon } from "./icons.tsx";
// Canvas model and layout adapted from OhMyGame; modified for BB. Apache-2.0.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  useConnection,
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
import { nodeBriefRecipe, nodeInputs, nodeRecipe, nodeTakesBrief } from "../shared/recipes.ts";
import { outputType } from "../shared/inputs.ts";
import type { InputRef, InputType, PortInputs } from "../shared/inputs.ts";
import { CanvasInputs } from "./canvas-inputs.tsx";
import {
  GenerationSettings,
  nodeAgent,
  nodeBatch,
  nodeModelLabel,
  promptField,
  runsDirectly,
} from "./generation.tsx";
import { ModelPreview } from "./model-preview.tsx";
import { ReviewSection, VerdictBadge, outputReviewState, pinnedAgent } from "./review.tsx";
import { reviewable } from "../shared/review.ts";
import { JudgeSection, isJudge } from "./judge.tsx";
import { judgeable } from "../shared/judge.ts";
import type { NodePatch } from "./generation.tsx";
import { BriefStarters } from "./brief-starters.tsx";
import { GenerationSection } from "./takes.tsx";
import { batchRequestId, nodeTakes, type Take } from "../shared/takes.ts";
import { arrangeNodes, newNodePosition, revealNode } from "./canvas-layout.ts";
import { boardSnapshot, rebaseBoard } from "./canvas-board.ts";
import "@xyflow/react/dist/style.css";
import "./canvas.css";

type CardData = {
  source: CanvasNode;
  documents: StudioDocument[];
  assets: Asset[];
  baseUrl?: string;
  /** Jobs targeting this node, newest first; `job` is the newest. */
  jobs?: GenerationJob[];
  job?: GenerationJob;
  busy?: boolean;
  /** A BB model is writing this media node's brief. */
  briefing?: boolean;
  /** The node's inputs placed on its model's ports. */
  inputs?: PortInputs<InputRef>[];
  /** Reviews of this node's outputs, newest first; kept apart from its generation jobs. */
  reviewJobs?: GenerationJob[];
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
  { kind: "agent", label: "Agent", icon: "Bot", key: "g", color: "var(--ansi-13, #c4a7ff)" },
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
// Each input type takes the color and icon of the node kind that feeds it.
const inputTypes = {
  text: kindInfo("text"),
  image: kindInfo("image"),
  model: kindInfo("model-3d"),
};
type CardActionsValue = {
  edit: (id: string, patch: NodePatch) => void;
  run: (id: string) => void;
  brief: (id: string) => void;
};
const CardActions = createContext<CardActionsValue>({
  edit: () => {},
  run: () => {},
  brief: () => {},
});
/** Where BB agents run for this canvas, and the agent they use until a node picks another. */
const AgentDefaults = createContext<{ hostId: string; agent: AgentSelection } | null>(null);
const running = (job: GenerationJob) => job.status === "queued" || job.status === "running";
const isBrief = (job: GenerationJob | undefined) =>
  job?.request.kind === "text" && !!job.request.briefFor;
const isReview = (job: GenerationJob) => job.request.kind === "text" && !!job.request.reviewOf;
function CanvasCard({ id, data, selected }: NodeProps<Card>) {
  const node = data.source;
  const info = kindInfo(node.type);
  const actions = useContext(CardActions);
  const defaults = useContext(AgentDefaults);
  const navigate = useBbNavigate();
  const briefing = !!data.briefing;
  const jobs = data.jobs ?? [];
  const media = node.type === "image" || node.type === "video";
  // Image runs keep the node usable, so "generating" comes from its jobs rather than `busy`.
  const pending =
    (data.busy && !briefing) || jobs.some((job) => running(job) && job.request.kind !== "text");
  const takes = media || node.type === "model-3d" || node.type === "agent" ? nodeTakes(node) : [];
  const briefModel = nodeBriefRecipe(node);
  const hasInputs =
    !!node.data.promptSource ||
    [node.data.images, node.data.references].some((refs) => Array.isArray(refs) && refs.length);
  const asset = data.assets.find((item) => item.id === node.data.assetId);
  const document = data.documents.find((item) => item.id === node.data.documentId);
  const url =
    asset && data.baseUrl
      ? `${data.baseUrl.replace(/\/$/, "")}/${asset.path.split("/").map(encodeURIComponent).join("/")}`
      : undefined;
  const field = promptField(node.type);
  const prompt = field ? String(node.data[field] ?? "") : "";
  // Steps such as Tripo Rig run from their inputs and settings alone, so they show no brief.
  const briefed = !!field && nodeTakesBrief(node);
  const modelLabel = nodeModelLabel(node);
  const agent =
    node.type === "text" || node.type === "agent"
      ? (nodeAgent(node) ?? defaults?.agent)
      : undefined;
  const placeholder =
    node.type === "text"
      ? "Ask an agent to write this note…"
      : node.type === "agent"
        ? "Tell the agent what this step does, such as a Blender cleanup…"
        : `Describe the ${info.label.toLowerCase()} and its Unity consumer…`;
  // An agent's run is a BB thread the person can open and steer.
  const agentThread =
    data.job?.request.kind === "agent" && data.job.taskId ? data.job.taskId : undefined;
  return (
    <div
      className="gs-node"
      data-kind={node.type}
      data-selected={selected || undefined}
      data-generation={pending ? (asset ? "pending-more" : "pending") : data.job?.status}
      style={{ "--gs-kind": info.color, "--gs-ports": data.inputs?.length ?? 0 } as CSSProperties}
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
        {modelLabel && <span>{modelLabel}</span>}
      </header>
      <div className="gs-node-body">
        <InputPorts inputs={data.inputs ?? []} selected={!!selected} />
        {/* A note is the user's own text, so a selected note edits in place. */}
        {node.type === "text" && selected ? (
          <textarea
            className="gs-node-text gs-node-note nodrag nopan nowheel"
            aria-label="Note"
            placeholder="Write a design note…"
            readOnly={data.busy}
            value={String(node.data.text ?? "")}
            onChange={(event) => actions.edit(id, { text: event.target.value })}
          />
        ) : (
          <NodePreview
            node={node}
            asset={asset}
            document={document}
            url={url}
            pending={pending}
            takes={takes.length > 1 ? takes : undefined}
            review={
              reviewable(node.type)
                ? outputReviewState(node, asset?.id, data.reviewJobs ?? [])
                : undefined
            }
          />
        )}
        {data.job && !(isBrief(data.job) && data.job.status === "succeeded") && (
          <div className="gs-generation-progress nodrag nopan">
            <span>
              {briefing
                ? "Writing brief…"
                : pending
                  ? "Generating…"
                  : data.job.status === "auth-required"
                    ? "Sign in required"
                    : data.job.status === "succeeded"
                      ? "Ready for review"
                      : data.job.status}
            </span>
            {agentThread ? (
              <button type="button" onClick={() => navigate.toThread(agentThread)}>
                Open agent thread ↗
              </button>
            ) : (
              data.job.origin.kind === "agent" &&
              data.job.threadId && (
                <button type="button" onClick={() => navigate.toThread(data.job!.threadId!)}>
                  View in thread ↗
                </button>
              )
            )}
            {data.job.detail && <small>{data.job.detail}</small>}
          </div>
        )}
        {/* The editor overlays the brief, so selecting a node never resizes or moves it. */}
        {field && (
          <div className="gs-node-brief-slot">
            {/* A note's ask is spent once its text is written; only inputs to a run stay on show. */}
            {briefed && prompt.trim() && node.type !== "text" && (
              <p className="gs-node-brief">{prompt}</p>
            )}
            {selected && (
              <div className="gs-node-prompt nodrag nopan nowheel">
                {briefed && (
                  <textarea
                    aria-label={`${info.label} brief`}
                    readOnly={briefing}
                    placeholder={placeholder}
                    value={prompt}
                    onChange={(event) => actions.edit(id, { [field]: event.target.value })}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        actions.run(id);
                      }
                    }}
                  />
                )}
                <footer>
                  {briefed && (
                    <BriefStarters
                      kind={node.type}
                      hasDraft={!!prompt.trim()}
                      onInsert={(text) =>
                        actions.edit(id, {
                          [field]: prompt.trimEnd() ? `${prompt.trimEnd()}\n\n${text}` : text,
                        })
                      }
                    />
                  )}
                  {agent && defaults ? (
                    <ProviderModelPicker
                      className="gs-node-agent"
                      value={agent}
                      onChange={(value) =>
                        actions.edit(id, {
                          agent: {
                            providerId: value.providerId,
                            model: value.model,
                            reasoningLevel: value.reasoningLevel,
                            ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}),
                          },
                        })
                      }
                      routing={{ kind: "host", hostId: defaults.hostId }}
                      disabled={data.busy}
                    />
                  ) : (
                    <small>
                      {runsDirectly(node)
                        ? briefed
                          ? "⌘↵ to run"
                          : "Runs from its inputs and settings"
                        : "Prepares a composer request"}
                    </small>
                  )}
                  {briefModel && (
                    <button
                      type="button"
                      className="gs-node-brief-write"
                      title={`Write a ${briefModel.label} brief with the BB model`}
                      aria-label={`Write a ${briefModel.label} brief with the BB model`}
                      disabled={data.busy || (!prompt.trim() && !hasInputs)}
                      onClick={() => actions.brief(id)}
                    >
                      <Icon name={briefing ? "LoaderCircle" : "Sparkles"} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="gs-node-run"
                    data-busy={(data.busy && !briefing) || undefined}
                    title={runsDirectly(node) ? "Run node" : "Prepare request"}
                    aria-label={runsDirectly(node) ? "Run node" : "Prepare request"}
                    disabled={data.busy || (!prompt.trim() && node.type !== "model-3d")}
                    onClick={() => actions.run(id)}
                  >
                    <Icon name={data.busy && !briefing ? "LoaderCircle" : "ArrowUp"} />
                  </button>
                </footer>
              </div>
            )}
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
/** The node model's input ports, stacked on the card's left edge. */
function InputPorts({ inputs, selected }: { inputs: PortInputs<InputRef>[]; selected: boolean }) {
  // While an output is dragged, every card shows which of its ports can take it.
  const dragging = useConnection<Card, InputType | null>((connection) =>
    connection.inProgress && connection.fromHandle.type === "source"
      ? (outputType(connection.fromNode.data.source.type) ?? null)
      : null,
  );
  return inputs.map(({ port, refs }, index) => {
    const { icon, color } = inputTypes[port.type];
    return (
      <Handle
        key={port.id}
        id={port.id}
        type="target"
        position={Position.Left}
        className="gs-port"
        data-filled={refs.length > 0 || undefined}
        data-invalid={refs.length > port.max || undefined}
        data-dimmed={(dragging && (dragging !== port.type || refs.length >= port.max)) || undefined}
        style={
          {
            "--gs-port": color,
            top: `calc(50% + ${(index - (inputs.length - 1) / 2) * 28}px)`,
          } as CSSProperties
        }
      >
        {(selected || dragging) && (
          <span className="gs-port-label" data-side="in">
            <Icon name={icon} />
            {port.label}
            {port.required && !refs.length && <i>required</i>}
            {port.max > 1 && refs.length > 0 && (
              <b>{Number.isFinite(port.max) ? `${refs.length}/${port.max}` : refs.length}</b>
            )}
          </span>
        )}
      </Handle>
    );
  });
}
function NodePreview({
  node,
  asset,
  document,
  url,
  pending,
  takes,
  review,
}: {
  node: CanvasNode;
  asset?: Asset;
  document?: StudioDocument;
  url?: string;
  pending?: boolean;
  takes?: Take[];
  review?: ReturnType<typeof outputReviewState>;
}) {
  const verdict = review && (
    <VerdictBadge verdict={review.verdict} reviewing={review.reviewing} className="gs-node-badge" />
  );
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
        {takes && (
          <span className="gs-node-badge" data-takes>
            {takes.length} takes
            {takes.some((take) => take.star) && ` · ${takes.filter((take) => take.star).length} ★`}
          </span>
        )}
        {verdict}
      </div>
    );
  if (url && asset?.type === "model" && /\.(glb|gltf)$/i.test(asset.path))
    return (
      <div className="gs-node-media" data-model>
        <ModelPreview url={url} name={asset.name} />
        <span className="gs-node-badge">
          {asset.path.startsWith("Assets/") ? "In Assets" : "Staged"}
        </span>
        {takes && (
          <span className="gs-node-badge" data-takes>
            {takes.length} takes
          </span>
        )}
        {verdict}
      </div>
    );
  if (node.type === "image" || node.type === "video" || node.type === "agent")
    return (
      <div className="gs-node-media" data-empty style={{ aspectRatio }}>
        <Icon name={info.icon} />
        <span>
          {pending ? (node.type === "agent" ? "Agent working…" : "Generating…") : "No output yet"}
        </span>
      </div>
    );
  const markdown = document ? document.markdown.slice(0, 800) || "Empty document" : node.data.text;
  if (markdown)
    return (
      <div className="gs-node-text nodrag nopan nowheel">
        <Markdown content={String(markdown)} />
      </div>
    );
  if (node.type === "text") return <p className="gs-node-placeholder">Add a design note…</p>;
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
const fitOptions = { maxZoom: 1, minZoom: 0.15, padding: 0.15 };
/** Figma-style zoom keys; shifted digits match by physical key. */
const zoomKeys: Record<string, (flow: ReactFlowInstance<Card>) => unknown> = {
  "+": (flow) => flow.zoomIn(),
  "=": (flow) => flow.zoomIn(),
  "-": (flow) => flow.zoomOut(),
  Digit0: (flow) => flow.zoomTo(1),
  Digit1: (flow) => flow.fitView(fitOptions),
};
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
  const [utilities, setUtilities] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const { zoom } = useViewport();
  const flow = useReactFlow();
  useEffect(() => {
    if (!menu) return;
    bar.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (event: PointerEvent) => {
      if (!bar.current?.contains(event.target as globalThis.Node)) setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  const toggle = (next: "add" | "zoom") => {
    setUtilities(false);
    setMenu(menu === next ? null : next);
  };
  const choose = (action: () => unknown) => () => {
    setMenu(null);
    void action();
  };
  const zoomItems = [
    { label: "Zoom in", keys: "+", action: () => flow.zoomIn() },
    { label: "Zoom out", keys: "−", action: () => flow.zoomOut() },
    { label: "Zoom to 100%", keys: "⇧0", action: () => flow.zoomTo(1) },
    { label: "Zoom to fit", keys: "⇧1", action: () => flow.fitView(fitOptions) },
  ];
  return (
    <Panel position="bottom-center" className="gs-canvas-toolbar-panel">
      <div
        className="gs-canvas-toolbar"
        role="toolbar"
        aria-label="Canvas tools"
        tabIndex={-1}
        ref={bar}
        onKeyDown={(event) => {
          if (!menu) return;
          if (event.key === "Escape") {
            event.stopPropagation();
            setMenu(null);
            bar.current?.querySelector<HTMLElement>(`[data-menu="${menu}"]`)?.focus();
            return;
          }
          const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
          if (!step) return;
          event.preventDefault();
          event.stopPropagation();
          const items = [
            ...(bar.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
          ];
          const index = items.indexOf(document.activeElement as HTMLElement);
          items.at(index < 0 ? Math.min(step, 0) : (index + step) % items.length)?.focus();
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
            <hr />
            <button
              role="menuitem"
              className="gs-canvas-utilities"
              aria-expanded={utilities}
              onClick={() => setUtilities(!utilities)}
            >
              <Icon name="Wrench" />
              <span>Utilities</span>
              <Icon name="ChevronDown" />
            </button>
            {utilities &&
              [
                ...kinds
                  .filter((item) => !item.key)
                  .map((item) => ({
                    id: item.kind,
                    icon: item.icon,
                    label: item.label,
                    action: () => onAdd(item.kind),
                  })),
                { id: "upload", icon: "Upload", label: "Upload to staging", action: onUpload },
              ].map((item) => (
                <button key={item.id} role="menuitem" data-nested onClick={choose(item.action)}>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </button>
              ))}
          </div>
        )}
        {menu === "zoom" && (
          <div className="gs-canvas-menu" role="menu" aria-label="Zoom" data-align="end">
            {zoomItems.map((item) => (
              <button key={item.label} role="menuitem" onClick={choose(item.action)}>
                <span>{item.label}</span>
                <kbd>{item.keys}</kbd>
              </button>
            ))}
          </div>
        )}
        <button
          className="gs-canvas-add"
          data-menu="add"
          title="Add node"
          aria-label="Add node"
          aria-haspopup="menu"
          aria-expanded={menu === "add"}
          onClick={() => toggle("add")}
        >
          <Icon name="Plus" />
        </button>
        <span className="gs-canvas-divider" />
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
          title="Zoom to fit (⇧1)"
          aria-label="Zoom to fit"
          onClick={() => void flow.fitView(fitOptions)}
        >
          <Icon name="Scan" />
        </button>
        <button
          className="gs-canvas-zoom"
          data-menu="zoom"
          title="Zoom options"
          aria-label="Zoom options"
          aria-haspopup="menu"
          aria-expanded={menu === "zoom"}
          onClick={() => toggle("zoom")}
        >
          <span>{Math.round(zoom * 100)}%</span>
          <Icon name="ChevronDown" />
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
    case "agent":
      return { instruction: "", references: [] };
    case "asset":
      return { assetId: "", mediaType: "audio" };
    case "table":
      return { tableId: "" };
  }
};
const noGenerationJobs: GenerationJob[] = [];
export function StudioCanvas({
  gameId,
  hostId,
  defaultAgent,
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
  onReview,
  onJudge,
  onOpenDocument,
  onUpload,
  onStatus,
}: {
  gameId: string;
  hostId: string;
  /** The agent text nodes and reviews run on until a node picks another. */
  defaultAgent: AgentSelection;
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
    brief?: true,
    agent?: AgentSelection,
  ) => Promise<void>;
  /** Reviews one output of an image or 3D node now. */
  onReview: (nodeId: string, revision: string, requestId: string, assetId: string) => Promise<void>;
  /** Has an image node's judge choose between its shortlist, or its takes, now. */
  onJudge: (nodeId: string, revision: string, requestId: string) => Promise<void>;
  onGenerationControl: (
    jobId: string,
    action: "status" | "resume" | "cancel",
  ) => Promise<{ missing: boolean }>;
  onOpenDocument: (id: string) => void;
  onUpload: () => void;
  onStatus?: (status: "saved" | "saving" | "dirty" | "error") => void;
}) {
  const { mode: colorMode } = useCodeTheme();
  const agentDefaults = useMemo(() => ({ hostId, agent: defaultAgent }), [hostId, defaultAgent]);
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
  const latestActions = useRef<CardActionsValue>({
    edit: () => {},
    run: () => {},
    brief: () => {},
  });
  const [cardActions] = useState<CardActionsValue>(() => ({
    edit: (id, patch) => latestActions.current.edit(id, patch),
    run: (id) => latestActions.current.run(id),
    brief: (id) => latestActions.current.brief(id),
  }));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [startingBrief, setStartingBrief] = useState<string | null>(null);
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
  /** The saved board the local draft is based on, for rebasing onto newer disk versions. */
  const synced = useRef(board);
  const editVersion = useRef(0);
  const [edits, setEdits] = useState(0);
  const savedEdits = useRef(0);
  const inflight = useRef<Promise<string | undefined> | null>(null);
  const viewport = useRef<Viewport>(board.editorLayout.viewport);
  const selected = nodes.find((node) => node.id === selectedId);
  const selectedAsset = assets.find((asset) => asset.id === selected?.data.source.data.assetId);
  const targetJobs = (id: string | null) =>
    generationJobs.filter((job) => job.target?.boardId === board.id && job.target.nodeId === id);
  // Reviews run beside a node's generations; they never make the node busy or replace its status.
  const nodeJobs = (id: string | null) =>
    targetJobs(id).filter((job) => !isReview(job) && !isJudge(job));
  const reviewJobs = (id: string | null) => targetJobs(id).filter(isReview);
  const judgeJobs = (id: string | null) => targetJobs(id).filter(isJudge);
  const selectedJob = nodeJobs(selectedId)[0];
  const briefing = (id: string) =>
    startingBrief === id || nodeJobs(id).some((job) => running(job) && isBrief(job));
  /** Image runs become takes, so rerolls start while earlier runs generate. */
  const selectedMedia =
    selected?.data.source.type === "image" || selected?.data.source.type === "video";
  // Takes choose a media node's output, so the asset picker only links outputs by hand.
  const takesShown = !!selected && selectedMedia && nodeTakes(selected.data.source).length > 0;
  const busy = (id: string | null) =>
    starting === id ||
    startingBrief === id ||
    nodeJobs(id).some((job) => running(job) && job.request.kind !== "image");
  const generating = busy(selectedId);
  const root = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<Card>>(null);
  /** A newly added node to keep in view while it first renders; selection never pans. */
  const focusNode = useRef<string | null>(null);
  const needsInitialFit = useRef(board.editorLayout.fitView !== false);
  const frame = useRef(0);
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
  const selectionChanged = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams<Card>) => {
      const id = selectedNodes.length === 1 ? selectedNodes[0]!.id : null;
      if (id !== focusNode.current) focusNode.current = null;
      setSelected(id);
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
  const change = useCallback(() => {
    editVersion.current += 1;
    setEdits(editVersion.current);
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
      connect({
        source: sourceId,
        target: selected.id,
        sourceHandle: null,
        targetHandle: null,
      });
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
    focusNode.current = id;
    setSelected(id);
    change();
  };
  const nodeKinds = new Map(nodes.map((node) => [node.id, node.data.source.type]));
  const kindOf = (id: string) => nodeKinds.get(id);
  const nodePorts = new Map(nodes.map((node) => [node.id, nodeInputs(node.data.source, kindOf)]));
  /** The port an edge lands on: the one holding its saved input, else one of its type. */
  const edgePort = (edge: Edge) => {
    const ports = nodePorts.get(edge.target) ?? [];
    const holding = (match: (ref: InputRef) => boolean) =>
      ports.find(({ refs }) => refs.some(match))?.port.id;
    return (
      holding((ref) => ref.studioEdgeId === edge.id) ??
      holding((ref) => ref.nodeId === edge.source) ??
      ports.find(({ port }) => port.type === outputType(kindOf(edge.source)))?.port.id ??
      null
    );
  };
  /** The port a connection fills: the requested one, or the first open port of its type. */
  const openPort = (connection: Connection | Edge) => {
    const type = outputType(kindOf(connection.source));
    if (!type || connection.source === connection.target) return undefined;
    if (
      edges.some((edge) => edge.source === connection.source && edge.target === connection.target)
    )
      return undefined;
    return nodePorts
      .get(connection.target)
      ?.find(
        ({ port, refs }) =>
          port.type === type &&
          (!connection.targetHandle || port.id === connection.targetHandle) &&
          refs.length < port.max,
      )?.port;
  };
  const connect = (connection: Connection) => {
    const port = openPort(connection);
    if (!port) return;
    const edgeId = crypto.randomUUID();
    setEdges((current) => addEdge({ ...connection, targetHandle: port.id, id: edgeId }, current));
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
                [key]: [
                  ...refs,
                  { type: "node", nodeId: connection.source, studioEdgeId: edgeId, port: port.id },
                ],
              },
            },
          },
        };
      }),
    );
    change();
  };
  const snapshot = () =>
    boardSnapshot(
      board,
      nodes.map((node) => ({ ...node.data.source, position: node.position })),
      edges,
      viewport.current,
    );
  /** Saves the draft; concurrent callers wait for the save in flight, then save what remains. */
  const save = async (): Promise<string | undefined> => {
    if (inflight.current) await inflight.current;
    if (editVersion.current === savedEdits.current) return baseline.current;
    const run = (async () => {
      setSaving(true);
      setError("");
      onStatus?.("saving");
      const savedVersion = editVersion.current;
      const next = snapshot();
      try {
        const result = await onSave(next, baseline.current);
        baseline.current = result.revision;
        synced.current = next;
        savedEdits.current = savedVersion;
        const clean = editVersion.current === savedVersion;
        setDirty(!clean);
        onStatus?.(clean ? "saved" : "dirty");
        return clean ? result.revision : undefined;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // A newer disk version arrives through refetch; the draft rebases and saves again.
        if (message.includes("changed on disk")) onStatus?.("dirty");
        else {
          setError(`Could not save. Draft kept. ${message}`);
          onStatus?.("error");
        }
        return undefined;
      } finally {
        setSaving(false);
      }
    })();
    inflight.current = run;
    try {
      return await run;
    } finally {
      if (inflight.current === run) inflight.current = null;
    }
  };
  const latestSave = useRef(save);
  latestSave.current = save;
  // Disk changes (generation results, agents, other tabs) apply automatically. A local
  // draft rebases onto them and autosaves; nothing waits for a manual reload.
  useEffect(() => {
    if (revision === baseline.current || saving) return;
    const next = dirty ? rebaseBoard(synced.current, snapshot(), board) : board;
    setNodes((current) =>
      cards(next).map((node) =>
        Object.assign(node, {
          selected: current.some((old) => old.id === node.id && old.selected),
        }),
      ),
    );
    setEdges((current) =>
      next.edges.map((edge) =>
        Object.assign({}, edge, {
          selected: current.some((old) => old.id === edge.id && old.selected),
        }),
      ),
    );
    baseline.current = revision;
    synced.current = board;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- snapshot reads this render's draft.
  }, [board, cards, revision, dirty, saving, setNodes, setEdges]);
  useEffect(() => {
    if (!dirty || saving || revision !== baseline.current) return;
    const timer = setTimeout(() => void latestSave.current(), 600);
    return () => clearTimeout(timer);
  }, [edits, dirty, saving, revision]);
  // Leaving the board (switching boards or tabs) saves the pending draft.
  useEffect(() => () => void latestSave.current(), []);
  const generate = async (
    id: string,
    model: { provider: string; id?: string },
    brief?: true,
    batch = 1,
    agent?: AgentSelection,
  ) => {
    if (startingRef.current || busy(id)) return;
    startingRef.current = true;
    (brief ? setStartingBrief : setStarting)(id);
    setError("");
    // A brief and a media run on one node keep separate retry identities.
    const key = brief ? `${id}#brief` : id;
    try {
      const saved = dirty ? await save() : baseline.current;
      if (!saved) throw new Error("Save the current edits before generating.");
      const requestId = requestIds.get(key) ?? crypto.randomUUID();
      rememberRequest(key, requestId);
      // A batch is separate requests; a retry reuses their identities.
      await Promise.all(
        Array.from({ length: batch }, (_, index) =>
          onGenerateDirect(
            id,
            saved,
            batch > 1 ? batchRequestId(requestId, index) : requestId,
            model,
            brief,
            agent,
          ),
        ),
      );
      rememberRequest(key);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      startingRef.current = false;
      (brief ? setStartingBrief : setStarting)(null);
    }
  };
  const [reviewing, setReviewing] = useState<string | null>(null);
  /** Starts a review or judgement, which reads the node's saved settings, so saves first. */
  const check = async (id: string, start: (revision: string) => Promise<void>) => {
    if (reviewing) return;
    setReviewing(id);
    setError("");
    try {
      const saved = dirty ? await save() : baseline.current;
      if (!saved) throw new Error("Save the current edits first.");
      await start(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReviewing(null);
    }
  };
  const reviewOutput = (id: string, assetId: string) =>
    check(id, (saved) => onReview(id, saved, crypto.randomUUID(), assetId));
  const judgeOutputs = (id: string) =>
    check(id, (saved) => onJudge(id, saved, crypto.randomUUID()));
  const run = async (id: string) => {
    const source = nodes.find((node) => node.id === id)?.data.source;
    const recipe = source && nodeRecipe(source);
    if (!source || busy(id)) return;
    if (source.type === "text" || source.type === "agent")
      return generate(id, { provider: "bb" }, undefined, 1, nodeAgent(source) ?? defaultAgent);
    const missing = nodePorts.get(id)?.find(({ port, refs }) => port.required && !refs.length);
    if (missing) {
      setError(`Connect an input to the ${missing.port.label} port first.`);
      return;
    }
    if (recipe?.id.startsWith("tripo-")) return generate(id, { provider: "tripo", id: "tripo-p2" });
    if (runsDirectly(source))
      return generate(
        id,
        recipe?.id === "concept-art"
          ? { provider: "midjourney" }
          : { provider: "google", id: "gemini-nano-banana-2.1" },
        undefined,
        nodeBatch(source),
      );
    if (!recipe) return;
    if (dirty && !(await save())) return;
    onGenerate(id, recipe.id);
  };
  useEffect(() => {
    latestActions.current = {
      edit: editData,
      run: (id) => void run(id),
      brief: (id) => void generate(id, { provider: "bb" }, true),
    };
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
    const zoomKey = zoomKeys[event.key] ?? (event.shiftKey ? zoomKeys[event.code] : undefined);
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
    } else if (zoomKey) {
      event.preventDefault();
      if (flow.current) void zoomKey(flow.current);
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
      <AgentDefaults.Provider value={agentDefaults}>
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
                  jobs: nodeJobs(node.id),
                  job: nodeJobs(node.id)[0],
                  reviewJobs: reviewJobs(node.id),
                  busy: busy(node.id),
                  briefing: briefing(node.id),
                  inputs: nodePorts.get(node.id),
                },
              }))}
              edges={edges.map((edge) => ({
                ...edge,
                targetHandle: edgePort(edge),
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
                              (other) =>
                                other.source === edge.source && other.target === edge.target,
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
              isValidConnection={(connection) => !!openPort(connection)}
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
          </div>
          {selected && (
            <aside className="gs-node-inspector" ref={inspector} aria-label="Node inspector">
              <header
                style={{ "--gs-kind": kindInfo(selected.data.source.type).color } as CSSProperties}
              >
                <span className="gs-inspector-kind">
                  <Icon name={kindInfo(selected.data.source.type).icon} />
                </span>
                <div>
                  <input
                    className="gs-inspector-title"
                    aria-label="Node title"
                    maxLength={200}
                    placeholder={kindInfo(selected.data.source.type).label}
                    value={selected.data.source.title ?? ""}
                    onChange={(e) => updateSelected({ title: e.target.value })}
                  />
                  <small>{kindInfo(selected.data.source.type).label}</small>
                </div>
                <button
                  className="gs-inspector-close"
                  aria-label="Close node inspector"
                  title="Close (Esc)"
                  onClick={clearSelection}
                >
                  <Icon name="X" />
                </button>
              </header>
              {promptField(selected.data.source.type) &&
                selected.data.source.type !== "text" &&
                !selectedMedia && (
                  <section className="gs-inspector-section">
                    <h3>Generation</h3>
                    {selected.data.source.type === "agent" ? (
                      <div className="gs-review-agent">
                        <span>Agent</span>
                        <ProviderModelPicker
                          value={nodeAgent(selected.data.source) ?? defaultAgent}
                          onChange={(value) => editData(selected.id, { agent: pinnedAgent(value) })}
                          routing={{ kind: "host", hostId }}
                        />
                      </div>
                    ) : (
                      <GenerationSettings
                        node={selected.data.source}
                        onChange={(patch) => editData(selected.id, patch)}
                      />
                    )}
                  </section>
                )}
              {selected.data.source.type === "document" && (
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
              )}
              {["text", "image", "agent", "model-3d"].includes(selected.data.source.type) && (
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
                              result.missing
                                ? "No submission was made. You can generate again."
                                : "",
                            );
                          })
                          .catch((cause) => setError(String(cause)));
                      }}
                    >
                      Check saved request
                    </button>
                  )}
                  {selectedJob?.origin.kind === "canvas" && !selectedMedia && (
                    <output className="gs-inline-job">
                      <span>
                        {generating
                          ? isBrief(selectedJob)
                            ? "Writing brief…"
                            : "Generating…"
                          : selectedJob.status === "succeeded"
                            ? isBrief(selectedJob)
                              ? "Brief written"
                              : "Generated"
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
                    </output>
                  )}
                </>
              )}
              {selectedMedia && (
                <GenerationSection
                  node={selected.data.source}
                  assets={assets}
                  baseUrl={previewBaseUrl}
                  jobs={nodeJobs(selected.id)}
                  batch={nodeBatch(selected.data.source)}
                  canRun={
                    !busy(selected.id) && !!String(selected.data.source.data.prompt ?? "").trim()
                  }
                  settings={
                    <GenerationSettings
                      node={selected.data.source}
                      onChange={(patch) => editData(selected.id, patch)}
                    />
                  }
                  reviewJobs={reviewJobs(selected.id)}
                  onChange={(patch) => editData(selected.id, patch)}
                  onRun={() => void run(selected.id)}
                  onControl={(jobId, action) =>
                    void onGenerationControl(jobId, action).catch((cause) =>
                      setError(String(cause)),
                    )
                  }
                />
              )}
              {!["text", "document", "table"].includes(selected.data.source.type) && (
                <section className="gs-inspector-section">
                  <h3>Output</h3>
                  {!takesShown && (
                    <label className="gs-inspector-row">
                      <span>Asset</span>
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
                  )}
                  {selectedAsset && (
                    <dl className="gs-inspector-facts">
                      <div>
                        <dt>Location</dt>
                        <dd>{selectedAsset.path.startsWith("Assets/") ? "In Assets" : "Staged"}</dd>
                      </div>
                    </dl>
                  )}
                </section>
              )}
              {reviewable(selected.data.source.type) && (
                <ReviewSection
                  node={selected.data.source}
                  assetId={selectedAsset?.id}
                  hostId={hostId}
                  defaultAgent={defaultAgent}
                  jobs={reviewJobs(selected.id)}
                  disabled={reviewing === selected.id}
                  onChange={(patch) => editData(selected.id, patch)}
                  onReview={(assetId) => void reviewOutput(selected.id, assetId)}
                />
              )}
              {judgeable(selected.data.source.type) && (
                <JudgeSection
                  node={selected.data.source}
                  assets={assets}
                  hostId={hostId}
                  defaultAgent={defaultAgent}
                  jobs={judgeJobs(selected.id)}
                  disabled={reviewing === selected.id}
                  onChange={(patch) => editData(selected.id, patch)}
                  onJudge={() => void judgeOutputs(selected.id)}
                />
              )}
              <button
                className="gs-danger gs-inspector-remove"
                onClick={() => {
                  void flow.current?.deleteElements({ nodes: [{ id: selected.id }] });
                }}
              >
                <Icon name="Trash2" />
                Remove node
              </button>
            </aside>
          )}
        </div>
      </AgentDefaults.Provider>
    </CardActions.Provider>
  );
}
