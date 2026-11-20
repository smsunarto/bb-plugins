/**
 * The Overview tab beside a Captain thread: what needs you, the crew, and the
 * Drive, as stacked sections that collapse. Asks come from the banner's own
 * read, so an answer in either place updates both. Reads run only while the
 * tab shows; bb keeps a hidden tab mounted.
 */
import {
  Markdown,
  experimental_Icon as Icon,
  experimental_useSidebarThreads as useSidebarThreads,
  useRealtimeConnectionState,
  type PluginSidebarThreadIndicator,
  experimental_ProviderIcon as ProviderIcon,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_resolveThreadStatus as resolveThreadStatus,
  experimental_useAppPanel as useAppPanel,
  experimental_useCanOpenFileExternally as useCanOpenFileExternally,
  experimental_usePanelTabs as usePanelTabs,
  experimental_usePluginId as usePluginId,
  experimental_useProviders as useProviders,
  experimental_useRpcQuery as useRpcQuery,
  experimental_useTabVisible as useTabVisible,
  type ExperimentalThreadTabProps,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { age, isSending, orderQueue, type QueueItem } from "../contract/queue.ts";
import { captainContract, type CrewThreadItem, type DriveFileItem } from "../contract/rpc.ts";
import { ActionButton, OtherAnswer, TAP, itemActions, useItemCommands, useNow } from "./banner.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { Preview } from "./preview.tsx";

const NO_INPUT = {};
const NO_ACTIVITY = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 };

/** Shown only on a live Captain's thread: one shared, cached read of the Captain ids. */
export function useOverviewVisible({ threadId }: ExperimentalThreadTabProps): boolean {
  const captains = useRpcQuery({ contract: captainContract, method: "captains", input: NO_INPUT });
  return captains.data?.ids.includes(threadId) ?? false;
}

type SectionId = "needs" | "threads" | "drive";
type Collapsed = Record<SectionId, boolean>;
const OPEN: Collapsed = { needs: false, threads: false, drive: false };

export function OverviewTab({ threadId }: ExperimentalThreadTabProps) {
  const visible = useTabVisible();
  const input = useMemo(() => ({ captainId: threadId }), [threadId]);
  const asks = useRpcQuery({ contract: captainContract, method: "asks", input, enabled: visible });
  const crew = useRpcQuery({
    contract: captainContract,
    method: "crewThreads",
    input,
    enabled: visible,
  });
  const drive = useRpcQuery({
    contract: captainContract,
    method: "drive",
    input,
    enabled: visible,
  });
  const [collapsed, toggle] = useCollapsed(threadId);
  const now = useNow(asks.data?.items);
  // The banner's queue: its order, Later's hidden items left out, so both count alike.
  const asked = useMemo(
    () => (asks.data === undefined ? undefined : orderQueue(asks.data.items, now)),
    [asks.data, now],
  );
  const indicators = useCrewIndicators();
  const drived = drive.data;

  return (
    // bb's tab container clips; the tab scrolls itself.
    <div
      data-bb-plugin="captain"
      data-bb-plugin-scope-captain=""
      data-testid="captain-overview"
      className="h-full min-h-0 overflow-y-auto overscroll-contain"
    >
      <div className="flex min-w-0 flex-col gap-1.5 p-2 text-sm">
        <Section
          id="needs"
          title="Needs you"
          count={asked?.length}
          collapsed={collapsed.needs}
          onToggle={toggle}
        >
          <ReadState read={asks} rows={2}>
            {asked === undefined ? null : asked.length === 0 ? (
              <Empty>Nothing needs you.</Empty>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {asked.map((item) => (
                  <AskRow key={item.key} captainId={threadId} item={item} now={now} />
                ))}
              </ul>
            )}
          </ReadState>
        </Section>
        <Section
          id="threads"
          title="Threads"
          count={crew.data?.threads.length}
          collapsed={collapsed.threads}
          onToggle={toggle}
        >
          <ReadState read={crew} rows={3}>
            {crew.data === undefined ? null : crew.data.threads.length === 0 ? (
              <Empty>No crew yet. Dispatch a task to start one.</Empty>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {crew.data.threads.map((thread) => (
                  <CrewRow
                    key={thread.id}
                    thread={thread}
                    now={now}
                    indicator={indicators.get(thread.id) ?? null}
                  />
                ))}
              </ul>
            )}
          </ReadState>
        </Section>
        <Section
          id="drive"
          title="Drive"
          count={drived === undefined ? undefined : `${drived.total}${drived.truncated ? "+" : ""}`}
          collapsed={collapsed.drive}
          onToggle={toggle}
          action={<OpenDrive folder={drived?.folder ?? null} />}
        >
          <ReadState read={drive} rows={0} cards>
            {drived === undefined ? null : drived.files.length === 0 ? (
              <Empty>The Drive is empty.</Empty>
            ) : (
              <>
                <ul className={cn("m-0 list-none px-2 py-1", CARD_GRID)}>
                  {drived.files.map((file) => (
                    <DriveCard key={file.path} threadId={threadId} file={file} />
                  ))}
                </ul>
                <MoreInDrive
                  more={drived.total - drived.files.length}
                  truncated={drived.truncated}
                  folder={drived.folder}
                />
              </>
            )}
          </ReadState>
        </Section>
      </div>
    </div>
  );
}

