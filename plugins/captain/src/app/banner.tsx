/**
 * Needs you: the queue above a Captain's composer, answered with a
 * click or a key. bb mounts composer banners on every thread, so the banner
 * reads one shared, cached list of Captain ids and renders nothing on any
 * other thread, before any other read. bb hides the card while it is empty.
 */
import {
  Markdown,
  experimental_useAppPanel as useAppPanel,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
  useComposer,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefCallback,
  type RefObject,
} from "react";
import { DEFAULT_ICON_GLYPH } from "../contract/icon.ts";
import {
  age,
  isSending,
  nextWake,
  orderQueue,
  type HealthItem,
  type QueueItem,
} from "../contract/queue.ts";
import { captainContract } from "../contract/rpc.ts";
import { surface } from "@bb-plugins/ui/surface";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button, CompactButton } from "./components/ui/button.tsx";
import { Icon } from "./components/ui/icon.tsx";
import { Input } from "./components/ui/input.tsx";
import { cn } from "./lib/utils.ts";
import { useOverviewOnOpen } from "./overview-default.ts";

const NO_INPUT = {};
type ItemUi = { key: string | null; other: string | null; error: string | null; planOpen: boolean };
const CLOSED_UI = { other: null, error: null, planOpen: false };
const ASKS_UNAVAILABLE = "Couldn’t refresh asks";
const NO_ITEMS: QueueItem[] = [];
/** Ages and Later both read the clock; a minute is fine-grained enough for either. */
const TICK_MS = 30_000;
const FAR = Number.MAX_SAFE_INTEGER;
/** Every control a phone user taps gets a 44px target. */
export const TAP = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const MOBILE_ANSWER =
  "max-sm:h-auto max-sm:px-2 max-sm:py-2 max-sm:leading-4 max-sm:whitespace-normal";
const ANSWER_ROW =
  "col-start-2 flex min-w-0 items-start gap-1.5 max-sm:col-span-2 max-sm:col-start-1";
const HORIZONTAL_SCROLL = "overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
export const CAPTAIN_OVERVIEW_TAB = {
  id: "overview",
  context: { kind: "thread" },
  availability: "fixed",
} as const;

export function NeedsYouBanner() {
  const { scope } = useComposer();
  return scope.kind === "thread" ? <CaptainGate threadId={scope.threadId} /> : null;
}

function CaptainGate({ threadId }: { threadId: string }) {
  const captains = useRpcQuery({ contract: captainContract, method: "captains", input: NO_INPUT });
  const isCaptain = captains.data === undefined ? null : captains.data.ids.includes(threadId);
  return (
    <>
      <OverviewOnOpen threadId={threadId} isCaptain={isCaptain} />
      {isCaptain === true ? <Banner key={threadId} captainId={threadId} /> : null}
    </>
  );
}

/**
 * Rides on the banner's slot, mounted on every thread before bb says which
 * are Captains, so a panel opened meanwhile still lands on Overview.
 */
function OverviewOnOpen({ threadId, isCaptain }: { threadId: string; isCaptain: boolean | null }) {
  const anchor = useOverviewOnOpen(threadId, isCaptain);
  return isCaptain === false ? null : <span ref={anchor} hidden data-captain-overview-anchor="" />;
}

export type Action = { label: string; run: () => void; primary?: boolean; recommended?: boolean };

function Banner({ captainId }: { captainId: string }) {
  const input = useMemo(() => ({ captainId }), [captainId]);
  const asks = useRpcQuery({ contract: captainContract, method: "asks", input });
  const crew = useRpcQuery({ contract: captainContract, method: "crew", input });
  const now = useNow(asks.data?.items, crew.data?.items);
  const allItems = useMemo(
    () => [...(asks.data?.items ?? NO_ITEMS), ...(crew.data?.items ?? NO_ITEMS)],
    [asks.data, crew.data],
  );
  const items = useMemo(() => orderQueue(allItems, now), [allItems, now]);
  if (asks.data === undefined && asks.error === null) return null;
  const emptyLabel = asks.error
    ? ASKS_UNAVAILABLE
    : crew.error
      ? "Crew status unavailable"
      : crew.data && "All clear";
  const laterCount = allItems.length - items.length;
  return (
    <Queue
      captainId={captainId}
      items={items}
      laterCount={laterCount}
      now={now}
      emptyLabel={emptyLabel}
      asksError={asks.error?.message}
      crewError={crew.error?.message}
    />
  );
}

function QueueStatus({ id, label, degraded }: { id: string; label: string; degraded: boolean }) {
  const panel = useAppPanel();
  return (
    <div className="flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground pointer-coarse:py-0">
      <Icon
        name={degraded ? "AlertTriangle" : DEFAULT_ICON_GLYPH}
        aria-hidden
        className={cn("size-3.5 shrink-0", degraded ? "text-warning-text" : "text-foreground")}
      />
      <span id={id} className="min-w-0 flex-1 truncate font-medium text-foreground">
        {label}
      </span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        tone="muted"
        className={cn(
          TAP,
          surface.bannerHover,
          "-mr-1.5 h-5 px-1.5 font-normal focus-visible:ring-inset",
        )}
        onClick={() => panel.openTab({ tab: CAPTAIN_OVERVIEW_TAB })}
      >
        Overview
      </Button>
    </div>
  );
}

