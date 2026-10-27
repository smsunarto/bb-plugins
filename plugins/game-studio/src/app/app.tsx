import {
  APPROVAL_RENDERER,
  type Game,
  REQUEST_MENTION_PROVIDER,
} from "@argus-labs/game-studio-api";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import {
  definePluginApp,
  experimental_DetailRow as DetailRow,
  experimental_THREAD_INFO_ROW_GROUPS as THREAD_INFO_ROW_GROUPS,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useComposer,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalThreadActionTabProps,
  ExperimentalThreadInfoProps,
  PluginNavPanelProps,
  PluginNewThreadPanelProps,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { GenerationApproval } from "./generation-approval.tsx";
import { Joystick } from "./icons.tsx";
import { rpc } from "./rpc.ts";
import { StudioEmbed } from "./studio-embed.tsx";
import { studioRequests } from "./studio-requests.ts";
import { UnitySlotInputs } from "./unity-slot-inputs.tsx";
import "./app.css";

/*
 * Game Studio beside the thread. The studio is a web app; bb shows it in a panel, carries its
 * requests into the composer, answers its approval forms, and names the game a thread works on.
 */

const panelActionId = "studio";

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="gs-notice" role="alert">
      {children}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="gs-empty">
      <Joystick />
      <h2>{title}</h2>
      {children}
    </div>
  );
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const normalize = (path: string) => {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^(?:[A-Za-z]:\/|\/\/)/.test(value) ? value.toLowerCase() : value;
};
/** Whether a thread works in the game's checkout. */
export function sameCheckout(game: Game, thread: PluginSidebarThread) {
  const checkout = game.checkout;
  if (!checkout) return false;
  return (
    thread.projectId === checkout.projectId &&
    thread.host?.id === checkout.hostId &&
    !!thread.environment?.path &&
    normalize(thread.environment.path) === normalize(checkout.rootPath)
  );
}
/** The game a thread works on: the one naming it, else the one connected to its checkout. */
function threadGame(
  games: readonly Game[] | null | undefined,
  thread: PluginSidebarThread | undefined,
  threadId: string | undefined,
) {
  if (!games) return undefined;
  return (
    games.find((game) => threadId && game.threadId === threadId) ??
    (thread && games.find((game) => sameCheckout(game, thread)))
  );
}

// This runs in bb's real composer. It never renders a timeline or submits a message.
function StudioComposerBridge() {
  const composer = useComposer();
  const client = rpc.useClient();
  const overview = rpc.overview.useQuery({}, { staleTime: 15_000 });
  const [error, setError] = useState("");
  const scope = composer.scope;
  const scopeThread =
    scope.kind === "thread" ? scope.threadId : scope.kind === "new-thread" ? null : undefined;
  const loaded = overview.data !== undefined;
  const games = overview.data?.games;
  useEffect(() => {
    // A new thread needs the game's checkout, so requests wait for the games to load.
    if (scopeThread === undefined || !loaded) return;
    const carry = async () => {
      for (const { threadId, prompt, request, input } of studioRequests.take(scopeThread)) {
        setError("");
        try {
          const game = games?.find((entry) => entry.id === input.gameId);
          if (threadId) await client.nameThread({ gameId: input.gameId, threadId });
          else if (game?.checkout)
            await composer.setSelection({
              projectId: game.checkout.projectId,
              environment: {
                type: "host",
                hostId: game.checkout.hostId,
                workspace: { type: "unmanaged", path: game.checkout.rootPath },
              },
            });
          composer.insert(
            [
              prompt,
              " ",
              {
                provider: REQUEST_MENTION_PROVIDER,
                id: JSON.stringify({ ...input, request }),
                label: `Game Studio · ${input.action}`,
              },
              " ",
            ],
            { at: "end", block: true },
          );
          composer.focus();
        } catch (cause) {
          setError(message(cause));
        }
      }
    };
    void carry();
    return studioRequests.subscribe(() => void carry());
  }, [scopeThread, loaded, composer, client, games]);
  return error ? <Notice>{error}</Notice> : null;
}

