import { rpc } from "./rpc.ts";
import { Icon } from "./icons.tsx";
import { ago } from "./time.ts";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { experimental_FileLink as FileLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Game, Workspace } from "../shared/schema.ts";
import type { StudioAction } from "./app.tsx";

export { editorInventorySchema as editorListSchema } from "../shared/unity-editor-contract.ts";
import { editorInventorySchema as editorListSchema } from "../shared/unity-editor-contract.ts";
export type EditorList = z.infer<typeof editorListSchema>;
const canonical = (path: string) => {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
};
const matchesProject = (instance: EditorList["instances"][number], game: Game) =>
  canonical(instance.projectPath) === canonical(game.rootPath) ||
  canonical(instance.workspacePath) === canonical(game.rootPath);
export function projectEditors(data: EditorList | undefined, game: Game) {
  return data?.instances.filter((instance) => matchesProject(instance, game)) ?? [];
}
export function editorLabel(data: EditorList | undefined, game: Game, threadId: string | null) {
  const instances = projectEditors(data, game);
  const claim = data?.claims.find((item) => matchesProject(item.instance, game));
  if (claim) {
    if (claim.orphaned) return "Owner unavailable";
    if (!instances.some((instance) => instance.id === claim.instance.id))
      return "Editor gone · recovery needed";
    if (claim.jobId === "uncertain") return "Uncertain · needs reconcile";
    if (claim.ownerThreadId !== threadId) return "Owned by another thread";
    return `${claim.mode === "authoring" ? "Authoring" : "Inspecting"} · ${claim.jobId === "uncertain" ? "uncertain — reconcile needed" : claim.jobId ? "job running" : "idle"}`;
  }
  return instances.length ? "Editor found" : "No Editor";
}
export function useUnityEditors(hostId?: string) {
  const client = rpc.useClient();
  return useQuery({
    queryKey: ["game-studio", "unity-editors", hostId],
    enabled: Boolean(hostId),
    queryFn: () => client.listUnityEditors({ hostId: hostId! }),
    refetchInterval: 5000,
    retry: false,
  });
}
const requestLabels = {
  "new-unity": "Create Unity project",
  connect: "Connect Editor",
  design: "Develop design",
  build: "Implement",
  playtest: "Playtest",
  import: "Import staged assets",
  asset: "Generate asset",
};
const requestStatusLabels = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  uncertain: "Uncertain",
};