function Queue({
  captainId,
  items,
  laterCount,
  now,
  emptyLabel,
  asksError,
  crewError,
}: {
  captainId: string;
  items: readonly QueueItem[];
  laterCount: number;
  now: number;
  emptyLabel: string | undefined;
  asksError: string | undefined;
  crewError: string | undefined;
}) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const id = useId();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { queueItems, recordAnswer } = useRecordedAnswers(items);
  const waiting = queueItems.filter((entry) => !isSending(entry));
  const tabs = waiting.length > 0 ? waiting : queueItems;
  const item = tabs.find((entry) => entry.key === selected) ?? tabs[0];
  const sending = item !== undefined && isSending(item);
  const { other, error, planOpen, patchUi } = useItemUi(item?.key ?? null);
  const setOther = (value: string | null) => patchUi({ other: value });
  const { answer, later, skip, fail, pending } = useItemCommands(
    captainId,
    item?.key ?? null,
    root,
    (value) => patchUi({ error: value }),
    other !== null,
  );
  const restoreOtherFocus = useRef(false);
  const focusOther = useCallback((node: HTMLButtonElement | null) => {
    if (node && restoreOtherFocus.current) {
      restoreOtherFocus.current = false;
      node.focus();
    }
  }, []);
  const actions =
    item === undefined || sending || pending
      ? []
      : itemActions(item, { answer, navigate, sdk, fail });
  const kind = item === undefined ? undefined : bannerKind(item);
  const showTabs = tabs.length > 1 || kind !== "plan" || laterCount > 0;
  const detail = item?.kind === "blocked" ? null : item?.detail;
  const plan = kind === "plan" && detail;
  const dismiss = () => {
    setSelected(null);
    skip();
  };
  const select = (entry: QueueItem) => {
    if (entry.key === item?.key) return;
    setSelected(entry.key);
  };

  const editing = other !== null && item?.kind === "ask" && !sending;
  const focusReturnRef = useQueueFocusReturn(root, !sending);

  // When More or Less goes while it has focus, focus lands on the banner, where
  // Enter answers. The Enter that follows was meant for the toggle: it does nothing.
  const toggleGone = useRef(false);
  // A number key itself can make :focus-visible match after a click. Capture
  // how focus arrived so that first keypress cannot unexpectedly answer.
  const keyboardFocus = useRef(false);
  const onToggleGone = useCallback(() => {
    root?.focus();
    toggleGone.current = true;
  }, [root]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!keyboardFocus.current || other !== null) return;
    const swallow = toggleGone.current && event.key === "Enter";
    toggleGone.current = false;
    if (swallow) {
      event.preventDefault();
      return;
    }
    const run = shortcut(
      event,
      actions,
      sending || pending ? null : { later, skip: dismiss },
      kind !== "ship",
    );
    if (run === undefined) return;
    event.preventDefault();
    run();
  };

  // The final editor can hand focus to the same frame after All clear mounts.
  // workaround:captain/composer-banner-clip
  // Host `chrome: "card"` owns the outer PromptStackCard frame and edge; keep
  // overflow-hidden + rounded-lg here so expanded popover surfaces clip cleanly
  // until core's PluginComposerBanners wrapper adds overflow-hidden.
  const frameClassName =
    "flex min-w-0 flex-col overflow-hidden rounded-lg text-xs text-foreground outline-none focus-visible:outline-1";
  const frameHandlers = {
    "data-bb-plugin": "captain",
    "data-bb-plugin-scope-captain": "",
    onFocus: (event: FocusEvent<HTMLElement>) => {
      keyboardFocus.current = event.target.matches(":focus-visible");
    },
    onPointerDownCapture: () => {
      keyboardFocus.current = false;
    },
    onBlur: () => {
      keyboardFocus.current = false;
      toggleGone.current = false;
    },
  };
  if (item === undefined || kind === undefined) {
    if (!emptyLabel && !root) return null;
    const degraded = asksError !== undefined || crewError !== undefined;
    return (
      <div
        ref={setRoot}
        {...frameHandlers}
        tabIndex={-1}
        aria-describedby={emptyLabel ? id : undefined}
        className={cn(frameClassName, "empty:hidden")}
      >
        {emptyLabel ? <QueueStatus id={id} label={emptyLabel} degraded={degraded} /> : null}
      </div>
    );
  }
  return (
    <div
      ref={setRoot}
      {...frameHandlers}
      className={frameClassName}
      role="toolbar"
      tabIndex={0}
      aria-label={`Needs you, ${items.length} item${items.length === 1 ? "" : "s"}`}
      aria-keyshortcuts={kind === "ship" ? "1 2 L" : "1 2 3 4 5 6 7 8 9 Enter L"}
      data-testid="captain-needs-you"
      onKeyDown={onKeyDown}
    >
      {showTabs ? (
        <QueueTabs
          id={id}
          tabs={tabs}
          waitingCount={waiting.length}
          selected={item}
          laterCount={laterCount}
          now={now}
          onSelect={select}
          tabRef={focusReturnRef}
        />
      ) : null}
      <div
        id={`${id}-panel`}
        role={showTabs ? "tabpanel" : undefined}
        aria-labelledby={showTabs ? `${id}-${item.key}` : undefined}
        className={cn(
          showTabs && surface.divider,
          "grid min-w-0 grid-cols-[14px_minmax(0,1fr)] gap-x-1.5 gap-y-2 bg-popover px-3 py-2.5",
        )}
      >
        <Icon
          name={BANNER_ICONS[kind]}
          aria-hidden
          className="mt-px size-3.5 shrink-0 text-warning-text"
        />
        <Heading item={item} asksError={asksError} crewError={crewError} />
        {detail ? (
          <div className="col-start-2 min-w-0">
            {plan ? (
              <div
                key={item.key}
                id={`${id}-plan`}
                className={cn(
                  DETAIL_BOX,
                  planOpen ? "max-h-[12lh] overflow-y-auto" : "max-h-[6.5lh] overflow-hidden",
                )}
                onScroll={(event) => {
                  if (!planOpen)
                    revealFocusedDetail(event.currentTarget, () => patchUi({ planOpen: true }));
                }}
              >
                <Markdown content={detail} className={DETAIL_TEXT} />
              </div>
            ) : (
              <Detail key={item.key} content={detail} onToggleGone={onToggleGone} />
            )}
          </div>
        ) : null}
        {editing ? (
          <div
            key={item.key}
            ref={focusReturnRef}
            data-captain-answer-row=""
            className={ANSWER_ROW}
          >
            <OtherAnswer
              value={other}
              pending={pending}
              showCancel
              onChange={setOther}
              onCancel={() => {
                restoreOtherFocus.current = true;
                setOther(null);
              }}
              onSubmit={(text) => {
                void answer(item.id, text).then((accepted) => {
                  if (accepted) {
                    recordAnswer(item.id, text);
                    setOther(null);
                  }
                  return accepted;
                });
              }}
            />
          </div>
        ) : (
          <AnswerRow
            item={item}
            kind={kind}
            actions={actions}
            pending={pending}
            later={later}
            openOther={() => setOther("")}
            focusOther={focusOther}
            plan={
              plan
                ? {
                    id: `${id}-plan`,
                    open: planOpen,
                    toggle: () => {
                      const content = document.getElementById(`${id}-plan`);
                      if (planOpen && content) content.scrollTop = 0;
                      patchUi({ planOpen: !planOpen });
                    },
                  }
                : null
            }
          />
        )}
        {error ? (
          <Alert variant="destructive" role="none" className="col-start-2 min-w-0">
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}

/** An acknowledgement can arrive before the refreshed asks list. */
function useRecordedAnswers(items: readonly QueueItem[]) {
  const [recorded, setRecorded] = useState<ReadonlyMap<string, string>>(() => new Map());
  const recordAnswer = (id: string, answer: string) =>
    setRecorded((previous) => new Map(previous).set(id, answer));
  if (recorded.size === 0) return { queueItems: items, recordAnswer };

  const current = new Map<string, string>();
  const queueItems = items.map((item) => {
    if (item.kind !== "ask" || item.answer !== null) return item;
    const answer = recorded.get(item.id);
    if (answer === undefined) return item;
    current.set(item.id, answer);
    return { ...item, answer };
  });
  if (current.size < recorded.size) setRecorded(current);
  return { queueItems, recordAnswer };
}

function AnswerRow({
  item,
  kind,
  actions,
  pending,
  later,
  openOther,
  focusOther,
  plan,
}: {
  item: QueueItem;
  kind: BannerKind;
  actions: Action[];
  pending: boolean;
  later: () => void;
  openOther: () => void;
  focusOther: (node: HTMLButtonElement | null) => void;
  plan: { id: string; open: boolean; toggle: () => void } | null;
}) {
  if (item.kind === "ask" && (item.answer !== null || pending)) {
    return (
      <output className="col-start-2 text-muted-foreground">
        {item.answer === null ? "Sending…" : `Answered ${JSON.stringify(item.answer)} · Sending…`}
      </output>
    );
  }
  const showOther = item.kind === "ask" && kind !== "ship";
  return (
    <div
      data-captain-answer-row=""
      className={cn(ANSWER_ROW, "max-sm:flex-wrap max-sm:justify-end")}
    >
      {actions.length > 0 || plan ? (
        <div
          data-captain-answers=""
          className={cn(
            HORIZONTAL_SCROLL,
            "-m-0.5 flex min-w-0 items-center gap-1.5 p-0.5 max-sm:m-0 max-sm:grid max-sm:w-full max-sm:grid-cols-2 max-sm:items-stretch max-sm:overflow-visible max-sm:p-0",
          )}
        >
          {actions.map((action, index) => (
            <ActionButton key={action.label} action={action} index={index} bannerKind={kind} />
          ))}
          {plan ? (
            <CompactButton
              type="button"
              size="sm"
              variant="outline"
              className={cn(TAP, MOBILE_ANSWER, surface.bannerHover, "max-sm:col-span-full")}
              aria-expanded={plan.open}
              aria-controls={plan.id}
              onClick={plan.toggle}
            >
              <Icon name="FileText" aria-hidden data-icon="inline-start" className="size-3.5!" />
              {plan.open ? "Close plan" : "Read plan"}
            </CompactButton>
          ) : null}
        </div>
      ) : null}
      <CompactButton
        type="button"
        size="icon-sm"
        variant="outline"
        className={cn(TAP, "text-muted-foreground hover:text-foreground")}
        aria-label="Later"
        aria-keyshortcuts="L"
        aria-description="Hide for an hour"
        onClick={later}
      >
        <Icon name="Clock" aria-hidden className="size-3.5!" />
      </CompactButton>
      {showOther ? (
        <CompactButton
          ref={focusOther}
          type="button"
          size="sm"
          variant="ghost"
          tone="muted"
          aria-label="Other…"
          className={cn(TAP, "px-2")}
          onClick={openOther}
        >
          <svg
            data-icon="inline-start"
            aria-hidden="true"
            className="size-3.5!"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M13 21h8m.174-14.188a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
          </svg>
          <span>Other…</span>
        </CompactButton>
      ) : null}
    </div>
  );
}

/** Editors and tabs give focus back to the queue when they unmount with focus. */
function useQueueFocusReturn(root: HTMLElement | null, preferSelectedTab: boolean) {
  const lostFocus = useRef(false);
  const focusReturnRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    return () => {
      if (node.contains(document.activeElement)) lostFocus.current = true;
    };
  }, []);
  useLayoutEffect(() => {
    if (!lostFocus.current) return;
    lostFocus.current = false;
    // Cancel can already have focused Other. A reply must never steal focus.
    if (document.activeElement !== document.body || !root) return;
    const selectedTab = preferSelectedTab
      ? root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      : null;
    (selectedTab ?? root).focus({ preventScroll: true });
  });
  return focusReturnRef;
}