/**
 * Cards share a row evenly: at least 7rem each, two to a ~300px panel. A phone
 * shows the tab full width, so cards there take 9rem: two columns, one on the
 * narrowest phones.
 */
const CARD_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] max-md:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2";

/**
 * bb's own status for each thread its sidebar lists, the indicator its rows
 * draw, by thread id. A crew thread the sidebar has not loaded falls back to
 * the row's own status (see CrewRow).
 */
function useCrewIndicators(): Map<string, PluginSidebarThreadIndicator> {
  const { threads } = useSidebarThreads();
  return useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread.indicator] as const)),
    [threads],
  );
}

type Read = {
  data: unknown;
  error: { message: string } | null;
  isFetching: boolean;
  refetch: () => Promise<void>;
};

/**
 * A section's read state around its content: a placeholder the loaded
 * content's size while it first loads, and a labelled line with Retry when
 * the read failed or the connection is down. Loaded rows stay visible under
 * a failed refresh or while offline, labelled as possibly out of date.
 */
function ReadState({
  read,
  rows,
  cards = false,
  children,
}: {
  read: Read;
  rows: number;
  cards?: boolean;
  children: ReactNode;
}) {
  const connection = useRealtimeConnectionState();
  const offline = !useBrowserOnline() || connection !== "connected";
  const loaded = read.data !== undefined;
  const problem = offline
    ? loaded
      ? "Offline · showing the last loaded"
      : "Offline · waiting for bb to reconnect"
    : read.error === null
      ? null
      : loaded
        ? `Couldn't refresh · ${read.error.message}`
        : `Couldn't load · ${read.error.message}`;
  return (
    <>
      {problem === null ? null : (
        <output
          className={cn(
            "flex min-w-0 items-center gap-2 px-2 py-1 text-xs",
            read.error !== null && !offline ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <span className="min-w-0 flex-1 truncate" title={problem}>
            {problem}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(TAP, "h-6 shrink-0 px-2")}
            disabled={read.isFetching}
            onClick={() => void read.refetch()}
          >
            {read.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </output>
      )}
      {loaded ? children : problem === null ? <Placeholder rows={rows} cards={cards} /> : null}
    </>
  );
}

/**
 * The browser's own online state. bb's socket can take seconds to notice a lost
 * network, and reads pause while the browser is offline, so either one counts.
 */
function useBrowserOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine);
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Which sections are collapsed, kept per thread in this browser. */
function useCollapsed(threadId: string): [Collapsed, (id: SectionId) => void] {
  const pluginId = usePluginId();
  const key = `${pluginId}:overview:${threadId}`;
  const [state, setState] = useState<{ key: string; collapsed: Collapsed }>(() => ({
    key,
    collapsed: readCollapsed(key),
  }));
  const collapsed = state.key === key ? state.collapsed : readCollapsed(key);
  const toggle = useCallback(
    (id: SectionId) => {
      const next = { ...collapsed, [id]: !collapsed[id] };
      setState({ key, collapsed: next });
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage refused: the state still holds for this session.
      }
    },
    [collapsed, key],
  );
  return [collapsed, toggle];
}

function readCollapsed(key: string): Collapsed {
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<Collapsed>;
    if (stored === null || typeof stored !== "object") return OPEN;
    return {
      needs: stored.needs === true,
      threads: stored.threads === true,
      drive: stored.drive === true,
    };
  } catch {
    return OPEN;
  }
}