export function UnityPanel({
  workspace,
  editors,
  onRequest,
  onOpenAssets,
}: {
  workspace: Workspace;
  editors: ReturnType<typeof useUnityEditors>;
  onRequest: (action: StudioAction) => void;
  onOpenAssets: () => void;
}) {
  const navigate = useBbNavigate();
  const { game } = workspace;
  const creationRequest = workspace.requests.find((request) => request.action === "new-unity");
  const instances = projectEditors(editors.data, game);
  const claims = editors.data?.claims.filter((claim) => matchesProject(claim.instance, game)) ?? [];
  const otherOwner = claims.find((claim) => claim.ownerThreadId !== game.threadId);
  const uncertain = claims.some((claim) => claim.jobId === "uncertain");
  const missingEditor = claims.some(
    (claim) => !instances.some((instance) => instance.id === claim.instance.id),
  );
  const blockedReason = otherOwner
    ? "Owned by another thread. Claims cannot be taken over."
    : uncertain
      ? "Reconcile the Editor before starting more work."
      : missingEditor
        ? "Recover the Editor claim before starting more work."
        : "";
  const staged = workspace.assets.filter((asset) => asset.path.startsWith("canvas/staging/"));
  return (
    <div className="gs-unity-page">
      <section className="gs-card">
        <header>
          <h2>Unity project</h2>
          {workspace.unityVersion && (
            <span className="gs-badge">Unity {workspace.unityVersion}</span>
          )}
        </header>
        <code className="gs-path">{game.rootPath}</code>
        <div className="gs-toolbar">
          <FileLink target={{ kind: "host", hostId: game.hostId, path: game.rootPath }}>
            Open folder in BB
          </FileLink>
          {!workspace.unityVersion && (
            <>
              <span
                className={
                  creationRequest?.status === "failed"
                    ? "gs-danger"
                    : creationRequest?.status === "uncertain"
                      ? "gs-warning"
                      : "gs-muted"
                }
              >
                {creationRequest?.status === "queued" || creationRequest?.status === "running"
                  ? "Creating via agent…"
                  : creationRequest?.status === "failed"
                    ? "Unity project creation failed."
                    : creationRequest?.status === "uncertain"
                      ? "Unity project creation needs verification."
                      : "Unity project files have not been found yet."}
              </span>
              {creationRequest?.detail && (
                <span className="gs-muted">{creationRequest.detail}</span>
              )}
              {creationRequest ? (
                <button onClick={() => navigate.toThread(creationRequest.threadId)}>
                  View in thread
                </button>
              ) : (
                <button onClick={() => onRequest("new-unity")}>Create with agent</button>
              )}
            </>
          )}
        </div>
      </section>
      <section className="gs-card">
        <header>
          <h2>Editor</h2>
          <button
            className="gs-icon"
            aria-label="Refresh Editors"
            title="Refresh Editors"
            onClick={() => void editors.refetch()}
          >
            <Icon name="RefreshCw" />
          </button>
        </header>
        {editors.isPending && <p className="gs-muted">Checking Editors on this machine…</p>}
        {editors.error && (
          <div className="gs-notice" role="alert">
            Editor discovery is unavailable: {editors.error.message}
            <p>The agent can discover and claim an Editor with the Unity tools.</p>
          </div>
        )}
        {!editors.isPending && !editors.error && !instances.length && (
          <p className="gs-muted">
            No Editor is open for this project. Open it in Unity, or ask the agent to launch it.
          </p>
        )}
        {instances.map((instance) => {
          const claim = editors.data?.claims.find((item) => item.instance.id === instance.id);
          return (
            <div className="gs-editor-row" key={instance.id}>
              <div>
                <strong>{instance.clone ? "MPPM client" : "Main Editor"}</strong>
                <span className="gs-muted">
                  PID {instance.pid} · {instance.version}
                </span>
              </div>
              <div>
                {claim ? (
                  <>
                    <span
                      className={
                        claim.ownerThreadId !== game.threadId ||
                        claim.jobId === "uncertain" ||
                        claim.orphaned
                          ? "gs-warning"
                          : "gs-success"
                      }
                    >
                      {claim.mode} ·{" "}
                      {claim.jobId === "uncertain"
                        ? "uncertain — reconcile needed"
                        : claim.jobId
                          ? "job running"
                          : "idle"}
                    </span>
                    <button onClick={() => navigate.toThread(claim.ownerThreadId)}>
                      Owner: {claim.ownerThreadId}
                    </button>
                    {claim.ownerThreadId !== game.threadId && (
                      <small className="gs-muted">Claims cannot be taken over.</small>
                    )}
                  </>
                ) : (
                  <span className="gs-muted">Available to claim</span>
                )}
              </div>
            </div>
          );
        })}
        {editors.data?.warnings.map((warning) => (
          <p className="gs-warning" key={warning}>
            {warning}
          </p>
        ))}
        {missingEditor && (
          <p className="gs-warning">
            The claimed Editor is no longer running. Ask the agent to verify recovery before
            reconnecting.
          </p>
        )}
        {blockedReason && <p className="gs-warning">{blockedReason}</p>}
        <div className="gs-toolbar">
          <button disabled={Boolean(otherOwner)} onClick={() => onRequest("connect")}>
            <Icon name="Plug" />
            {uncertain
              ? "Ask agent to reconcile"
              : missingEditor
                ? "Ask agent to recover"
                : instances.length
                  ? "Connect Editor with agent"
                  : "Ask agent to open Editor"}
          </button>
        </div>
      </section>
      <section className="gs-card">
        <h2>Build with your agent</h2>
        <p className="gs-muted">
          Requests use the game-dev workflow. The agent claims the exact Editor before control and
          waits for Pipeline jobs before releasing it.
        </p>
        <div className="gs-action-grid">
          <button onClick={() => onRequest("design")}>
            <Icon name="FileText" />
            <strong>Develop design</strong>
            <span>Shape the core loop and asset plan</span>
          </button>
          <button disabled={Boolean(blockedReason)} onClick={() => onRequest("build")}>
            <Icon name="Hammer" />
            <strong>Implement in Unity</strong>
            <span>Use the design, canvas, and real assets</span>
          </button>
          <button
            disabled={Boolean(blockedReason) || instances.length === 0}
            onClick={() => onRequest("playtest")}
          >
            <Icon name="Play" />
            <strong>Playtest</strong>
            <span>
              {blockedReason ||
                (instances.length
                  ? "Exercise controls and capture evidence"
                  : "Needs a running Editor")}
            </span>
          </button>
        </div>
      </section>
      <section className="gs-card">
        <header>
          <h2>Ready for import</h2>
          <span className="gs-badge">{staged.length} staged</span>
        </header>
        <p className="gs-muted">
          Files in canvas/staging stay outside Assets until the agent verifies and imports them
          under an authoring claim.
        </p>
        {staged.length > 0 && (
          <>
            <ul className="gs-file-list">
              {staged.slice(0, 8).map((asset) => (
                <li key={asset.id}>
                  <span>{asset.name}</span>
                  <code>{asset.path}</code>
                </li>
              ))}
            </ul>
            <div className="gs-toolbar">
              <button
                disabled={Boolean(blockedReason) || instances.length === 0}
                onClick={() => onRequest("import")}
              >
                Ask agent to import
              </button>
              {staged.length > 8 && (
                <button onClick={onOpenAssets}>View all {staged.length} in Assets</button>
              )}
              {(blockedReason || instances.length === 0) && (
                <small className="gs-muted">{blockedReason || "Needs a running Editor"}</small>
              )}
            </div>
          </>
        )}
      </section>
      <section className="gs-card">
        <h2>Recent Unity requests</h2>
        {workspace.requests.length ? (
          workspace.requests.slice(0, 5).map((request) => (
            <div className="gs-editor-row" key={request.id}>
              <div>
                <strong>{requestLabels[request.action]}</strong>
                <time
                  className="gs-muted"
                  dateTime={new Date(request.createdAt).toISOString()}
                  title={new Date(request.createdAt).toLocaleString()}
                >
                  {ago(request.createdAt)}
                </time>
                {request.detail && <span className="gs-muted">{request.detail}</span>}
              </div>
              <div>
                <span
                  className={`gs-badge ${request.status === "failed" ? "gs-danger" : request.status === "uncertain" ? "gs-warning" : request.status === "done" ? "gs-success" : ""}`}
                >
                  {requestStatusLabels[request.status]}
                </span>
                <button onClick={() => navigate.toThread(request.threadId)}>View in thread</button>
              </div>
            </div>
          ))
        ) : (
          <p className="gs-muted">Requests sent to your agent will appear here.</p>
        )}
      </section>
    </div>
  );
}