/** Key local UI to the item so async updates from previous items are ignored. */
function useItemUi(key: string | null) {
  const [ui, setUi] = useState<ItemUi>(() => ({ key, ...CLOSED_UI }));
  if (ui.key !== key) setUi({ key, ...CLOSED_UI });
  const patchUi = (patch: Partial<Omit<ItemUi, "key">>) =>
    setUi((current) => (current.key === key ? { ...current, ...patch } : current));
  return { ...ui, patchUi };
}

/**
 * Answer, Later and Skip for the item on show. Each keeps keyboard focus on
 * the banner when the clicked button unmounts, and reports a failure inline.
 */
export function useItemCommands(
  captainId: string,
  key: string | null,
  root: HTMLElement | null,
  setError: (value: string | null) => void,
  editInPlace = false,
) {
  const { resolve, defer } = useQueueMutations(captainId, editInPlace);
  const keepFocus = () => {
    if (root?.contains(document.activeElement)) root.focus();
  };
  const fail = (failure: unknown) => setError((failure as Error).message);
  /** True once the server holds the answer, even if sending it on failed. */
  const deliver = async (askId: string, text: string): Promise<boolean> => {
    try {
      const result = await resolve.mutate({ askId, answer: text });
      if (result.state === "undelivered") setError(result.warnings.join("; "));
      return true;
    } catch (failure) {
      fail(failure);
      return false;
    }
  };
  const answer = (askId: string, text: string): Promise<boolean> => {
    if (!editInPlace) keepFocus();
    setError(null);
    return deliver(askId, text);
  };
  const deferItem = (action: "later" | "skip") => {
    if (key === null) return;
    keepFocus();
    void defer.mutate({ captainId, key, action }).catch(fail);
  };
  return {
    answer,
    later: () => deferItem("later"),
    skip: () => deferItem("skip"),
    fail,
    /** An answer is on its way to the server. */
    pending: resolve.pendingInputs.some(({ askId }) => key === `ask:${askId}`),
  };
}

