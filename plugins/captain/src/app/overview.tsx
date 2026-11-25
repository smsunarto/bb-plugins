/**
 * The Overview tab beside a Captain thread: what needs you, its tasks, its
 * routines and the Drive, as stacked sections that collapse. Asks come from the banner's own
 * read, so an answer in either place updates both. Reads run only while the
 * tab shows; bb keeps a hidden tab mounted.
 */
import {
  Markdown,
  experimental_Icon as Icon,
  useRealtimeConnectionState,
  experimental_useAppPanel as useAppPanel,
  experimental_useCanOpenFileExternally as useCanOpenFileExternally,
  experimental_usePanelTabs as usePanelTabs,
  experimental_usePluginId as usePluginId,
  experimental_useRpcQuery as useRpcQuery,
  experimental_useTabVisible as useTabVisible,
  type ExperimentalThreadTabProps,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { age, isSending, orderQueue, type QueueItem } from "../contract/queue.ts";
import { captainContract, type CaptainTaskItem, type DriveFileItem } from "../contract/rpc.ts";
import { ActionButton, OtherAnswer, TAP, itemActions, useItemCommands, useNow } from "./banner.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { Preview } from "./preview.tsx";
import { NewRoutineButton, RoutinesBody } from "./routines.tsx";

const NO_INPUT = {};

/** Shown only on a live Captain's thread: one shared, cached read of the Captain ids. */
export function useOverviewVisible({ threadId }: ExperimentalThreadTabProps): boolean {
  const captains = useRpcQuery({ contract: captainContract, method: "captains", input: NO_INPUT });
  return captains.data?.ids.includes(threadId) ?? false;
}

type SectionId = "needs" | "tasks" | "routines" | "drive";
type Collapsed = Record<SectionId, boolean>;
const OPEN: Collapsed = { needs: false, tasks: false, routines: false, drive: false };

export function OverviewTab({ threadId }: ExperimentalThreadTabProps) {
  const visible = useTabVisible();
  const input = useMemo(() => ({ captainId: threadId }), [threadId]);
  const asks = useRpcQuery({ contract: captainContract, method: "asks", input, enabled: visible });
  const tasks = useRpcQuery({
    contract: captainContract,
    method: "tasks",
    input,
    enabled: visible,
  });
  const routines = useRpcQuery({
    contract: captainContract,
    method: "routines",
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
  const scheduled = routines.data;
  const now = useNow(asks.data?.items);
  // The banner's queue: its order, Later's hidden items left out, so both count alike.
  const asked = useMemo(
    () => (asks.data === undefined ? undefined : orderQueue(asks.data.items, now)),
    [asks.data, now],
  );
  const listed = tasks.data;
  const drived = drive.data;

  return (
    // bb's tab container clips; the tab scrolls itself.
    <div
      data-bb-plugin="captain"
      data-bb-plugin-scope-captain=""
      data-testid="captain-overview"
      className="h-full min-h-0 overflow-y-auto overscroll-contain"
    >
      <div className="flex min-w-0 flex-col gap-3 p-2 text-sm leading-5">
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
          id="tasks"
          title="Tasks"
          count={listed === undefined ? undefined : `${listed.total}${listed.truncated ? "+" : ""}`}
          collapsed={collapsed.tasks}
          onToggle={toggle}
        >
          <ReadState
            read={tasks}
            rows={3}
            line
            partialProblem={listed?.crewError ? `Crew unavailable · ${listed.crewError}` : null}
          >
            {listed === undefined ? null : <TasksBody listing={listed} />}
          </ReadState>
        </Section>
        <Section
          id="routines"
          title="Routines"
          count={scheduled?.routines.length}
          collapsed={collapsed.routines}
          onToggle={toggle}
          action={
            <NewRoutineButton
              captainId={threadId}
              onOpen={() => collapsed.routines && toggle("routines")}
            />
          }
        >
          <ReadState read={routines} rows={1}>
            {scheduled === undefined ? null : (
              <RoutinesBody
                captainId={threadId}
                listing={scheduled}
                visible={visible}
                onRetry={() => void routines.refetch()}
              />
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
            {drived === undefined ? null : <DriveBody threadId={threadId} listing={drived} />}
          </ReadState>
        </Section>
      </div>
    </div>
  );
}

type DriveListing = {
  total: number;
  truncated: boolean;
  files: DriveFileItem[];
  folder: { hostId: string; path: string } | null;
};

/** The Drive's cards and the link to what they leave out. */
function DriveBody({ threadId, listing }: { threadId: string; listing: DriveListing }) {
  // A walk that stopped before finding a file is not an empty Drive.
  if (listing.files.length === 0 && !listing.truncated) return <Empty>The Drive is empty.</Empty>;
  return (
    <>
      {listing.files.length === 0 ? null : (
        <ul className={cn("m-0 list-none px-2 py-1", CARD_GRID)}>
          {listing.files.map((file) => (
            <DriveCard key={file.path} threadId={threadId} file={file} />
          ))}
        </ul>
      )}
      <MoreInDrive
        more={listing.total - listing.files.length}
        truncated={listing.truncated}
        folder={listing.folder}
      />
    </>
  );
}

/**
 * Cards share a row evenly: at least 7rem each, two to a ~300px panel. A phone
 * shows the tab full width, so cards there take 9rem: two columns, one on the
 * narrowest phones.
 */
const CARD_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] max-md:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2";

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
  line = false,
  cards = false,
  partialProblem = null,
  children,
}: {
  read: Read;
  rows: number;
  /** Rows of one line, as Tasks has; the others have a subline. */
  line?: boolean;
  cards?: boolean;
  partialProblem?: string | null;
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
      ? partialProblem
      : loaded
        ? `Couldn't refresh · ${read.error.message}`
        : `Couldn't load · ${read.error.message}`;
  return (
    <>
      {problem === null ? null : (
        <output
          className={cn(
            "flex min-w-0 items-center gap-2 px-2 py-1 text-xs leading-4",
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
      {loaded ? (
        children
      ) : problem === null ? (
        <Placeholder rows={rows} line={line} cards={cards} />
      ) : null}
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
      // Tasks took the place of Threads: a collapsed Threads stays collapsed.
      tasks: stored.tasks === true || (stored as { threads?: unknown }).threads === true,
      routines: stored.routines === true,
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
    <section aria-label={title} data-section={id} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-8 min-w-0 items-center rounded-lg bg-muted/60 pe-1 pointer-coarse:min-h-11">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={body}
          data-overview-toggle=""
          onClick={() => onToggle(id)}
          className={cn(
            TAP,
            "flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-start outline-none focus-visible:outline-1",
          )}
        >
          <span className="truncate leading-5 font-medium text-foreground">{title}</span>
          <span
            className={cn(
              "leading-5 text-muted-foreground tabular-nums",
              count === undefined && "invisible",
            )}
          >
            {count ?? 0}
          </span>
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronDown"}
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
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

/**
 * The banner's answer controls on the Overview's 4px grid: an 8px inset around
 * a 16px line and an 8px gap. Draw the outline inside the button so it
 * keeps the same padding and height as the primary action.
 */
const OVERVIEW_ACTION = "py-2 leading-4";
const OVERVIEW_OUTLINE_ACTION = "border-0 py-2 leading-4 inset-ring inset-ring-input";
const OVERVIEW_OTHER = "gap-2";
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
  const row = useRef<HTMLLIElement>(null);
  // An answered ask leaves the list: focus inside it moves to the section's
  // own toggle, not the page. Runs before React removes the row.
  useLayoutEffect(() => {
    const node = row.current;
    return () => {
      if (node === null || !node.contains(document.activeElement)) return;
      node.closest("section")?.querySelector<HTMLElement>("[data-overview-toggle]")?.focus();
    };
  }, []);
  return (
    <li ref={row} className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className={cn(
          TAP,
          "flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-start outline-none hover:bg-muted/40 focus-visible:outline-1",
        )}
      >
        <AskIcon item={item} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="leading-5 font-medium break-words text-foreground [unicode-bidi:plaintext]">
            {title}
          </span>
          <span className="truncate text-xs leading-4 text-muted-foreground" title={sub}>
            {sub}
          </span>
        </span>
        {item.since === null ? null : (
          <span className="shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">
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
          className="min-w-0 text-xs leading-4 text-muted-foreground [--foreground:var(--muted-foreground)]"
        />
      ) : null}
      {other !== null && item.kind === "ask" && !sending ? (
        <OtherAnswer
          className={OVERVIEW_OTHER}
          value={other}
          pending={pending}
          onChange={setOther}
          onCancel={() => {
            setOther(null);
            root?.focus();
          }}
          onSubmit={(text) => {
            root?.focus();
            // The form closes; its draft stays until the server takes the
            // answer, so a refused one reopens with what was typed.
            setOtherState(null);
            void answer(item.id, text).then((accepted) => accepted && otherDrafts.delete(item.key));
          }}
        />
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {sending && item.kind === "ask" ? (
          <output className="max-w-full min-w-0 wrap-anywhere text-muted-foreground">
            Answered {JSON.stringify(item.answer)} · Sending…
          </output>
        ) : null}
        {actions.map((action, index) => (
          <ActionButton
            key={action.label}
            action={action}
            index={index}
            shortcuts={false}
            className={action.primary ? OVERVIEW_ACTION : OVERVIEW_OUTLINE_ACTION}
          />
        ))}
        {item.kind === "ask" && item.askKind !== "ship" && !sending && other === null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(TAP, "text-muted-foreground")}
            onClick={() => setOther(otherDrafts.get(item.key) ?? "")}
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

type TaskListing = {
  tasks: CaptainTaskItem[];
  total: number;
  truncated: boolean;
  unavailable: string[];
};

/** The task rows, a line for each part that could not be read alongside them, and what they leave out. */
function TasksBody({ listing }: { listing: TaskListing }) {
  const more = listing.total - listing.tasks.length;
  return (
    <>
      {listing.unavailable.length === 0 ? null : (
        <Notice
          text={`Couldn't load ${listing.unavailable.join(", ")} · the other repos are listed`}
        />
      )}
      {listing.tasks.length === 0 ? (
        listing.unavailable.length === 0 ? (
          <Empty>No open tasks in this Captain's repos.</Empty>
        ) : null
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {listing.tasks.map((task) => (
            <TaskRow key={task.key} task={task} />
          ))}
        </ul>
      )}
      {more <= 0 && !listing.truncated ? null : (
        <p className="m-0 px-2 py-1 text-xs leading-4 text-muted-foreground">
          {more > 0 ? `${more}${listing.truncated ? "+" : ""} more in Tasks` : "More in Tasks"}
        </p>
      )}
    </>
  );
}

/** A one-line note on part of a read, whole on hover. */
function Notice({ text }: { text: string }) {
  return (
    <output
      className="block truncate px-2 py-1 text-xs leading-4 text-muted-foreground"
      title={text}
    >
      {text}
    </output>
  );
}

const STATUS_LABEL: Record<string, string> = {
  in_review: "In review",
  in_progress: "In progress",
  todo: "Todo",
  backlog: "Backlog",
};
const CREW_LABEL: Record<NonNullable<CaptainTaskItem["crew"]>["state"], string> = {
  working: "working",
  "needs-input": "needs input",
  errored: "errored",
  idle: "idle",
};

/**
 * One task on one line; it opens in Tasks, and its title (the tooltip) gives
 * the status and the crew's state. Its crew thread, when it has one, opens
 * from the trailing button, whose glyph shows a crew that errored or needs input.
 */
function TaskRow({ task }: { task: CaptainTaskItem }) {
  const navigate = useBbNavigate();
  const status = task.ready ? "Ready to ship" : (STATUS_LABEL[task.status] ?? task.status);
  const crew = task.crew;
  const role = crew?.role ?? "Crew";
  const crewText = crew === null ? null : `${role} ${CREW_LABEL[crew.state]}`;
  const sub = crewText === null ? status : `${status} · ${crewText}`;
  const tooltip = `${task.key} ${task.title}\n${sub}`;
  return (
    <li className="flex min-w-0 items-center">
      <a
        href={`/plugins/scott-tasks/tasks/task/${encodeURIComponent(task.key)}`}
        title={tooltip}
        className={cn(
          TAP,
          "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-start no-underline outline-none hover:bg-muted/40 focus-visible:outline-1",
        )}
      >
        <TaskStatusGlyph status={task.status} ready={task.ready} />
        <span className="min-w-0 flex-1 truncate leading-5 text-foreground">
          <span className="text-muted-foreground tabular-nums">{task.key}</span>{" "}
          <span className="[unicode-bidi:plaintext]">{task.title}</span>
        </span>
      </a>
      {crew === null ? null : (
        // Button takes no title, so this wrapper gives the button the row's tooltip.
        <span title={tooltip} className="me-1 flex shrink-0">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Open ${task.key}'s ${role} thread, ${CREW_LABEL[crew.state]}`}
            className={cn(TAP, "size-8", CREW_GLYPH[crew.state].tone)}
            onClick={() => navigate.toThread(crew.threadId)}
          >
            <Icon name={CREW_GLYPH[crew.state].icon} aria-hidden className="size-4" />
          </Button>
        </span>
      )}
    </li>
  );
}

/** The crew button's glyph: a warning for a crew that errored or needs input, else a thread. */
const CREW_GLYPH: Record<
  NonNullable<CaptainTaskItem["crew"]>["state"],
  { icon: string; tone: string }
> = {
  errored: { icon: "AlertTriangle", tone: "text-destructive" },
  "needs-input": { icon: "MessageQuestion", tone: "text-warning-text" },
  working: { icon: "MessageSquare", tone: "text-muted-foreground" },
  idle: { icon: "MessageSquare", tone: "text-muted-foreground" },
};

/**
 * A task's status in Tasks' own glyphs: a dashed ring for backlog, a ring for
 * todo, a quarter for in progress, three quarters for in review. Ready to ship
 * shows the merge mark the ship ask uses.
 */
function TaskStatusGlyph({ status, ready }: { status: string; ready: boolean }) {
  const box = "flex size-4 shrink-0 items-center justify-center";
  if (ready) {
    return (
      <span className={box}>
        <Icon name="GitMerge" aria-hidden className="size-4 text-success" />
      </span>
    );
  }
  const ring = (dashed: boolean) => (
    <circle
      cx="8"
      cy="8"
      r="6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      {...(dashed ? { strokeDasharray: "2 2.2" } : {})}
    />
  );
  const tone =
    status === "in_progress"
      ? "text-attention"
      : status === "in_review"
        ? "text-timeline-accent"
        : "text-muted-foreground";
  return (
    <span className={box}>
      <svg viewBox="0 0 16 16" aria-hidden className={cn("size-4", tone)}>
        {ring(status === "backlog")}
        {status === "in_progress" ? (
          <path d="M8 8 L8 3.5 A4.5 4.5 0 0 1 12.5 8 Z" fill="currentColor" />
        ) : null}
        {status === "in_review" ? (
          <path d="M8 8 L8 3.5 A4.5 4.5 0 1 1 3.5 8 Z" fill="currentColor" />
        ) : null}
      </svg>
    </span>
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
        className="flex w-full min-w-0 flex-col gap-1 rounded-lg text-start outline-none hover:bg-muted/40 focus-visible:outline-1"
      >
        <span
          aria-hidden
          className="flex h-32 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-background p-2"
        >
          {file.excerpt === null ? (
            <span className="flex h-full items-center justify-center text-muted-foreground">
              <Icon name="File" className="size-6" />
            </span>
          ) : file.excerpt.trim() === "" ? (
            <span className="flex h-full items-center justify-center text-xs leading-4 text-muted-foreground">
              Empty
            </span>
          ) : (
            <Preview markdown={file.excerpt} />
          )}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm leading-5 text-foreground" title={file.name}>
            {file.name}
          </span>
          {file.folder === null ? null : (
            <span className="truncate text-xs leading-4 text-muted-foreground" title={file.folder}>
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
      <Icon name="ArrowUpRight" aria-hidden className="size-4" />
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
  // A walk that stopped before finding any file knows only that there is more.
  const label = more > 0 ? `${more}${truncated ? "+" : ""} more in the Drive` : "More in the Drive";
  return open === null ? (
    <p className="m-0 px-2 py-1 text-xs leading-4 text-muted-foreground">{label}</p>
  ) : (
    <Button
      type="button"
      size="sm"
      variant="link"
      className={cn(TAP, "h-auto self-start px-2 py-1 text-xs leading-4 text-muted-foreground")}
      aria-label={`${label}: ${open.label.toLowerCase()}`}
      onClick={open.run}
    >
      {label}
    </Button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-2 py-2 text-xs leading-4 text-muted-foreground">{children}</p>;
}

/**
 * Space for rows or cards while they first load, each the loaded one's height:
 * two-line rows by default, one-line rows with `line`.
 */
function Placeholder({
  rows,
  line = false,
  cards = false,
}: {
  rows: number;
  line?: boolean;
  cards?: boolean;
}) {
  return (
    <div aria-busy className="flex flex-col">
      {Array.from({ length: rows }, (_, index) =>
        line ? (
          // A loaded one-line row: 8 + a 20px line + 8, and 44px on a coarse pointer.
          <div key={index} className={cn(TAP, "flex items-center gap-2 px-2 py-2")}>
            <span className="size-4 shrink-0 animate-pulse rounded bg-muted" />
            <span className="flex h-5 flex-1 items-center">
              <span className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            </span>
          </div>
        ) : (
          // A loaded two-line row: 8 + a 20px title + a 16px subline + 8.
          <div key={index} className="flex items-start gap-2 px-2 py-2">
            <span className="mt-0.5 size-4 shrink-0 animate-pulse rounded bg-muted" />
            <span className="flex flex-1 flex-col gap-2">
              <span className="h-4 w-3/4 animate-pulse rounded bg-muted" />
              <span className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            </span>
          </div>
        ),
      )}
      {cards ? (
        <div className={cn("px-2 py-1", CARD_GRID)}>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <span key={index} className="flex flex-col gap-1">
              <span className="h-32 animate-pulse rounded-lg bg-muted" />
              <span className="h-5 w-1/2 animate-pulse rounded bg-muted" />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