function Section({
  id,
  title,
  count,
  collapsed,
  onToggle,
  action,
  children,
}: {
  id: SectionId;
  title: string;
  /** Undefined while loading: the space stays reserved, so nothing shifts. */
  count: number | string | undefined;
  collapsed: boolean;
  onToggle: (id: SectionId) => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const body = useId();
  return (
    <section aria-label={title} data-section={id} className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-h-8 min-w-0 items-center rounded-md bg-muted/60 pe-1 pointer-coarse:min-h-11">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={body}
          onClick={() => onToggle(id)}
          className={cn(
            TAP,
            "flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-start outline-none focus-visible:outline-1",
          )}
        >
          <span className="truncate font-medium text-foreground">{title}</span>
          <span
            className={cn("text-muted-foreground tabular-nums", count === undefined && "invisible")}
          >
            {count ?? 0}
          </span>
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronDown"}
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        </button>
        {action}
      </div>
      <div id={body} hidden={collapsed}>
        {collapsed ? null : children}
      </div>
    </section>
  );
}

/**
 * Which ask is open, per Captain. Kept outside the component: bb remounts a
 * panel tab when its layout changes, such as when its width crosses a
 * breakpoint, and an answer half-typed must not close under the user.
 */
const openAsks = new Map<string, string>();
const openListeners = new Set<() => void>();
function setOpenAsk(captainId: string, key: string | null): void {
  if (key === null) openAsks.delete(captainId);
  else openAsks.set(captainId, key);
  for (const listener of openListeners) listener();
}
function subscribeOpenAsks(listener: () => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}
/** An Other… answer being typed, per ask, so a remount keeps it. */
const otherDrafts = new Map<string, string>();
function useOpenAsk(captainId: string): string | null {
  return useSyncExternalStore(subscribeOpenAsks, () => openAsks.get(captainId) ?? null);
}

/** One ask; opening it shows the banner's answer controls in place, one ask at a time. */
function AskRow({ captainId, item, now }: { captainId: string; item: QueueItem; now: number }) {
  const open = useOpenAsk(captainId) === item.key;
  const setOpen = (next: boolean) => setOpenAsk(captainId, next ? item.key : null);
  const panel = useId();
  const sending = isSending(item);
  const title = item.kind === "ask" ? item.text : item.title;
  const kind = item.kind === "ask" ? item.askKind : item.kind;
  const sub = [item.task, sending ? "sending" : kind].filter(Boolean).join(" · ");
  return (
    <li className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className={cn(
          TAP,
          "flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-muted/40 focus-visible:outline-1",
        )}
      >
        <AskIcon item={item} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium break-words text-foreground [unicode-bidi:plaintext]">
            {title}
          </span>
          <span className="truncate text-xs text-muted-foreground" title={sub}>
            {sub}
          </span>
        </span>
        {item.since === null ? null : (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {age(now, item.since)}
          </span>
        )}
      </button>
      {open ? <Answer id={panel} captainId={captainId} item={item} /> : null}
    </li>
  );
}

/**
 * The banner's answer controls for one item: its detail, options, Other… and
 * any error, through the banner's own answer commands. Focus stays in the
 * panel when the button pressed goes away; Other… sends once and clears its
 * draft. Options carry no number shortcuts here: no key handler answers them.
 */
function Answer({ id, captainId, item }: { id: string; captainId: string; item: QueueItem }) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [other, setOtherState] = useState<string | null>(() => otherDrafts.get(item.key) ?? null);
  const setOther = (value: string | null) => {
    if (value === null) otherDrafts.delete(item.key);
    else otherDrafts.set(item.key, value);
    setOtherState(value);
  };
  const [error, setError] = useState<string | null>(null);
  const { answer, fail, pending } = useItemCommands(captainId, item.key, root, setError);
  const sending = isSending(item);
  const actions = sending ? [] : itemActions(item, { answer, navigate, sdk, fail });
  const detail = item.kind === "blocked" ? null : item.detail;
  return (
    <div
      id={id}
      ref={setRoot}
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-2 ps-8 pe-2 pb-2 text-xs outline-none"
      data-testid="captain-overview-answer"
    >
      {detail ? (
        <Markdown
          content={detail}
          className="min-w-0 text-xs leading-snug text-muted-foreground [--foreground:var(--muted-foreground)]"
        />
      ) : null}
      {other !== null && item.kind === "ask" && !sending ? (
        <OtherAnswer
          value={other}
          pending={pending}
          onChange={setOther}
          onCancel={() => {
            setOther(null);
            root?.focus();
          }}
          onSubmit={(text) => {
            root?.focus();
            setOther(null);
            answer(item.id, text);
          }}
        />
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {sending && item.kind === "ask" ? (
          <output className="text-muted-foreground">
            Answered {JSON.stringify(item.answer)} · Sending…
          </output>
        ) : null}
        {actions.map((action, index) => (
          <ActionButton key={action.label} action={action} index={index} shortcuts={false} />
        ))}
        {item.kind === "ask" && item.askKind !== "ship" && !sending && other === null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(TAP, "text-muted-foreground")}
            onClick={() => setOther("")}
          >
            Other…
          </Button>
        ) : null}
      </div>
      {error ? <p className="m-0 min-w-0 break-words text-destructive">{error}</p> : null}
    </div>
  );
}

