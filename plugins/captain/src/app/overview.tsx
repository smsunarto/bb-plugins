/**
 * The Overview tab beside a Captain thread: what needs you, the crew, and the
 * Drive, as stacked sections that collapse. Asks come from the banner's own
 * read, so an answer in either place updates both. Reads run only while the
 * tab shows; bb keeps a hidden tab mounted.
 */
import {
  Markdown,
  experimental_Icon as Icon,
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
import { age, isSending, type QueueItem } from "../contract/queue.ts";
import { captainContract, type CrewThreadItem, type DriveFileItem } from "../contract/rpc.ts";
import { ActionButton, OtherAnswer, TAP, itemActions, useItemCommands, useNow } from "./banner.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";

const NO_INPUT = {};
const NO_ACTIVITY = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 };
const NONE: never[] = [];

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
  const asked = asks.data?.items ?? NONE;

  return (
    <div
      data-bb-plugin="captain"
      data-bb-plugin-scope-captain=""
      data-testid="captain-overview"
      className="flex min-w-0 flex-col gap-1.5 p-2 text-sm"
    >
      <Section
        id="needs"
        title="Needs you"
        count={asks.data?.items.length}
        collapsed={collapsed.needs}
        onToggle={toggle}
      >
        {asks.data === undefined ? (
          <Placeholder error={asks.error?.message} rows={1} />
        ) : asked.length === 0 ? (
          <Empty>Nothing needs you.</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {asked.map((item) => (
              <AskRow key={item.key} captainId={threadId} item={item} now={now} />
            ))}
          </ul>
        )}
      </Section>
      <Section
        id="threads"
        title="Threads"
        count={crew.data?.threads.length}
        collapsed={collapsed.threads}
        onToggle={toggle}
      >
        {crew.data === undefined ? (
          <Placeholder error={crew.error?.message} rows={2} />
        ) : crew.data.threads.length === 0 ? (
          <Empty>No crew yet. Dispatch a task to start one.</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {crew.data.threads.map((thread) => (
              <CrewRow key={thread.id} thread={thread} now={now} />
            ))}
          </ul>
        )}
      </Section>
      <Section
        id="drive"
        title="Drive"
        count={drive.data?.total}
        collapsed={collapsed.drive}
        onToggle={toggle}
        action={drive.data?.folder ? <OpenDrive folder={drive.data.folder} /> : null}
      >
        {drive.data === undefined ? (
          <Placeholder error={drive.error?.message} rows={0} cards />
        ) : drive.data.files.length === 0 ? (
          <Empty>The Drive is empty.</Empty>
        ) : (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,7.5rem)] gap-x-3 gap-y-2 p-0 px-2 pt-1">
            {drive.data.files.map((file) => (
              <DriveCard key={file.path} threadId={threadId} file={file} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
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
  count: number | undefined;
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
            "flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-start outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <span className="truncate font-medium text-foreground">{title}</span>
          {count === undefined ? null : (
            <span className="text-muted-foreground tabular-nums">{count}</span>
          )}
          <Icon
            name="ChevronDown"
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
              collapsed && "-rotate-90",
            )}
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
 * panel tab when its layout changes, such as on a resize across a breakpoint,
 * and an answer half-typed must not close under the user.
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
          "flex min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-start outline-none hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <AskIcon item={item} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium break-words text-foreground [unicode-bidi:plaintext]">
            {title}
          </span>
          <span className="truncate text-xs text-muted-foreground">{sub}</span>
        </span>
        {item.since === null ? null : (
          <span className="shrink-0 pt-px text-xs text-muted-foreground tabular-nums">
            {age(now, item.since)}
          </span>
        )}
      </button>
      {open ? (
        <div id={panel} className="ps-8 pe-2 pb-2">
          <Answer captainId={captainId} item={item} />
        </div>
      ) : null}
    </li>
  );
}