/** The answer and defer mutations, each updating the cached queue before the server replies. */
function useQueueMutations(captainId: string, editInPlace: boolean) {
  const resolve = useRpcMutation({
    contract: captainContract,
    method: "resolveAsk",
    optimistic({ askId, answer }, cache) {
      // Keep a typed answer in its row until the server accepts it, so a
      // rejected send leaves both the input and the draft in place.
      if (editInPlace) return;
      cache.update("asks", { captainId }, (current) => ({
        items: current.items.map((item) =>
          item.kind === "ask" && item.id === askId ? { ...item, answer } : item,
        ),
      }));
    },
  });
  const defer = useRpcMutation({
    contract: captainContract,
    method: "defer",
    optimistic({ key, action }, cache) {
      const patch = action === "later" ? { snoozedUntil: FAR } : { skipOrder: FAR };
      const apply = <T extends QueueItem>(list: T[]): T[] =>
        list.map((item) => (item.key === key ? { ...item, ...patch } : item));
      cache.update("asks", { captainId }, (current) => ({ items: apply(current.items) }));
      cache.update("crew", { captainId }, (current) => ({ items: apply(current.items) }));
    },
  });
  return { resolve, defer };
}

/** What a key on the banner runs, if anything; typing in a field is never a shortcut. */
function shortcut(
  event: KeyboardEvent<HTMLElement>,
  actions: Action[],
  defer: { later: () => void; skip: () => void } | null,
  enterAnswers: boolean,
): (() => void) | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const target = event.target as HTMLElement;
  if (document.activeElement !== target) return undefined;
  if (target.matches("input, textarea, select, [contenteditable]")) return undefined;
  const key = event.key.toLowerCase();
  if (/^[1-9]$/u.test(key)) return actions[Number(key) - 1]?.run;
  // Enter on a focused button is that button's own click. A held Enter repeats
  // onto the banner when the button it pressed goes away; that is no answer.
  if (key === "enter") {
    return enterAnswers && target === event.currentTarget && !event.repeat
      ? actions[0]?.run
      : undefined;
  }
  if (key === "l") return defer?.later;
  if (key === "s") return defer?.skip;
  return undefined;
}