function AskIcon({ item }: { item: QueueItem }) {
  const box = "mt-0.5 flex size-4 shrink-0 items-center justify-center";
  if (item.kind === "health") {
    return (
      <span className={box}>
        <Icon name="AlertTriangle" aria-hidden className="size-4 text-destructive" />
      </span>
    );
  }
  if (item.kind === "ask" && item.askKind === "access") {
    return (
      <span className={box}>
        <Icon name="Lock" aria-hidden className="size-4 text-warning-text" />
      </span>
    );
  }
  if (item.kind === "ask" && item.askKind === "ship") {
    return (
      <span className={box}>
        <Icon name="GitMerge" aria-hidden className="size-4 text-success-text" />
      </span>
    );
  }
  // A decision: a circled exclamation, drawn here so it never falls back to another glyph.
  return (
    <span className={box}>
      <svg viewBox="0 0 16 16" aria-hidden className="size-4 text-destructive">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.75v3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11" r="0.9" fill="currentColor" />
      </svg>
    </span>
  );
}

/**
 * One crew thread; it opens the thread. Its glyph is bb's own indicator when
 * the sidebar lists the thread, else one resolved from the thread's run state
 * (which cannot show background work or queued messages), else the provider.
 */
function CrewRow({
  thread,
  now,
  indicator: listed,
}: {
  thread: CrewThreadItem;
  now: number;
  indicator: PluginSidebarThreadIndicator | null;
}) {
  const navigate = useBbNavigate();
  const provider = useProviders().providers.find((each) => each.id === thread.providerId);
  const status = resolveThreadStatus({
    thread: {
      activity: NO_ACTIVITY,
      hasPendingInteraction: thread.hasPendingInteraction,
      isUnread: false,
      parentThreadId: null,
      queuedWork: "none",
      runtimeStatus: thread.status as never,
      status: thread.status as never,
    },
    hiddenThreads: [],
    hasUnsubmittedDraft: false,
    rowStatus: null,
  });
  const indicator = listed ?? status.indicator;
  const busy = status.isWorking || thread.hasPendingInteraction;
  const sub = [thread.model, thread.task, thread.role, age(now, thread.updatedAt)]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <li className="flex min-w-0">
      <button
        type="button"
        onClick={() => navigate.toThread(thread.id)}
        className={cn(
          TAP,
          "flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-muted/40 focus-visible:outline-1",
        )}
      >
        <span
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground"
          title={status.label ?? (thread.status === "error" ? "Errored" : undefined)}
          data-indicator={thread.status === "error" ? "error" : indicator}
        >
          {thread.status === "error" ? (
            <Icon name="AlertTriangle" aria-label="Errored" className="size-4 text-destructive" />
          ) : indicator !== "none" ? (
            <ThreadStatusGlyph indicator={indicator} size="compact" />
          ) : (
            <ProviderIcon
              providerKind="agent"
              provider={provider ?? { id: thread.providerId }}
              aria-hidden
              className="size-4"
            />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate [unicode-bidi:plaintext]",
              busy ? "text-foreground" : "text-muted-foreground",
            )}
            title={thread.title}
          >
            {thread.title}
          </span>
          {/* One line, cut at its end: a wrap would start a line with its separator. */}
          <span className="truncate text-xs text-muted-foreground tabular-nums" title={sub}>
            {sub}
          </span>
        </span>
      </button>
    </li>
  );
}