function StudioPanel({
  threadId,
  params,
  composer,
}: {
  threadId?: string;
  params?: ExperimentalThreadActionTabProps["params"];
  composer: boolean;
}) {
  const overview = rpc.overview.useQuery({}, { staleTime: 15_000 });
  const sidebar = useSidebarThreads();
  const thread = sidebar.threads.find((item) => item.id === threadId);
  const record = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const paramGame = typeof record.gameId === "string" ? record.gameId : undefined;
  if (overview.isPending)
    return (
      <main className="gs-app">
        <Empty title="Opening Game Studio…" />
      </main>
    );
  if (!overview.data)
    return (
      <main className="gs-app">
        <Notice>
          {overview.error?.message ?? "Game Studio is unavailable."}
          <button onClick={() => void overview.refetch()}>Retry</button>
        </Notice>
      </main>
    );
  const { studioUrl, games, error } = overview.data;
  const game =
    (paramGame && games?.find((entry) => entry.id === paramGame)) ||
    threadGame(games, thread, threadId);
  return (
    <>
      {error && (
        <Notice>
          Agent tools are off until the plugin&apos;s settings name the studio&apos;s Access service
          token. {error}
        </Notice>
      )}
      <StudioEmbed
        key={`${studioUrl}|${game?.id ?? ""}`}
        studioUrl={studioUrl}
        gameId={game?.id ?? null}
        threadId={threadId ?? null}
        composer={composer}
        title={game?.name ?? "Game Studio"}
      />
    </>
  );
}
function ThreadStudio(props: ExperimentalThreadActionTabProps) {
  return (
    <PluginQueryBoundary>
      <StudioPanel key={props.threadId} threadId={props.threadId} params={props.params} composer />
    </PluginQueryBoundary>
  );
}
function NewThreadStudio(props: PluginNewThreadPanelProps) {
  return (
    <PluginQueryBoundary>
      <StudioPanel params={props.params} composer />
    </PluginQueryBoundary>
  );
}
/** The sidebar entry: the studio without a composer, at `studio` or `studio/<gameId>`. */
function StudioNavigation({ subPath }: PluginNavPanelProps) {
  const gameId = subPath.split("/").find(Boolean);
  const overview = rpc.overview.useQuery({}, { staleTime: 15_000 });
  if (overview.isPending)
    return (
      <main className="gs-app">
        <Empty title="Opening Game Studio…" />
      </main>
    );
  if (!overview.data)
    return (
      <main className="gs-app">
        <Notice>
          {overview.error?.message ?? "Game Studio is unavailable."}
          <button onClick={() => void overview.refetch()}>Retry</button>
        </Notice>
      </main>
    );
  const game = gameId ? overview.data.games?.find((entry) => entry.id === gameId) : undefined;
  return (
    <StudioEmbed
      key={`${overview.data.studioUrl}|${game?.id ?? gameId ?? ""}`}
      studioUrl={overview.data.studioUrl}
      gameId={game?.id ?? gameId ?? null}
      threadId={null}
      composer={false}
      title={game?.name ?? "Game Studio"}
    />
  );
}
function StudioNavigationBoundary(props: PluginNavPanelProps) {
  return (
    <PluginQueryBoundary>
      <StudioNavigation {...props} />
    </PluginQueryBoundary>
  );
}
/** The Info tab names the game a thread works on and opens it in Studio. */
function StudioInfoRow({ threadId }: ExperimentalThreadInfoProps) {
  const overview = rpc.overview.useQuery({}, { staleTime: 15_000 });
  const sidebar = useSidebarThreads();
  const navigate = useBbNavigate();
  const thread = sidebar.threads.find((item) => item.id === threadId);
  const game = threadGame(overview.data?.games, thread, threadId);
  if (!game) return null;
  return (
    <DetailRow icon="Joystick" label="Game">
      <button
        type="button"
        className="gs-info-link gs-truncate"
        title={`Open ${game.name} in Game Studio`}
        onClick={() =>
          navigate.openThreadPanel({ actionId: panelActionId, params: { gameId: game.id } })
        }
      >
        {game.name}
      </button>
    </DetailRow>
  );
}
function ThreadInfoStudio(props: ExperimentalThreadInfoProps) {
  return (
    <PluginQueryBoundary>
      <StudioInfoRow {...props} />
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
  app.slots.pendingInteraction({ id: APPROVAL_RENDERER, component: GenerationApproval });
  app.composer.customize({
    id: "studio-native-composer",
    scopes: ["new-thread", "thread"],
    banners: [{ id: "studio-native-composer", chrome: "bare", component: StudioComposerBridge }],
  });
  app.experimental_icons.register({
    name: "game-studio/Joystick",
    component: (props) => <Joystick {...props} />,
  });
  // Same id as before, so saved Studio tabs and layouts keep opening.
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
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
  app.slots.experimental_threadInfoRow({
    id: "studio-game",
    group: THREAD_INFO_ROW_GROUPS.environment,
    order: 40,
    component: ThreadInfoStudio,
  });
  app.slots.navPanel({
    id: "studio",
    title: "Game Studio",
    icon: "game-studio/Joystick",
    path: "studio",
    component: StudioNavigationBoundary,
  });
});