const BANNER_ICONS = {
  decision: "GitBranch",
  ship: "GitMerge",
  access: "Lock",
  improve: "Lightbulb",
  plan: "ListTodo",
  blocked: "MessageCircle",
  health: "AlertTriangle",
} as const;

type BannerKind = keyof typeof BANNER_ICONS;

/** Plan requests use the ordinary decision payload. Keep generic decisions on their own template. */
function bannerKind(item: QueueItem): BannerKind {
  if (item.kind !== "ask") return item.kind;
  if (
    item.askKind === "decision" &&
    /^(?:approve|review) (?:the |this )?plan\b/iu.test(item.text)
  ) {
    return "plan";
  }
  return item.askKind;
}

function tabTitle(item: QueueItem): string {
  const text = title(item);
  if (item.kind === "ask" && item.askKind === "ship" && item.task !== null) {
    const prefix = `Merge ${item.task}: `;
    if (text.startsWith(prefix)) return text.slice(prefix.length);
    const pr = /^Merge PR #\d+\s+·\s+(.+)$/u.exec(text);
    if (pr?.[1]) return pr[1];
  }
  return text;
}

function QueueTabs({
  id,
  tabs,
  waitingCount,
  selected,
  laterCount,
  now,
  onSelect,
  tabRef,
}: {
  id: string;
  tabs: readonly QueueItem[];
  waitingCount: number;
  selected: QueueItem;
  laterCount: number;
  now: number;
  onSelect: (item: QueueItem) => void;
  tabRef: RefCallback<HTMLButtonElement>;
}) {
  return (
    <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-1.5 px-3 py-1">
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground" aria-live="polite">
        <Badge variant="warning" size="sm" className="min-w-4.5 tabular-nums">
          {waitingCount}
        </Badge>
        waiting
      </span>
      <div
        role="tablist"
        tabIndex={-1}
        aria-label="Captain queue"
        className={cn(
          HORIZONTAL_SCROLL,
          "-m-0.5 flex min-w-0 flex-1 items-center gap-0.5 p-0.5 max-sm:mt-1 max-sm:w-full max-sm:flex-none max-sm:items-stretch max-sm:gap-1",
        )}
        onKeyDown={(event) => {
          const index = tabs.indexOf(selected);
          const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (step === 0 || index === -1) return;
          event.preventDefault();
          const next = tabs[(index + step + tabs.length) % tabs.length]!;
          onSelect(next);
          document.getElementById(`${id}-${next.key}`)?.focus();
        }}
      >
        {tabs.map((entry) => {
          const active = entry.key === selected.key;
          return (
            <Button
              key={entry.key}
              ref={tabRef}
              id={`${id}-${entry.key}`}
              role="tab"
              type="button"
              size="xs"
              variant="ghost"
              tone={active ? "default" : "muted"}
              aria-controls={`${id}-panel`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={cn(
                TAP,
                !active && surface.bannerHover,
                "max-w-42 gap-1.5 max-sm:h-auto max-sm:max-w-52 max-sm:py-1.5 max-sm:leading-4",
                active && "bg-(--surface-selected) text-foreground",
              )}
              onClick={() => onSelect(entry)}
            >
              <Icon name={BANNER_ICONS[bannerKind(entry)]} aria-hidden data-icon="inline-start" />
              <span
                title={tabTitle(entry)}
                className="min-w-0 truncate [unicode-bidi:plaintext] max-sm:line-clamp-2 max-sm:wrap-anywhere max-sm:text-start max-sm:whitespace-normal"
              >
                {tabTitle(entry)}
              </span>
              {entry.since === null ? null : (
                <span className="shrink-0 font-normal opacity-75">{age(now, entry.since)}</span>
              )}
            </Button>
          );
        })}
        {laterCount > 0 ? (
          <Badge variant="outline" size="sm">
            {laterCount} later
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

function Heading({
  item,
  asksError,
  crewError,
}: {
  item: QueueItem;
  asksError: string | undefined;
  crewError: string | undefined;
}) {
  const text = title(item);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p dir="auto" className="m-0 text-xs leading-snug font-medium wrap-anywhere text-foreground">
        {text}
      </p>
      {item.task && !text.includes(item.task) ? (
        <span className="font-mono text-2xs text-muted-foreground">{item.task}</span>
      ) : null}
      {asksError !== undefined ? (
        <span className="text-muted-foreground" title={asksError}>
          {ASKS_UNAVAILABLE}
        </span>
      ) : null}
      {crewError ? (
        <span className="text-destructive" title={crewError}>
          crew not read
        </span>
      ) : null}
    </div>
  );
}

/**
 * One answer; the recommended one says so. A long answer wraps inside the
 * phone card (a new ask's options are capped at 12 columns, but older asks
 * may be longer). The Overview keeps "Recommended" whole.
 */
export function ActionButton({
  action,
  index,
  shortcuts = true,
  bannerKind,
  className,
}: {
  action: Action;
  index: number;
  /** False where no key handler answers by number, as outside the banner. */
  shortcuts?: boolean;
  bannerKind?: BannerKind;
  /** The caller's spacing, such as the Overview's grid; the banner keeps its own. */
  className?: string;
}) {
  const Control = bannerKind ? CompactButton : Button;
  return (
    <Control
      type="button"
      size="sm"
      variant={action.primary ? "default" : "outline"}
      className={cn(
        TAP,
        bannerKind
          ? cn(MOBILE_ANSWER, "max-sm:min-w-0")
          : "h-auto min-h-8 max-w-full py-1.5 text-start whitespace-normal",
        bannerKind &&
          action.primary &&
          "bg-(--foreground) text-background hover:bg-(--foreground)/90",
        className,
      )}
      aria-keyshortcuts={shortcuts && index < 9 ? String(index + 1) : undefined}
      onClick={action.run}
    >
      {bannerKind && action.recommended ? (
        <Icon
          name={bannerKind === "ship" ? "GitMerge" : "Star"}
          className={cn("size-3!", bannerKind !== "ship" && "fill-current")}
          aria-hidden
          data-icon="inline-start"
        />
      ) : null}
      <span
        className={cn(
          "min-w-0 text-start break-words [unicode-bidi:plaintext]",
          bannerKind && "max-sm:wrap-anywhere",
        )}
      >
        {action.label}
      </span>
      {action.recommended ? (
        <span
          className={bannerKind ? "sr-only" : "shrink-0 font-normal whitespace-nowrap opacity-70"}
        >
          Recommended
        </span>
      ) : null}
    </Control>
  );
}

/**
 * Captains' Markdown, quieted to a secondary line. Overriding `--foreground`
 * mutes every element bb's renderer colours with it (paragraphs, lists, bold,
 * headings) in one declaration; inline code needs `!` to beat the theme's
 * yellow, which outranks a plugin utility. Thread chips keep their own colour
 * and are held to the line height so they sit in the text. The leading is
 * relative, so two lines stay two lines where touch enlarges the text.
 * Headings are the detail's size open and collapsed, and a leading quote has
 * no top margin in either, so More moves no line.
 */
const DETAIL_BOX =
  "min-w-0 text-xs leading-snug text-muted-foreground [--foreground:var(--muted-foreground)] [&_code]:text-muted-foreground! [&_[data-prompt-mention]]:py-0 [&_[data-prompt-mention]]:leading-3.5 [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h5]:text-xs [&_blockquote:first-child]:mt-0";
/** bb's renderer defaults to body size; the box's size and leading keep its lines the box's lines. */
const DETAIL_TEXT = "min-w-0 text-xs leading-snug text-muted-foreground";
/**
 * Collapsed Markdown fits in a short preview under the fade.
 * Every block is lines of text with no margins between, so two blocks of one
 * line each are the two lines. bb's blocks become text there too, at any
 * depth, rather than show a sliver. bb frames a code block or a diagram in a
 * box whose header holds its buttons: the box and header go, and so do the
 * buttons, so none takes Tab; a code block shows its code, a diagram its
 * header's label. A table shows its rows with cells parted by a dot, and an
 * image a thumbnail one line tall. Each is summarised, so More shows (see
 * SUMMARISED).
 */
const PREVIEW =
  "block max-h-[84px] overflow-hidden [&_p]:my-0 [&_ul]:my-0 [&_ol]:my-0 [&_li]:my-0 [&_li+li]:mt-1.5 [&_p+ul]:mt-1.5 [&_ul+p]:mt-1.5 [&_blockquote]:my-0 [&_h1]:my-0 [&_h2]:my-0 [&_h3]:my-0 [&_h4]:my-0 [&_h5]:my-0 [&_h6]:my-0 [&_hr]:my-0 [&_button]:hidden [&_div:has(>div>div>button)]:contents [&_div:has(>div>button)]:contents [&_div:has(>pre)>div]:hidden [&_div:has(>div>div>button)>div~div]:hidden [&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent! [&_pre]:p-0 [&_pre>code]:leading-snug! [&_pre_span]:leading-snug! [&_pre_span]:text-inherit! [&_div:has(>div>table)]:contents [&_div:has(>table)]:contents [&_table]:block [&_table]:border-0 [&_thead]:contents [&_tbody]:contents [&_tr]:block [&_th]:inline [&_th]:border-0 [&_th]:p-0 [&_th]:font-medium [&_td]:inline [&_td]:border-0 [&_td]:p-0 [&_th+th]:before:content-['_·_'] [&_td+td]:before:content-['_·_'] [&_img]:my-0! [&_img]:inline [&_img]:h-[1lh] [&_img]:w-auto [&_img]:align-top!";
/**
 * Blocks the preview shows only in summary: a code block or diagram, found by
 * its frame's buttons (a diagram draws only once visible), a table, an image.
 */
const SUMMARISED = "button, table, img";

/** The fade stays inside the preview. The disclosure has a separate hit area. */
function Detail({ content, onToggleGone }: { content: string; onToggleGone: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useToggleShown({ box, onToggleGone, open, content });
  const id = useId();
  return (
    <div className="min-w-0">
      <div className="relative min-w-0 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:hidden after:h-6 after:max-h-full after:bg-linear-to-b after:from-transparent after:to-popover data-[preview-fade]:after:block">
        <div
          ref={box}
          id={id}
          data-detail-box=""
          className={cn(DETAIL_BOX, open ? "max-h-[10lh] overflow-y-auto" : PREVIEW)}
          onScroll={(event) => {
            if (!open) revealFocusedDetail(event.currentTarget, () => setOpen(true));
          }}
        >
          <Markdown content={content} className={DETAIL_TEXT} />
        </div>
      </div>
      <Button
        ref={toggle}
        type="button"
        size="xs"
        variant="ghost"
        tone="muted"
        hidden
        className={cn(
          TAP,
          "group flex w-full justify-center rounded-none px-1 hover:bg-transparent [&[hidden]]:hidden",
        )}
        aria-controls={id}
        aria-expanded={open}
        onClick={() => {
          if (open && box.current !== null) {
            box.current.scrollTop = 0;
            box.current.scrollLeft = 0;
          }
          setOpen(!open);
        }}
      >
        <span
          className={cn(
            surface.edge,
            surface.bannerHover,
            "flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition-colors group-hover:text-foreground",
          )}
        >
          {open ? "Less" : "More"}
          <Icon name={open ? "ChevronUp" : "ChevronDown"} aria-hidden />
        </span>
      </Button>
    </div>
  );
}

/** Keyboard focus on a clipped link reveals it. Other incidental scrolls snap back. */
function revealFocusedDetail(node: HTMLElement, expand: () => void): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && node.contains(active) && active.matches(":focus-visible")) {
    expand();
  } else {
    node.scrollTop = 0;
  }
}

/**
 * Clipping in either direction or a summarised block shows More. Vertical
 * clipping gets the noninteractive fade. The ResizeObserver callback measures
 * after layout and, being before paint, sets the toggle's `hidden`
 * there, so More paints with the text it belongs to; a state update would
 * paint a frame later. The box's size changes as bb's renderer adds its
 * content after the first commit, so summarised blocks are found then too.
 * Measured only while collapsed, so Less stays shown (and focused) through
 * the collapse until measured. Should the preview turn out to fit, the toggle
 * goes; if it held focus, `onToggleGone` first keeps focus in the banner
 * rather than letting it fall to the page. New content under a box that stays
 * fixed height changes no size, so it observes afresh. React sets `hidden`
 * only as the toggle mounts, so with nothing to measure it stays hidden.
 */
function useToggleShown({
  box,
  onToggleGone,
  open,
  content,
}: {
  box: RefObject<HTMLElement | null>;
  onToggleGone: () => void;
  open: boolean;
  content: string;
}): RefObject<HTMLButtonElement | null> {
  const toggle = useRef<HTMLButtonElement>(null);
  // A layout effect, so the first measure lands before the first paint; it reads no layout itself.
  useLayoutEffect(() => {
    const node = box.current;
    const button = toggle.current;
    const preview = node?.parentElement;
    if (preview == null || node === null || button === null) return;
    if (open) {
      preview.removeAttribute("data-preview-fade");
      return;
    }
    if (typeof ResizeObserver === "undefined") return;
    const sizes = new ResizeObserver(() => {
      const clippedBelow = node.scrollHeight > node.clientHeight + 1;
      const clippedAcross = node.scrollWidth > node.clientWidth + 1;
      const showMore = clippedBelow || clippedAcross || node.querySelector(SUMMARISED) !== null;
      preview.toggleAttribute("data-preview-fade", clippedBelow);
      if (!showMore && button.contains(document.activeElement)) onToggleGone();
      button.hidden = !showMore;
    });
    sizes.observe(node);
    return () => sizes.disconnect();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above: new content is observed afresh.
  }, [box, onToggleGone, open, content]);
  return toggle;
}

function title(item: QueueItem): string {
  if (item.kind === "blocked") {
    return `${item.role ?? "Crew"} needs you: ${item.title}`;
  }
  return item.kind === "ask" ? item.text : item.title;
}

export function itemActions(
  item: QueueItem,
  ctx: {
    answer: (askId: string, text: string) => void;
    navigate: ReturnType<typeof useBbNavigate>;
    sdk: ReturnType<typeof useSdk>;
    fail: (error: unknown) => void;
  },
): Action[] {
  switch (item.kind) {
    case "ask":
      return item.options.map((option, index) => ({
        label: option,
        run: () => ctx.answer(item.id, option),
        primary: index === 0,
        // A Captain lists its recommendation first.
        recommended: index === 0,
      }));
    case "blocked":
      return [
        { label: "Open thread", primary: true, run: () => ctx.navigate.toThread(item.threadId) },
      ];
    case "health":
      return healthActions(item, ctx);
  }
}

function healthActions(item: HealthItem, ctx: Parameters<typeof itemActions>[1]): Action[] {
  const action = item.action;
  if (action === null) return [];
  switch (action.kind) {
    case "retry-thread":
      return [
        {
          label: "Retry",
          primary: true,
          run: () => void ctx.sdk.threads.retry({ threadId: action.threadId }).catch(ctx.fail),
        },
      ];
    case "retry-answer":
      return [
        {
          label: "Retry",
          primary: true,
          run: () => ctx.answer(action.askId, action.answer),
        },
      ];
    case "open-thread":
      return [
        { label: "Open thread", primary: true, run: () => ctx.navigate.toThread(action.threadId) },
      ];
  }
}

export function OtherAnswer({
  value,
  onChange,
  onCancel,
  onSubmit,
  pending = false,
  showCancel = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  /** An answer is sending: Send waits, so one answer goes once. */
  pending?: boolean;
  showCancel?: boolean;
  /** The caller's spacing, such as the Overview's grid; the banner keeps its own. */
  className?: string;
}) {
  const cancelOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (!showCancel || !pending) onCancel();
  };
  return (
    <form
      className={cn("flex min-w-0 items-center gap-1.5", showCancel && "flex-1", className)}
      aria-busy={showCancel && pending}
      onSubmit={(event) => {
        event.preventDefault();
        const text = value.trim();
        if (text === "" || pending) return;
        const active = document.activeElement;
        // Send is about to be disabled. The read-only input can keep focus.
        if (
          showCancel &&
          (active === document.body ||
            (active instanceof HTMLButtonElement && active.form === event.currentTarget))
        ) {
          event.currentTarget.querySelector("input")?.focus({ preventScroll: true });
        }
        onSubmit(text);
      }}
    >
      <Input
        ref={focusOnMount}
        aria-label="Your answer"
        placeholder="Your answer"
        maxLength={200}
        value={value}
        readOnly={showCancel && pending}
        className={cn(TAP, showCancel ? "h-7 text-xs" : "h-8", "min-w-0 flex-1")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={cancelOnEscape}
      />
      {showCancel ? (
        <CompactButton
          type="submit"
          size="sm"
          className={TAP}
          disabled={value.trim() === "" || pending}
          onKeyDown={cancelOnEscape}
        >
          Send
        </CompactButton>
      ) : (
        <Button
          type="submit"
          size="sm"
          className={TAP}
          disabled={value.trim() === "" || pending}
          onKeyDown={cancelOnEscape}
        >
          Send
        </Button>
      )}
      {showCancel ? (
        <CompactButton
          type="button"
          size="sm"
          variant="ghost"
          className={cn(TAP, "px-2")}
          disabled={pending}
          onClick={onCancel}
          onKeyDown={cancelOnEscape}
        >
          Cancel
        </CompactButton>
      ) : null}
    </form>
  );
}

/** The answer box opens on request, so it takes focus as it mounts. */
function focusOnMount(node: HTMLInputElement | null): void {
  node?.focus();
}

/** The clock for ages and Later: a coarse tick, plus a wake when the next Later ends. */
export function useNow(...lists: (readonly QueueItem[] | undefined)[]): number {
  const [now, setNow] = useState(Date.now);
  const wake = nextWake(
    lists.flatMap((list) => list ?? []),
    now,
  );
  const tick = useCallback(() => setNow(Date.now()), []);
  useEffect(() => {
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [tick]);
  useEffect(() => {
    if (wake === null) return;
    const timer = setTimeout(tick, Math.max(0, wake - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [wake, tick]);
  return now;
}