/** One Drive file as a clipped text preview; it opens the file. */
function DriveCard({ threadId, file }: { threadId: string; file: DriveFileItem }) {
  const navigate = useBbNavigate();
  const open = () =>
    navigate.experimental_openFilePreview({
      target: { kind: "thread-storage", threadId, path: file.path },
      location: null,
    });
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={open}
        aria-label={`Open ${file.path}`}
        className="flex w-full min-w-0 flex-col gap-1 rounded-md text-start outline-none hover:bg-muted/40 focus-visible:outline-1"
      >
        <span
          aria-hidden
          className="flex h-32 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background p-2"
        >
          {file.excerpt === null ? (
            <span className="flex h-full items-center justify-center text-muted-foreground">
              <Icon name="File" className="size-6" />
            </span>
          ) : file.excerpt.trim() === "" ? (
            <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Empty
            </span>
          ) : (
            <Preview markdown={file.excerpt} />
          )}
        </span>
        <span className="flex min-w-0 flex-col leading-snug">
          <span className="truncate text-sm text-foreground" title={file.name}>
            {file.name}
          </span>
          {file.folder === null ? null : (
            <span className="truncate text-xs text-muted-foreground" title={file.folder}>
              {file.folder}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * Opening the Drive folder: in this client's external file target when it
 * has one for the server's machine, otherwise bb's Info tab, whose Thread
 * storage row is the Drive. Null when neither is available.
 */
function useOpenDrive(
  folder: { hostId: string; path: string } | null,
): { label: string; run: () => void } | null {
  const navigate = useBbNavigate();
  const panel = useAppPanel();
  const tabs = usePanelTabs();
  const target = useMemo(
    () => ({ kind: "host" as const, hostId: folder?.hostId ?? "", path: folder?.path ?? "/" }),
    [folder?.hostId, folder?.path],
  );
  const external = useCanOpenFileExternally(target) && folder !== null;
  const info = tabs.tabs.find((tab) => tab.detail.kind === "info");
  if (external) {
    return {
      label: "Open the Drive folder",
      run: () => void navigate.experimental_openFileExternally({ target, location: null }),
    };
  }
  if (info === undefined) return null;
  return { label: "Show the Drive in Info", run: () => void panel.selectTab(info.key) };
}

/** ↗ in the Drive header; its space stays reserved while the Drive loads. */
function OpenDrive({ folder }: { folder: { hostId: string; path: string } | null }) {
  const open = useOpenDrive(folder);
  if (open === null) return <span aria-hidden className="size-6 shrink-0" />;
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={open.label}
      className={cn(TAP, "size-6 text-muted-foreground")}
      onClick={open.run}
    >
      <Icon name="ArrowUpRight" aria-hidden className="size-3.5" />
    </Button>
  );
}

/** What the cards leave out, opening the Drive where it can. */
function MoreInDrive({
  more,
  truncated,
  folder,
}: {
  more: number;
  truncated: boolean;
  folder: { hostId: string; path: string } | null;
}) {
  const open = useOpenDrive(folder);
  if (more <= 0 && !truncated) return null;
  const label = `${more}${truncated ? "+" : ""} more in the Drive`;
  return open === null ? (
    <p className="m-0 px-2 py-1 text-xs text-muted-foreground">{label}</p>
  ) : (
    <Button
      type="button"
      size="sm"
      variant="link"
      className={cn(TAP, "h-auto self-start px-2 py-1 text-xs text-muted-foreground")}
      aria-label={`${label}: ${open.label.toLowerCase()}`}
      onClick={open.run}
    >
      {label}
    </Button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">{children}</p>;
}

/** Space for rows or cards while they first load, about the loaded content's height. */
function Placeholder({ rows, cards = false }: { rows: number; cards?: boolean }) {
  return (
    <div aria-busy className="flex flex-col gap-1 px-2 py-1.5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-2 py-0.5">
          <span className="size-4 shrink-0 animate-pulse rounded bg-muted" />
          <span className="flex flex-1 flex-col gap-1">
            <span className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <span className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          </span>
        </div>
      ))}
      {cards ? (
        <div className={CARD_GRID}>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <span key={index} className="flex flex-col gap-1">
              <span className="h-32 animate-pulse rounded-md bg-muted" />
              <span className="h-4 w-1/2 animate-pulse rounded bg-muted" />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
