// Studio layout adapted from OhMyGame; modified for BB and Unity. Apache-2.0.
import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useComposer,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginNavPanelProps,
  PluginThreadPanelProps,
  PluginNewThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { rpc } from "./rpc.ts";
import { selectGameCheckout, selectGameRequestCheckout } from "./game-checkout-selection.ts";
import { ConnectDialog } from "./connect.tsx";
import type { GenerationRecipe, Game } from "../shared/schema.ts";
import type { AgentSelection } from "../shared/generation.ts";
import { REQUEST_MENTION_PROVIDER } from "../shared/request-mention.ts";
import { StudioCanvas } from "./canvas.tsx";
import { DesignEditor, AssetLibrary, Evidence } from "./views.tsx";
import { UnityPanel, useUnityEditors, editorLabel } from "./unity.tsx";
import { UnitySlotInputs } from "./unity-slot-inputs.tsx";
import { Icon, Joystick } from "./icons.tsx";
import "./studio.css";

type Tab = "unity" | "design" | "canvas" | "assets" | "evidence";
const tabs: { id: Tab; title: string; icon: string }[] = [
  { id: "unity", title: "Unity", icon: "Boxes" },
  { id: "design", title: "Design", icon: "FileText" },
  { id: "canvas", title: "Canvas", icon: "Workflow" },
  { id: "assets", title: "Assets", icon: "Layers" },
  { id: "evidence", title: "Evidence", icon: "Camera" },
];
function lastTab(gameId: string): Tab {
  try {
    return (
      tabs.find((entry) => entry.id === localStorage.getItem(`game-studio:last-tab:${gameId}`))
        ?.id ?? "unity"
    );
  } catch {
    return "unity";
  }
}
export type StudioAction =
  | "design"
  | "build"
  | "asset"
  | "playtest"
  | "connect"
  | "import"
  | "new-unity";
