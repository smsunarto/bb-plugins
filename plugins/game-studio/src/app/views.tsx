import { Icon } from "./icons.tsx";
import { useState } from "react";
import type { ReactNode } from "react";
import { Markdown, experimental_FileLink as FileLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Workspace, StudioDocument, Asset, EvidenceRun } from "../shared/schema.ts";
import { rpc } from "./rpc.ts";

type Lease = { baseUrl: string; expiresAtMs: number } | null;
const assetUrl = (base: string, path: string) =>
  `${base.replace(/\/$/, "")}/${path.split("/").map(encodeURIComponent).join("/")}`;
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function DocumentDraft({
  document,
  active,
  gameId,
  onSaved,
  controls,
  onRequest,
}: {
  document: StudioDocument;
  active: boolean;
  gameId: string;
  onSaved: () => Promise<void>;
  controls: ReactNode;
  onRequest: () => void;
}) {
  const client = rpc.useClient();
  const [saved, setSaved] = useState(document);
  const [markdown, setMarkdown] = useState(document.markdown);
  const [mode, setMode] = useState<"edit" | "split" | "read">("split");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = markdown !== saved.markdown;
  const changed = document.revision !== saved.revision;
  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await client.saveDocument({
        gameId,
        documentId: document.id,
        markdown,
        revision: saved.revision,
      });
      setSaved({ ...document, markdown, revision: result.revision });
      await onSaved();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }
  if (!active) return null;
  return (
    <div className="gs-design-draft">
      <header className="gs-document-toolbar">
        {controls}
        <span className="gs-spacer" />
        <output className="gs-save-state">
          {saving ? "Saving…" : dirty ? "Unsaved" : "Saved"}
        </output>
        <div className="gs-segment">
          {(["edit", "split", "read"] as const).map((item) => (
            <button key={item} aria-pressed={mode === item} onClick={() => setMode(item)}>
              {item}
            </button>
          ))}
        </div>
        {(dirty || saving) && (
          <button
            className="gs-primary"
            aria-label="Save design document"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        <button onClick={onRequest}>Ask agent</button>
      </header>
      {changed && (
        <div className="gs-disk-notice">
          Updated outside this editor. Your draft is kept.
          <button
            onClick={() => {
              setSaved(document);
              setMarkdown(document.markdown);
              setError("");
            }}
          >
            Reload file
          </button>
        </div>
      )}
      {error && (
        <div className="gs-notice" role="alert">
          Could not save. Draft kept. {error}
        </div>
      )}
      <div className="gs-document-body" data-mode={mode}>
        {mode !== "read" && (
          <textarea
            aria-label="Design document"
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            spellCheck={false}
          />
        )}
        {mode !== "edit" && (
          <article className="gs-markdown">
            <Markdown content={markdown || "*Your design will appear here.*"} />
          </article>
        )}
      </div>
    </div>
  );
}
export function DesignEditor({
  workspace,
  selectedId,
  onSelect,
  onRefresh,
  onRequest,
}: {
  workspace: Workspace;
  selectedId: string;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<void>;
  onRequest: () => void;
}) {
  const client = rpc.useClient();
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const document =
    workspace.documents.find(
      (item) => item.id === (selectedId || workspace.index.mainDocumentId),
    ) ?? workspace.documents[0];
  async function add() {
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      const result = await client.createDocument({
        gameId: workspace.game.id,
        title: "Design document",
      });
      const created = result.documents.find(
        (item) => !workspace.documents.some((old) => old.id === item.id),
      );
      await onRefresh();
      if (created) onSelect(created.id);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setCreating(false);
    }
  }
  return (
    <section className="gs-design">
      {error && (
        <div className="gs-notice" role="alert">
          {error}
        </div>
      )}
      {document ? (
        workspace.documents.map((item) => (
          <DocumentDraft
            key={item.id}
            document={item}
            active={item.id === document.id}
            gameId={workspace.game.id}
            onSaved={onRefresh}
            onRequest={onRequest}
            controls={
              <select
                aria-label="Design document selection"
                value={document.id}
                disabled={creating}
                onChange={(event) =>
                  event.target.value === "__new__" ? void add() : onSelect(event.target.value)
                }
              >
                {workspace.documents.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.title}
                  </option>
                ))}
                <option value="__new__">New document…</option>
              </select>
            }
          />
        ))
      ) : (
        <div className="gs-empty">
          <Icon name="FileText" />
          <h2>No design doc yet</h2>
          <div className="gs-toolbar">
            <button className="gs-primary" onClick={onRequest}>
              Draft with agent
            </button>
            <button onClick={() => void add()} disabled={creating}>
              Start blank
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
function Media({
  asset,
  baseUrl,
  large = false,
}: {
  asset: Asset;
  baseUrl?: string;
  large?: boolean;
}) {
  const url = baseUrl ? assetUrl(baseUrl, asset.path) : undefined;
  if (asset.type === "image" && url) return <img src={url} alt={asset.name} loading="lazy" />;
  if (asset.type === "video" && url)
    return (
      <video src={url} controls={large} muted={!large} preload="metadata">
        <track kind="captions" label="Captions when supplied with capture" />
      </video>
    );
  if (asset.type === "audio" && url && large)
    return (
      <audio src={url} controls preload="metadata">
        <track kind="captions" label="Captions when supplied with asset" />
      </audio>
    );
  return (
    <Icon
      name={
        asset.type === "model"
          ? "Box"
          : asset.type === "audio"
            ? "Music"
            : asset.type === "video"
              ? "Video"
              : "Image"
      }
    />
  );
}
export function AssetLibrary({
  workspace,
  lease,
  onLease,
  onUpload,
  onImport,
}: {
  workspace: Workspace;
  lease: Lease;
  onLease: () => Promise<Lease>;
  onUpload: () => void;
  onImport: () => void;
}) {
  const [scope, setScope] = useState<"staged" | "project">("staged");
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Asset | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [dimensions, setDimensions] = useState("");
  const assets = workspace.assets
    .filter((asset) => (scope === "staged") === asset.path.startsWith("canvas/staging/"))
    .filter(
      (asset) =>
        (kind === "all" || asset.type === kind) &&
        asset.name.toLowerCase().includes(search.toLowerCase()),
    );
  const emptyTitle = search
    ? "No assets match"
    : scope === "staged"
      ? "No staged assets"
      : "No imported media";
  const emptyDescription =
    scope === "staged"
      ? "Generated and uploaded files land in canvas/staging."
      : "Imported media in Assets/GameStudio appears here.";
  return (
    <section className="gs-assets">
      <header className="gs-asset-toolbar">
        <div className="gs-segment">
          <button
            aria-pressed={scope === "staged"}
            onClick={() => {
              setScope("staged");
              setSelected(null);
            }}
          >
            Staged
          </button>
          <button
            aria-pressed={scope === "project"}
            onClick={() => {
              setScope("project");
              setSelected(null);
            }}
          >
            In project
          </button>
        </div>
        <select aria-label="Asset type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">All media</option>
          <option value="image">Images</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
          <option value="model">3D</option>
        </select>
        <input
          aria-label="Search assets"
          placeholder="Search assets"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="gs-spacer" />
        {!lease && <button onClick={() => void onLease()}>Load previews</button>}
        <button className="gs-primary" onClick={onUpload}>
          <Icon name="Upload" />
          Stage files
        </button>
      </header>
      <div className="gs-asset-body">
        {assets.length ? (
          <div className="gs-asset-grid">
            {assets.map((asset) => (
              <button
                className="gs-asset-tile"
                key={asset.id}
                aria-pressed={selected?.id === asset.id}
                onClick={() => {
                  setSelected(asset);
                  setCopyStatus("");
                  setDimensions("");
                  if (!lease) void onLease();
                }}
              >
                <div className="gs-asset-thumbnail">
                  <Media asset={asset} baseUrl={lease?.baseUrl} />
                </div>
                <span>{asset.name}</span>
                <small>{scope === "staged" ? "Staged" : "In Assets"}</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="gs-empty">
            <Icon name="Layers" />
            <h2>{emptyTitle}</h2>
            <p className="gs-muted">{emptyDescription}</p>
            <button onClick={onUpload}>Stage files</button>
          </div>
        )}
        {selected && (
          <aside className="gs-asset-inspector">
            <header>
              <strong>{selected.name}</strong>
              <button
                className="gs-icon"
                aria-label="Close asset inspector"
                onClick={() => setSelected(null)}
              >
                <Icon name="X" />
              </button>
            </header>
            <div
              className="gs-asset-large"
              onLoadCapture={(event) => {
                if (event.target instanceof HTMLImageElement)
                  setDimensions(`${event.target.naturalWidth} × ${event.target.naturalHeight}`);
              }}
            >
              <Media asset={selected} baseUrl={lease?.baseUrl} large />
            </div>
            <code>{selected.path}</code>
            {dimensions && <span className="gs-muted">{dimensions}</span>}
            <p className="gs-muted">
              Used on:{" "}
              {workspace.boards
                .filter(({ board }) =>
                  board.nodes.some((node) => node.data.assetId === selected.id),
                )
                .map(({ board }) => board.name)
                .join(", ") || "Not linked to a board"}
            </p>
            <FileLink
              target={{
                kind: "host",
                hostId: workspace.game.hostId,
                path: `${workspace.game.rootPath.replace(/[\\/]$/, "")}/${selected.path}`,
              }}
            >
              Open file in BB
            </FileLink>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(selected.path);
                  setCopyStatus("Copied");
                } catch {
                  setCopyStatus("Copy unavailable");
                }
              }}
            >
              {copyStatus || "Copy path"}
            </button>
            {scope === "staged" && (
              <button className="gs-primary" onClick={onImport}>
                Ask agent to import
              </button>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
type EvidenceFilter = "all" | "image" | "video" | "webgl";
const evidenceFilters: { id: EvidenceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Screenshots" },
  { id: "video", label: "Recordings" },
  { id: "webgl", label: "WebGL" },
];

function CaptureGrid({
  captures,
  lease,
  onSelect,
}: {
  captures: Asset[];
  lease: Lease;
  onSelect: (asset: Asset) => void;
}) {
  return (
    <div className="gs-capture-grid">
      {captures.map((asset) => (
        <button key={asset.id} onClick={() => onSelect(asset)}>
          <div className="gs-capture">
            <Media asset={asset} baseUrl={lease?.baseUrl} />
          </div>
          <span>{asset.name}</span>
        </button>
      ))}
    </div>
  );
}

function RunEvidence({
  run,
  lease,
  onSelect,
}: {
  run: EvidenceRun;
  lease: Lease;
  onSelect: (asset: Asset) => void;
}) {
  const navigate = useBbNavigate();
  const date = new Date(run.capturedAtMs);
  const threadId = run.threadId;
  return (
    <article className="gs-card">
      <header className="gs-toolbar">
        <strong>{run.scene ?? "Playtest run"}</strong>
        {run.outcome && (
          <span className={run.outcome === "pass" ? "gs-success" : "gs-warning"}>
            {run.outcome === "pass" ? "Pass" : "Fail"}
          </span>
        )}
        <span className="gs-spacer" />
        {threadId && <button onClick={() => navigate.toThread(threadId)}>View in thread</button>}
      </header>
      <p className="gs-muted">
        Captured <time dateTime={date.toISOString()}>{date.toLocaleString()}</time> · Run {run.id}
      </p>
      <CaptureGrid captures={run.files} lease={lease} onSelect={onSelect} />
    </article>
  );
}

function WebglPreview({
  workspace,
  lease,
  onLease,
  open,
}: {
  workspace: Workspace;
  lease: Lease;
  onLease: () => Promise<Lease>;
  open: boolean;
}) {
  const client = rpc.useClient();
  const navigate = useBbNavigate();
  const [entry, setEntry] = useState(workspace.game.previewPath);
  const [webgl, setWebgl] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  async function startWebgl() {
    setLoading(true);
    setError("");
    try {
      await client.updateGame({ gameId: workspace.game.id, previewPath: entry });
      const result = await onLease();
      if (!result) throw new Error("Preview lease unavailable");
      setWebgl(true);
      setNonce((n) => n + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }
  return (
    <details className="gs-card gs-webgl" open={open}>
      <summary>Preview a WebGL build</summary>
      <p className="gs-muted">
        Build in Unity first, then enter the HTML path relative to this project. This opens the
        exported game.
      </p>
      {error && (
        <div className="gs-notice" role="alert">
          {error}
        </div>
      )}
      <div className="gs-toolbar">
        <input
          aria-label="WebGL HTML entry"
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          placeholder="Builds/WebGL/index.html"
        />
        <button onClick={() => void startWebgl()} disabled={loading}>
          {loading ? "Opening…" : "Open build"}
        </button>
        {webgl && lease && (
          <button onClick={() => navigate.openUrl(assetUrl(lease.baseUrl, entry))}>
            Open in Browser
          </button>
        )}
      </div>
      {webgl && lease && (
        <iframe
          key={nonce}
          title="Unity WebGL build"
          src={assetUrl(lease.baseUrl, entry)}
          sandbox={
            new URL(lease.baseUrl, window.location.href).origin === window.location.origin
              ? "allow-scripts allow-pointer-lock allow-forms"
              : "allow-scripts allow-pointer-lock allow-forms allow-same-origin"
          }
          allow="fullscreen; autoplay; gamepad"
        />
      )}
    </details>
  );
}

export function Evidence({
  workspace,
  lease,
  onLease,
  onPlaytest,
}: {
  workspace: Workspace;
  lease: Lease;
  onLease: () => Promise<Lease>;
  onPlaytest: () => void;
}) {
  const navigate = useBbNavigate();
  const [selected, setSelected] = useState<Asset | null>(null);
  const [filter, setFilter] = useState<EvidenceFilter>("all");
  const runs = [...(workspace.evidenceRuns ?? [])].sort((a, b) => b.capturedAtMs - a.capturedAtMs);
  const reported = new Set(runs.flatMap((run) => run.files.map((asset) => asset.path)));
  const matches = (asset: Asset) => filter === "all" || asset.type === filter;
  const filteredRuns = runs
    .map((run) => Object.assign({}, run, { files: run.files.filter(matches) }))
    .filter((run) => run.files.length > 0);
  const ungrouped = (workspace.evidence ?? [])
    .filter((asset) => !reported.has(asset.path))
    .filter(matches);
  const hasCaptures = filteredRuns.length > 0 || ungrouped.length > 0;
  const showWebgl = filter === "all" || filter === "webgl";
  const threadId = workspace.game.threadId;
  function select(asset: Asset) {
    setSelected(asset);
    if (!lease) void onLease();
  }
  return (
    <section className="gs-evidence">
      <header className="gs-page-title">
        <Icon name="Camera" />
        <div>
          <h1>Evidence</h1>
          <p className="gs-muted">Playtest runs and captures from canvas/evidence.</p>
        </div>
        <span className="gs-spacer" />
        {threadId && <button onClick={() => navigate.toThread(threadId)}>View agent thread</button>}
        <button className="gs-primary" onClick={onPlaytest}>
          Playtest with agent
        </button>
      </header>
      <div className="gs-segment" aria-label="Evidence type">
        {evidenceFilters.map((item) => (
          <button
            key={item.id}
            aria-pressed={filter === item.id}
            onClick={() => {
              setFilter(item.id);
              setSelected(null);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {filteredRuns.map((run) => (
        <RunEvidence key={run.id} run={run} lease={lease} onSelect={select} />
      ))}
      {ungrouped.length > 0 && (
        <div>
          <h2>Ungrouped captures</h2>
          <p className="gs-muted">No run metadata supplied.</p>
          <CaptureGrid captures={ungrouped} lease={lease} onSelect={select} />
        </div>
      )}
      {selected && (
        <div className="gs-card gs-evidence-viewer">
          <header>
            <strong>{selected.name}</strong>
            <button onClick={() => setSelected(null)}>Close</button>
          </header>
          <Media asset={selected} baseUrl={lease?.baseUrl} large />
          <code>{selected.path}</code>
        </div>
      )}
      {!hasCaptures && filter !== "webgl" && (
        <div className="gs-empty">
          <Icon name="Camera" />
          <h2>No evidence yet</h2>
          <p className="gs-muted">Captures from Unity playtests land here.</p>
        </div>
      )}
      {showWebgl && (
        <WebglPreview
          key={workspace.game.id}
          workspace={workspace}
          lease={lease}
          onLease={onLease}
          open={filter === "webgl"}
        />
      )}
    </section>
  );
}