/** The banner's answer controls for one item: its detail, options, Other… and any error. */
function Answer({ captainId, item }: { captainId: string; item: QueueItem }) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const [other, setOtherState] = useState<string | null>(() => otherDrafts.get(item.key) ?? null);
  const setOther = (value: string | null) => {
    if (value === null) otherDrafts.delete(item.key);
    else otherDrafts.set(item.key, value);
    setOtherState(value);
  };
  const [error, setError] = useState<string | null>(null);
  const { answer, fail } = useItemCommands(captainId, item.key, null, setError);
  const sending = isSending(item);
  const actions = sending ? [] : itemActions(item, { answer, navigate, sdk, fail });
  const detail = item.kind === "blocked" ? null : item.detail;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs" data-testid="captain-overview-answer">
      {detail ? (
        <Markdown
          content={detail}
          className="min-w-0 text-xs leading-snug text-muted-foreground [--foreground:var(--muted-foreground)]"
        />
      ) : null}
      {other !== null && item.kind === "ask" ? (
        <OtherAnswer
          value={other}
          onChange={setOther}
          onCancel={() => setOther(null)}
          onSubmit={(text) => answer(item.id, text)}
        />
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {sending && item.kind === "ask" ? (
          <output className="text-muted-foreground">
            Answered {JSON.stringify(item.answer)} · Sending…
          </output>
        ) : null}
        {actions.map((action, index) => (
          <ActionButton key={action.label} action={action} index={index} />
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

/** One crew thread; it opens the thread. */
function CrewRow({ thread, now }: { thread: CrewThreadItem; now: number }) {
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
  const busy = status.isWorking || thread.hasPendingInteraction;
  const parts: [string, string | null][] = [
    ["model", thread.model],
    ["task", thread.task],
    ["role", thread.role],
    ["age", age(now, thread.updatedAt)],
  ];
  const sub = parts.filter((part): part is [string, string] => Boolean(part[1]));
  return (
    <li className="flex min-w-0">
      <button
        type="button"
        onClick={() => navigate.toThread(thread.id)}
        className={cn(
          TAP,
          "flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-2 py-1.5 text-start outline-none hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground"
          title={status.label ?? (thread.status === "error" ? "Errored" : undefined)}
        >
          {thread.status === "error" ? (
            <Icon name="AlertTriangle" aria-label="Errored" className="size-4 text-destructive" />
          ) : status.indicator !== "none" ? (
            <ThreadStatusGlyph indicator={status.indicator} size="compact" />
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
          >
            {thread.title}
          </span>
          <span className="flex min-w-0 flex-wrap gap-x-1 text-xs text-muted-foreground tabular-nums">
            {sub.map(([kind, part], index) => (
              <span key={kind} className="whitespace-nowrap">
                {index > 0 ? <span aria-hidden>· </span> : null}
                {part}
              </span>
            ))}
          </span>
        </span>
      </button>
    </li>
  );
}

/** One Drive file as a clipped Markdown preview; it opens the file. */
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
        className="group flex w-full min-w-0 flex-col gap-1 rounded-md text-start outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className="relative block h-32 w-full overflow-hidden rounded-md border border-border bg-background p-2 transition-colors group-hover:border-muted-foreground/50"
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
            <Markdown content={file.excerpt} className={CARD_TEXT} />
          )}
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background to-transparent" />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm text-foreground">{file.name}</span>
          {file.folder === null ? null : (
            <span className="truncate text-xs text-muted-foreground">{file.folder}</span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * A card's preview: bb's Markdown at thumbnail size. Every heading is the
 * text's size and weight, and blocks keep only a small gap, so the card shows
 * the file's opening lines rather than one large title. Nothing in it takes a
 * click or Tab: the card is the control.
 */
const CARD_TEXT =
  "pointer-events-none min-w-0 text-[10px] leading-snug text-foreground [&_*]:text-[length:inherit] [&_h1]:my-0 [&_h1]:mb-1 [&_h1]:font-medium [&_h2]:my-0 [&_h2]:mb-1 [&_h2]:font-medium [&_h3]:my-0 [&_h3]:mb-1 [&_h3]:font-medium [&_h4]:my-0 [&_h4]:font-medium [&_p]:my-0 [&_p]:mb-1 [&_ul]:my-0 [&_ul]:mb-1 [&_ol]:my-0 [&_ol]:mb-1 [&_li]:my-0 [&_pre]:my-0 [&_pre]:p-1 [&_button]:hidden [&_img]:hidden";

/**
 * ↗ opens the Drive folder in this client's external file target when it has
 * one for the server's machine; otherwise bb's Info tab, whose Thread storage
 * row is the Drive.
 */
function OpenDrive({ folder }: { folder: { hostId: string; path: string } }) {
  const navigate = useBbNavigate();
  const panel = useAppPanel();
  const tabs = usePanelTabs();
  const target = useMemo(
    () => ({ kind: "host" as const, hostId: folder.hostId, path: folder.path }),
    [folder.hostId, folder.path],
  );
  const external = useCanOpenFileExternally(target);
  const info = tabs.tabs.find((tab) => tab.detail.kind === "info");
  if (!external && info === undefined) return null;
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={external ? "Open the Drive folder" : "Show the Drive in Info"}
      className={cn(TAP, "size-6 text-muted-foreground")}
      onClick={() => {
        if (external) navigate.experimental_openFileExternally({ target, location: null });
        else if (info !== undefined) panel.selectTab(info.key);
      }}
    >
      <Icon name="ArrowUpRight" aria-hidden className="size-3.5" />
    </Button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">{children}</p>;
}

/** Space for rows or cards that are loading, or the read's failure. */
function Placeholder({
  error,
  rows,
  cards = false,
}: {
  error: string | undefined;
  rows: number;
  cards?: boolean;
}) {
  if (error !== undefined) {
    return <p className="m-0 px-2 py-1.5 text-xs break-words text-destructive">{error}</p>;
  }
  return (
    <div aria-busy className="flex flex-col gap-1 px-2 py-1.5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-2.5 py-0.5">
          <span className="size-4 shrink-0 animate-pulse rounded-full bg-muted" />
          <span className="flex flex-1 flex-col gap-1">
            <span className="h-3.5 w-3/4 animate-pulse rounded bg-muted" />
            <span className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          </span>
        </div>
      ))}
      {cards ? (
        <div className="grid grid-cols-[repeat(auto-fill,7.5rem)] gap-3">
          {[0, 1, 2].map((index) => (
            <span key={index} className="h-32 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : null}
    </div>
  );
}