const panelActionId = "studio";
/** Used when the composer reports no agent, as on surfaces outside a composer. */
const fallbackAgent: AgentSelection = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "high",
};
const StudioLocation = createContext<(gameId?: string, tab?: Tab) => void>(() => {});
let pendingOpen: { game: Game; threadId: string | null } | null = null;

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="gs-notice" role="alert">
      {children}
    </div>
  );
}
export function Empty({
  icon = "Joystick",
  title,
  children,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="gs-empty">
      <Icon name={icon} />
      <h2>{title}</h2>
      {children}
    </div>
  );
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// This runs in BB's real composer. It never renders a timeline or submits a message.
function NativeComposerBridge() {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const [error, setError] = useState("");
  const scope = composer.scope;
  const scopeKey = scope.kind === "thread" ? scope.threadId : scope.kind;
  useEffect(() => {
    const pending = pendingOpen;
    if (
      !pending ||
      (pending.threadId
        ? scope.kind !== "thread" || scope.threadId !== pending.threadId
        : scope.kind !== "new-thread")
    )
      return;
    if (!navigate.openThreadPanel({ actionId: panelActionId, params: { gameId: pending.game.id } }))
      return;
    pendingOpen = null;
    if (scope.kind === "new-thread") {
      void selectGameCheckout(composer, pending.game).catch((cause) => setError(message(cause)));
    }
  }, [composer, navigate, scopeKey, scope]);
  return error ? <Notice>{error}</Notice> : null;
}

function Gallery() {
  const overview = rpc.overview.useQuery({}, { refetchInterval: 15_000 });
  const openGame = useContext(StudioLocation);
  const [search, setSearch] = useState("");
  const [connect, setConnect] = useState<"connect" | "new" | null>(null);
  const games =
    overview.data?.games.filter((game) => game.name.toLowerCase().includes(search.toLowerCase())) ??
    [];
  return (
    <main className="gs-app gs-gallery">
      <header className="gs-gallery-header">
        <div>
          <h1>Game Studio</h1>
          <p className="gs-muted">Your Unity project, design, and agent in one workspace.</p>
        </div>
        <div className="gs-toolbar">
          <label className="gs-search">
            <Icon name="Search" />
            <input
              aria-label="Search games"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects"
            />
          </label>
          <button
            onClick={() => setConnect("new")}
            disabled={!overview.data?.hosts.some((h) => h.online)}
          >
            New Unity project
          </button>
          <button
            className="gs-primary"
            onClick={() => setConnect("connect")}
            disabled={!overview.data?.hosts.some((h) => h.online)}
          >
            <Icon name="Plus" />
            Connect Unity project
          </button>
        </div>
      </header>
      {overview.error && (
        <Notice>
          {overview.error.message}
          <button onClick={() => void overview.refetch()}>Retry</button>
        </Notice>
      )}
      {overview.isPending ? (
        <Empty title="Loading your projects…" />
      ) : (
        <div className="gs-project-grid">
          <button
            className="gs-new-card"
            onClick={() => setConnect("connect")}
            disabled={!overview.data?.hosts.some((h) => h.online)}
          >
            <Icon name="Plus" />
            <span>Connect Unity project</span>
          </button>
          {games.map((game) => (
            <button key={game.id} className="gs-project-card" onClick={() => openGame(game.id)}>
              <div className="gs-cover">
                <Icon name="Boxes" />
              </div>
              <strong>{game.name}</strong>
              <span className="gs-muted">
                {game.kind === "unity" ? "Unity" : game.kind} ·{" "}
                {new Date(game.createdAt).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      )}
      {overview.data && !overview.data.hosts.some((h) => h.online) && (
        <Notice>Connect a BB machine to open a Unity project.</Notice>
      )}
      {search && !games.length && <Empty title="No projects match your search" />}
      {connect && overview.data && (
        <ConnectDialog
          hosts={overview.data.hosts}
          initialMode={connect}
          onClose={() => setConnect(null)}
          onCreated={(game) => openGame(game.id, "unity")}
        />
      )}
    </main>
  );
}

function Workbench({ gameId, tab }: { gameId: string; tab: Tab }) {
  const client = rpc.useClient();
  const query = rpc.get.useQuery(
    { gameId },
    {
      refetchInterval: (current) =>
        current.state.data?.generationJobs?.some((job) =>
          ["queued", "running"].includes(job.status),
        )
          ? 2000
          : 10_000,
      retry: false,
    },
  );
  const openGame = useContext(StudioLocation);
  const composer = useComposer();
  // Text and review nodes start on the composer's agent; each node's composer can change it.
  const [defaultAgent, setDefaultAgent] = useState<AgentSelection>(fallbackAgent);
  useEffect(() => {
    let live = true;
    const resolve = async () => {
      const { providerId, model, reasoningLevel, serviceTier } = await composer
        .experimental_setSelection({})
        // Surfaces outside a composer keep the fallback agent.
        .catch(() => ({}) as Awaited<ReturnType<typeof composer.experimental_setSelection>>);
      if (!live || !providerId || !model) return;
      const next: AgentSelection = {
        providerId,
        model,
        reasoningLevel: reasoningLevel ?? fallbackAgent.reasoningLevel,
        ...(serviceTier ? { serviceTier } : {}),
      };
      setDefaultAgent((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    };
    void resolve();
    return () => {
      live = false;
    };
  }, [composer]);
  const [visitedTabs, setVisitedTabs] = useState(() => new Set<Tab>([tab]));
  useEffect(() => {
    setVisitedTabs((previous) => (previous.has(tab) ? previous : new Set([...previous, tab])));
    try {
      localStorage.setItem(`game-studio:last-tab:${gameId}`, tab);
    } catch {
      /* Storage may be unavailable. */
    }
  }, [gameId, tab]);
  const [error, setError] = useState("");
  const [boardId, setBoardId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [canvasStatus, setCanvasStatus] = useState("saved");
  const [boardDialog, setBoardDialog] = useState(false);
  const [boardName, setBoardName] = useState("");
  const [addingBoard, setAddingBoard] = useState(false);
  const previewQuery = rpc.preview.useQuery(
    { gameId },
    {
      enabled: ["assets", "evidence", "canvas"].includes(tab),
      staleTime: 45 * 60_000,
      refetchInterval: 45 * 60_000,
      retry: false,
    },
  );
  const lease = previewQuery.data ?? null;
  const upload = useRef<HTMLInputElement>(null);
  const editors = useUnityEditors(query.data?.game.hostId);
  const request = useCallback(
    async (
      action: StudioAction,
      nodeId?: string,
      recipe?: GenerationRecipe,
      target?:
        | { assetId: string }
        | { boardId: string }
        | { documentId: string; experimentId?: string },
    ) => {
      setError("");
      try {
        const input = {
          gameId,
          action,
          nodeId,
          recipe,
          ...target,
        };
        const game = query.data?.game;
        if (!game) throw new Error("Project unavailable. Reload the workspace.");
        if (composer.scope.kind === "thread") {
          // The server verifies the main thread's project, host, and exact checkout.
          await client.updateGame({ gameId, threadId: composer.scope.threadId });
        } else if (composer.scope.kind === "new-thread") {
          await selectGameRequestCheckout(composer, game, (input) =>
            client.listUnityEditors(input),
          );
        } else throw new Error("Open Studio beside the main BB thread to prepare a request.");
        const result = await client.prompt(input);
        composer.updateText((current) =>
          current.trim() ? `${current}\n\n${result.prompt}` : result.prompt,
        );
        composer.insertMention({
          provider: REQUEST_MENTION_PROVIDER,
          id: JSON.stringify({ ...input, request: result.request }),
          label: `Game Studio · ${action}`,
        });
        composer.focus();
      } catch (cause) {
        setError(message(cause));
      }
    },
    [client, gameId, composer, query.data?.game],
  );
  const ensurePreview = useCallback(async () => {
    try {
      const result = await previewQuery.refetch();
      if (result.error) throw result.error;
      return result.data ?? null;
    } catch (cause) {
      setError(message(cause));
      return null;
    }
  }, [previewQuery]);
  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);
  if (query.isPending)
    return (
      <main className="gs-app">
        <Empty title="Opening the studio…" />
      </main>
    );
  if (!query.data)
    return (
      <main className="gs-app">
        <Notice>
          {query.error?.message ?? "Project unavailable"}
          <button onClick={() => void query.refetch()}>Retry</button>
        </Notice>
        <button onClick={() => openGame()}>All projects</button>
      </main>
    );
  const workspace = query.data;
  const board = workspace.boards.find((entry) => entry.board.id === boardId) ?? workspace.boards[0];
  const go = (next: Tab) => {
    setVisitedTabs((previous) => new Set([...previous, next]));
    openGame(gameId, next);
  };
  const saveBoard = async (next: NonNullable<typeof board>["board"], expectedRevision: string) => {
    // Refetch even after a conflict: the canvas rebases its draft onto the newer board.
    try {
      return await client.saveBoard({ gameId, board: next, revision: expectedRevision });
    } finally {
      await refetch();
    }
  };
  const onUpload = async (file: File) => {
    setError("");
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error(
          "Stage files up to 10 MiB here. Ask the agent to stage larger models or recordings.",
        );
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 8192)
        binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
      await client.uploadAsset({ gameId, name: file.name, content: btoa(binary) });
      await refetch();
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <main className="gs-app gs-workbench">
      <div className="gs-workspace">
        <section className="gs-viewer">
          <div className="gs-project-context">
            <Icon name="Boxes" />
            <strong className="gs-truncate" title={workspace.game.name}>
              {workspace.game.name}
            </strong>
            <span className="gs-spacer" />
            <button
              className="gs-editor-chip"
              onClick={() => go("unity")}
              title="Unity Editor status"
            >
              <span className="gs-status-dot" />
              <span className="gs-truncate">
                {editorLabel(editors.data, workspace.game, workspace.game.threadId)}
              </span>
            </button>
            <button
              className="gs-icon"
              aria-label="Refresh workspace"
              title="Refresh workspace"
              onClick={() => void refetch()}
            >
              <Icon name="RefreshCw" />
            </button>
          </div>
          <header className="gs-pane-header">
            <button
              className="gs-icon"
              aria-label="All projects"
              title="All projects"
              onClick={() => openGame()}
            >
              <Icon name="ArrowLeft" />
            </button>
            <nav className="gs-tabs" aria-label="Studio views">
              {tabs.map((item) => (
                <button
                  key={item.id}
                  aria-current={tab === item.id ? "page" : undefined}
                  onClick={() => go(item.id)}
                  title={item.title}
                  aria-label={item.title}
                >
                  <Icon name={item.icon} />
                  <span>{item.title}</span>
                </button>
              ))}
            </nav>
            <span className="gs-spacer" />
            {tab === "canvas" && (
              <output className="gs-save-state">
                {canvasStatus === "error"
                  ? "Could not save. Draft kept."
                  : canvasStatus === "dirty"
                    ? "Saving…"
                    : canvasStatus === "saving"
                      ? "Saving…"
                      : "Saved"}
              </output>
            )}
          </header>
          {error && <Notice>{error}</Notice>}
          {query.error && (
            <Notice>
              Could not refresh. Local drafts kept. {query.error.message}
              <button onClick={() => void refetch()}>Retry refresh</button>
            </Notice>
          )}
          <div className="gs-content">
            {tab === "unity" && (
              <UnityPanel
                workspace={workspace}
                editors={editors}
                onRequest={(action) => void request(action)}
              />
            )}
            {(visitedTabs.has("design") || tab === "design") && (
              <div className="gs-tab-panel" hidden={tab !== "design"}>
                <DesignEditor
                  workspace={workspace}
                  selectedId={documentId}
                  onSelect={setDocumentId}
                  onRefresh={refetch}
                  onRequest={(id) =>
                    void request(
                      "design",
                      undefined,
                      undefined,
                      id ? { documentId: id } : undefined,
                    )
                  }
                />
              </div>
            )}
            {(visitedTabs.has("canvas") || tab === "canvas") && (
              <div className="gs-canvas-view" hidden={tab !== "canvas"}>
                <div className="gs-board-picker">
                  <Icon name="Layers" />
                  <select
                    aria-label="Canvas board"
                    disabled={canvasStatus === "saving"}
                    value={board?.board.id ?? ""}
                    onChange={(e) => {
                      // A pending draft saves as the canvas leaves; only a failing save can lose it.
                      if (
                        canvasStatus === "error" &&
                        !window.confirm("This board could not be saved. Switch boards anyway?")
                      )
                        return;
                      setBoardId(e.target.value);
                      setCanvasStatus("saved");
                    }}
                  >
                    {workspace.index.boards.map((entry) => (
                      <option value={entry.id} key={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="gs-icon"
                    aria-label="New board"
                    onClick={() => setBoardDialog(true)}
                  >
                    <Icon name="Plus" />
                  </button>
                </div>
                {board ? (
                  <StudioCanvas
                    gameId={gameId}
                    hostId={workspace.game.hostId}
                    defaultAgent={defaultAgent}
                    key={`${gameId}:${board.board.id}`}
                    active={tab === "canvas"}
                    board={board.board}
                    revision={board.revision}
                    documents={workspace.documents}
                    assets={workspace.assets}
                    generationJobs={workspace.generationJobs}
                    previewBaseUrl={lease?.baseUrl}
                    onSave={saveBoard}
                    onGenerate={(nodeId, recipe) =>
                      void request("asset", nodeId, recipe, { boardId: board.board.id })
                    }
                    onGenerateDirect={async (nodeId, revision, requestId, model, brief, agent) => {
                      const selection =
                        agent ??
                        (model.provider === "bb"
                          ? await composer.experimental_setSelection({})
                          : undefined);
                      await client.generateCanvas({
                        gameId,
                        boardId: board.board.id,
                        nodeId,
                        revision,
                        requestId,
                        threadId: composer.scope.kind === "thread" ? composer.scope.threadId : null,
                        model: selection?.model ? { ...model, id: selection.model } : model,
                        ...(selection?.providerId ? { textProviderId: selection.providerId } : {}),
                        ...(agent?.reasoningLevel ? { reasoningLevel: agent.reasoningLevel } : {}),
                        ...(agent?.serviceTier ? { serviceTier: agent.serviceTier } : {}),
                        ...(brief ? { brief } : {}),
                      });
                      await refetch();
                    }}
                    onGenerationControl={async (jobId, action) => {
                      const result = await client.canvasGenerationStatus({
                        gameId,
                        jobId,
                        action,
                        threadId: composer.scope.kind === "thread" ? composer.scope.threadId : null,
                      });
                      await refetch();
                      return { missing: result.job === null };
                    }}
                    onOpenDocument={(id) => {
                      setDocumentId(id);
                      go("design");
                    }}
                    onUpload={() => {
                      void ensurePreview();
                      upload.current?.click();
                    }}
                    onStatus={setCanvasStatus}
                  />
                ) : (
                  <Empty title="No board available" />
                )}
              </div>
            )}
            {tab === "assets" && (
              <AssetLibrary
                workspace={workspace}
                lease={lease}
                onLease={ensurePreview}
                onUpload={() => upload.current?.click()}
                onImport={(assetId) => void request("import", undefined, undefined, { assetId })}
              />
            )}
            {tab === "evidence" && (
              <Evidence
                workspace={workspace}
                lease={lease}
                onLease={ensurePreview}
                onPlaytest={() => void request("playtest")}
                onOpenDocument={(id) => {
                  setDocumentId(id);
                  go("design");
                }}
                onPlaytestExperiment={(experiment) =>
                  void request("playtest", undefined, undefined, {
                    documentId: experiment.documentId,
                    experimentId: experiment.experimentId,
                  })
                }
              />
            )}
          </div>
        </section>
      </div>
      <input
        type="file"
        aria-label="Stage a game asset"
        hidden
        ref={upload}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onUpload(file);
          event.target.value = "";
        }}
      />
      {boardDialog && (
        <dialog
          ref={(node) => {
            if (node && !node.open) node.showModal();
          }}
          className="gs-dialog"
          aria-label="New board"
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (addingBoard) return;
              setAddingBoard(true);
              try {
                await client.createBoard({ gameId, name: boardName });
                await refetch();
                setBoardDialog(false);
                setBoardName("");
              } catch (cause) {
                setError(message(cause));
              } finally {
                setAddingBoard(false);
              }
            }}
          >
            <h2>New board</h2>
            <label>
              Name
              <input required value={boardName} onChange={(e) => setBoardName(e.target.value)} />
            </label>
            <footer>
              <button type="button" onClick={() => setBoardDialog(false)} disabled={addingBoard}>
                Cancel
              </button>
              <button type="submit" className="gs-primary" disabled={addingBoard}>
                {addingBoard ? "Creating…" : "Create board"}
              </button>
            </footer>
          </form>
        </dialog>
      )}
    </main>
  );
}

function StudioPanel({
  threadId,
  params,
  projectId,
}: {
  threadId?: string;
  params?: PluginThreadPanelProps["params"];
  projectId?: string | null;
}) {
  const overview = rpc.overview.useQuery({}, { refetchInterval: 15_000 });
  const sidebar = useSidebarThreads();
  const thread = sidebar.threads.find((item) => item.id === threadId);
  const paramGame =
    params &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    typeof params.gameId === "string"
      ? params.gameId
      : undefined;
  const matchingGame =
    overview.data?.games.find(
      (game) => game.threadId === threadId || (thread && sameCheckout(game, thread)),
    ) ?? overview.data?.games.find((game) => game.projectId === projectId);
  const [location, setLocation] = useState<{ gameId?: string; tab?: Tab } | null>(
    paramGame ? { gameId: paramGame } : null,
  );
  const gameId = location ? location.gameId : matchingGame?.id;
  const tab = location?.tab ?? (gameId ? lastTab(gameId) : "unity");
  const openGame = useCallback(
    (id?: string, next?: Tab) => setLocation({ gameId: id, tab: next }),
    [],
  );
  return (
    <StudioLocation.Provider value={openGame}>
      {gameId ? <Workbench key={gameId} gameId={gameId} tab={tab} /> : <Gallery />}
    </StudioLocation.Provider>
  );
}
function ThreadStudio(props: PluginThreadPanelProps) {
  return (
    <PluginQueryBoundary>
      <StudioPanel key={props.threadId} {...props} />
    </PluginQueryBoundary>
  );
}
function NewThreadStudio(props: PluginNewThreadPanelProps) {
  return (
    <PluginQueryBoundary>
      <StudioPanel {...props} />
    </PluginQueryBoundary>
  );
}
function sameCheckout(game: Game, thread: ReturnType<typeof useSidebarThreads>["threads"][number]) {
  const normalize = (path: string) => {
    const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
    return /^(?:[A-Za-z]:\/|\/\/)/.test(value) ? value.toLowerCase() : value;
  };
  return (
    thread.projectId === game.projectId &&
    thread.host?.id === game.hostId &&
    !!thread.environment?.path &&
    normalize(thread.environment.path) === normalize(game.rootPath)
  );
}
function StudioLauncher({ subPath }: PluginNavPanelProps) {
  const client = rpc.useClient();
  const sidebar = useSidebarThreads();
  const navigate = useBbNavigate();
  const [error, setError] = useState("");
  const open = useCallback(
    async (gameId?: string) => {
      if (!gameId) return;
      try {
        const { game } = await client.get({ gameId });
        const thread = sidebar.threads.find(
          (item) =>
            item.id === game.threadId &&
            !item.isArchived &&
            !item.isHidden &&
            sameCheckout(game, item),
        );
        pendingOpen = { game, threadId: thread?.id ?? null };
        if (thread) navigate.toThread(thread.id);
        else navigate.toCompose({ focusPrompt: true });
      } catch (cause) {
        setError(message(cause));
      }
    },
    [client, sidebar.threads, navigate],
  );
  const requestedGame = subPath.split("/").find(Boolean);
  const opening = useRef(false);
  useEffect(() => {
    if (requestedGame && !opening.current) {
      opening.current = true;
      void open(requestedGame);
    }
  }, [requestedGame, open]);
  const openGame = useCallback((gameId?: string) => void open(gameId), [open]);
  return (
    <StudioLocation.Provider value={openGame}>
      {error && <Notice>{error}</Notice>}
      <Gallery />
    </StudioLocation.Provider>
  );
}
function StudioNavigation(props: PluginNavPanelProps) {
  return (
    <PluginQueryBoundary>
      <StudioLauncher {...props} />
    </PluginQueryBoundary>
  );
}
function StudioHeader() {
  const navigate = useBbNavigate();
  return (
    <button
      title="Open Game Studio in right sidebar"
      aria-label="Open Game Studio in right sidebar"
      onClick={() => navigate.openThreadPanel({ actionId: panelActionId })}
    >
      <Joystick width={16} height={16} />
    </button>
  );
}
export default definePluginApp((app) => {
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: "unity-rampage-slot",
    component: UnitySlotInputs,
  });
  app.composer.customize({
    id: "studio-native-composer",
    scopes: ["new-thread", "thread"],
    banners: [{ id: "studio-native-composer", chrome: "bare", component: NativeComposerBridge }],
  });
  app.experimental_icons.register({
    name: "game-studio/Joystick",
    component: (props) => <Joystick {...props} />,
  });
  app.slots.threadPanelAction({
    id: panelActionId,
    title: "Game Studio",
    icon: "Joystick",
    component: ThreadStudio,
    layout: "flush",
  });
  app.slots.experimental_newThreadPanelAction({
    id: panelActionId,
    title: "Game Studio",
    icon: "Joystick",
    component: NewThreadStudio,
    layout: "flush",
  });
  app.slots.experimental_threadHeaderAction({
    id: "studio",
    title: "Game Studio",
    component: StudioHeader,
  });
  app.slots.navPanel({
    id: "studio",
    title: "Game Studio",
    icon: "game-studio/Joystick",
    path: "studio",
    component: StudioNavigation,
  });
});
