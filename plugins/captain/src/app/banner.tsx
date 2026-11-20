/**
 * Needs you: the queue above a Captain's composer, answered with a
 * click or a key. bb mounts composer banners on every thread, so the banner
 * reads one shared, cached list of Captain ids and renders nothing on any
 * other thread, before any other read. bb hides the card while it is empty.
 */
import {
  Markdown,
  experimental_usePluginId as usePluginId,
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
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  age,
  isSending,
  nextWake,
  orderQueue,
  type HealthItem,
  type QueueItem,
} from "../contract/queue.ts";
import { captainContract, TASK_PHASES, type BannerTask, type ChangeRef } from "../contract/rpc.ts";
import { surface } from "@bb-plugins/ui/surface";
import { Button } from "./components/ui/button.tsx";
import { Icon } from "./components/ui/icon.tsx";
import { Input } from "./components/ui/input.tsx";
import { cn } from "./lib/utils.ts";

const NO_INPUT = {};
type ItemUi = { key: string; other: string | null; error: string | null; planOpen: boolean };
const NO_UI: ItemUi = { key: "", other: null, error: null, planOpen: false };
const NO_ITEMS: QueueItem[] = [];
/** Ages and Later both read the clock; a minute is fine-grained enough for either. */
const TICK_MS = 30_000;
const FAR = Number.MAX_SAFE_INTEGER;
/** Every control a phone user taps gets a 44px target. */
export const TAP = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const ICON_BUTTON = cn(TAP, "size-8 shrink-0");
const COMPACT_ANSWER = "max-sm:gap-1 max-sm:px-1 max-sm:text-[11px]";

export function NeedsYouBanner() {
  const { scope } = useComposer();
  return scope.kind === "thread" ? <CaptainGate threadId={scope.threadId} /> : null;
}

function CaptainGate({ threadId }: { threadId: string }) {
  const captains = useRpcQuery({ contract: captainContract, method: "captains", input: NO_INPUT });
  return captains.data?.ids.includes(threadId) ? <Banner captainId={threadId} /> : null;
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
  const loaded = asks.data !== undefined;
  const tasks = useRpcQuery({
    contract: captainContract,
    method: "bannerTasks",
    input,
    enabled: loaded && items.length === 0 && crew.data !== undefined,
  });
  const since = useRpcQuery({
    contract: captainContract,
    method: "sinceYouLeft",
    input,
    enabled: loaded && items.length === 0,
  });
  useLastSeen(captainId);

  if (!loaded) return null;
  if (items.length === 0) {
    const active = tasks.data?.tasks ?? [];
    return (
      <>
        {active.length > 0 ? <InProgress tasks={active} now={now} /> : null}
        {since.data ? <SinceYouLeft captainId={captainId} since={since.data} /> : null}
      </>
    );
  }
  const laterCount = allItems.length - items.length;
  return (
    <Queue
      key={captainId}
      captainId={captainId}
      items={items}
      laterCount={laterCount}
      now={now}
      crewError={crew.error?.message}
    />
  );
}

function Queue({
  captainId,
  items,
  laterCount,
  now,
  crewError,
}: {
  captainId: string;
  items: readonly QueueItem[];
  laterCount: number;
  now: number;
  crewError: string | undefined;
}) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const id = useId();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const first = items[0]!;
  const item = items.find((entry) => entry.key === selected && !isSending(entry)) ?? first;
  const sending = isSending(item);
  const { other, error, planOpen, patchUi } = useItemUi(item.key);
  const setOther = (value: string | null) => patchUi({ other: value });
  const { answer, later, skip, fail } = useItemCommands(captainId, item.key, root, (value) =>
    patchUi({ error: value }),
  );
  const actions = sending ? [] : itemActions(item, { answer, navigate, sdk, fail });
  const kind = bannerKind(item);
  const showTabs = items.length > 1 || kind !== "plan" || laterCount > 0;
  const detail = item.kind === "blocked" ? null : item.detail;
  const plan = kind === "plan" && detail;
  const dismiss = () => {
    setSelected(null);
    skip();
  };
  const select = (entry: QueueItem) => {
    if (entry.key === item.key) return;
    patchUi({ other: null, error: null, planOpen: false });
    setSelected(entry.key);
  };

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
    if (!keyboardFocus.current) return;
    const swallow = toggleGone.current && event.key === "Enter";
    toggleGone.current = false;
    if (swallow) {
      event.preventDefault();
      return;
    }
    const run = shortcut(
      event,
      actions,
      sending ? null : { later, skip: dismiss },
      kind !== "ship",
    );
    if (run === undefined) return;
    event.preventDefault();
    run();
  };

  return (
    <div
      ref={setRoot}
      role="toolbar"
      tabIndex={0}
      aria-label={`Needs you, ${items.length} item${items.length === 1 ? "" : "s"}`}
      aria-keyshortcuts={kind === "ship" ? "1 2 L" : "1 2 3 4 5 6 7 8 9 Enter L"}
      data-bb-plugin="captain"
      data-bb-plugin-scope-captain=""
      data-testid="captain-needs-you"
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        keyboardFocus.current = event.target.matches(":focus-visible");
      }}
      onPointerDownCapture={() => {
        keyboardFocus.current = false;
      }}
      onBlur={() => {
        keyboardFocus.current = false;
        toggleGone.current = false;
      }}
      className="flex min-w-0 flex-col text-xs outline-none focus-visible:outline-1"
    >
      {showTabs ? (
        <QueueTabs
          id={id}
          items={items}
          selected={item}
          laterCount={laterCount}
          now={now}
          onSelect={select}
        />
      ) : null}
      <div
        id={`${id}-panel`}
        role={showTabs ? "tabpanel" : undefined}
        aria-labelledby={showTabs ? `${id}-${item.key}` : undefined}
        className={cn(
          showTabs && surface.divider,
          "grid min-w-0 grid-cols-[18px_minmax(0,1fr)] gap-x-2 gap-y-2.5 px-3 pt-2.5 pb-3",
        )}
      >
        <Icon
          name={BANNER_ICONS[kind]}
          aria-hidden
          className="mt-0.5 size-3.5 justify-self-center text-warning-text"
        />
        <Heading item={item} crewError={crewError} />
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
        {other !== null ? (
          <div className="col-start-2 min-w-0">
            <OtherAnswer
              value={other}
              onChange={setOther}
              onCancel={() => {
                setOther(null);
                root?.focus();
              }}
              onSubmit={(text) => item.kind === "ask" && answer(item.id, text)}
            />
          </div>
        ) : null}
        <AnswerRow
          item={item}
          kind={kind}
          actions={actions}
          later={later}
          openOther={other === null ? () => setOther("") : null}
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
        {error ? (
          <p className="col-start-2 m-0 min-w-0 break-words text-destructive">{error}</p>
        ) : null}
      </div>
    </div>
  );
}

function AnswerRow({
  item,
  kind,
  actions,
  later,
  openOther,
  plan,
}: {
  item: QueueItem;
  kind: BannerKind;
  actions: Action[];
  later: () => void;
  openOther: (() => void) | null;
  plan: { id: string; open: boolean; toggle: () => void } | null;
}) {
  if (item.kind === "ask" && item.answer !== null) {
    return (
      <output className="col-start-2 text-muted-foreground">
        Answered {JSON.stringify(item.answer)} · Sending…
      </output>
    );
  }
  const other = item.kind === "ask" && kind !== "ship" ? openOther : null;
  return (
    <div className="col-start-2 flex min-w-0 items-start gap-1.5 max-sm:col-span-2 max-sm:col-start-1">
      {actions.length > 0 || other || plan ? (
        <div
          data-captain-answers=""
          className="-m-0.5 flex min-w-0 items-center gap-1.5 overflow-x-auto p-0.5"
        >
          {actions.map((action, index) => (
            <ActionButton key={action.label} action={action} index={index} bannerKind={kind} />
          ))}
          {plan ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={cn(TAP, COMPACT_ANSWER)}
              aria-expanded={plan.open}
              aria-controls={plan.id}
              onClick={plan.toggle}
            >
              <Icon name="FileText" aria-hidden data-icon="inline-start" />
              {plan.open ? "Close plan" : "Read plan"}
            </Button>
          ) : null}
          {other ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(TAP, COMPACT_ANSWER, "text-muted-foreground")}
              onClick={other}
            >
              Other…
            </Button>
          ) : null}
        </div>
      ) : null}
      <Button
        type="button"
        size="icon"
        variant="outline"
        className={cn(ICON_BUTTON, "text-muted-foreground")}
        aria-label="Later"
        aria-keyshortcuts="L"
        aria-description="Hide for an hour"
        onClick={later}
      >
        <Icon name="Clock" aria-hidden />
      </Button>
    </div>
  );
}

/** Per-item UI, tagged with its item so a new item starts collapsed with no answer box. */
function useItemUi(key: string) {
  const [ui, setUi] = useState<ItemUi>(NO_UI);
  const { other, error, planOpen } = ui.key === key ? ui : NO_UI;
  const patchUi = (patch: Partial<Omit<ItemUi, "key">>) =>
    setUi((current) => ({ ...(current.key === key ? current : NO_UI), ...patch, key }));
  return { other, error, planOpen, patchUi };
}

/**
 * Answer, Later and Skip for the item on show. Each keeps keyboard focus on
 * the banner when the clicked button unmounts, and reports a failure inline.
 */
export function useItemCommands(
  captainId: string,
  key: string,
  root: HTMLElement | null,
  setError: (value: string | null) => void,
) {
  const { resolve, defer } = useQueueMutations(captainId);
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
    keepFocus();
    setError(null);
    return deliver(askId, text);
  };
  const deferItem = (action: "later" | "skip") => {
    keepFocus();
    void defer.mutate({ captainId, key, action }).catch(fail);
  };
  return {
    answer,
    later: () => deferItem("later"),
    skip: () => deferItem("skip"),
    fail,
    /** An answer is on its way to the server. */
    pending: resolve.isPending,
  };
}

/** The answer and defer mutations, each updating the cached queue before the server replies. */
function useQueueMutations(captainId: string) {
  const resolve = useRpcMutation({
    contract: captainContract,
    method: "resolveAsk",
    optimistic({ askId, answer }, cache) {
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
  items,
  selected,
  laterCount,
  now,
  onSelect,
}: {
  id: string;
  items: readonly QueueItem[];
  selected: QueueItem;
  laterCount: number;
  now: number;
  onSelect: (item: QueueItem) => void;
}) {
  const waiting = items.filter((item) => !isSending(item));
  const tabs = waiting.length > 0 ? waiting : items;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 px-3 py-1.5">
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground" aria-live="polite">
        <span className="min-w-4.5 rounded-full bg-(--surface-attention) px-1 text-center font-semibold text-warning-text">
          {waiting.length}
        </span>
        waiting
      </span>
      <div
        role="tablist"
        tabIndex={-1}
        aria-label="Captain queue"
        className="-m-0.5 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto p-0.5 max-sm:basis-full"
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
              id={`${id}-${entry.key}`}
              role="tab"
              type="button"
              size="sm"
              variant="ghost"
              aria-controls={`${id}-panel`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={cn(
                TAP,
                "h-6 max-w-42 shrink-0 gap-1.5 px-2",
                active ? "bg-(--surface-selected) text-foreground" : "text-muted-foreground",
              )}
              onClick={() => onSelect(entry)}
            >
              <Icon name={BANNER_ICONS[bannerKind(entry)]} aria-hidden data-icon="inline-start" />
              <span title={tabTitle(entry)} className="min-w-0 truncate [unicode-bidi:plaintext]">
                {tabTitle(entry)}
              </span>
              {entry.since === null ? null : (
                <span className="shrink-0 font-normal opacity-75">{age(now, entry.since)}</span>
              )}
            </Button>
          );
        })}
        {laterCount > 0 ? (
          <span
            className={cn(surface.edge, "shrink-0 rounded-md px-2 py-0.5 text-muted-foreground")}
          >
            {laterCount} later
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Heading({ item, crewError }: { item: QueueItem; crewError: string | undefined }) {
  const text = title(item);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p
        dir="auto"
        className="m-0 text-[13px] leading-[18px] font-medium wrap-anywhere text-foreground"
      >
        {text}
      </p>
      {item.task && !text.includes(item.task) ? (
        <span className="font-mono text-[11px] text-muted-foreground">{item.task}</span>
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
 * card (a new ask's options are capped at 12 columns, but older asks may be
 * longer) and keeps "Recommended" whole.
 */
export function ActionButton({
  action,
  index,
  shortcuts = true,
  bannerKind,
}: {
  action: Action;
  index: number;
  /** False where no key handler answers by number, as outside the banner. */
  shortcuts?: boolean;
  bannerKind?: BannerKind;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={action.primary ? "default" : "outline"}
      className={cn(
        TAP,
        bannerKind
          ? cn(COMPACT_ANSWER, "shrink-0")
          : "h-auto min-h-8 max-w-full py-1.5 text-start whitespace-normal",
        bannerKind &&
          action.primary &&
          "bg-(--foreground) text-background hover:bg-(--foreground)/90",
      )}
      aria-keyshortcuts={shortcuts && index < 9 ? String(index + 1) : undefined}
      onClick={action.run}
    >
      {bannerKind && action.recommended ? (
        <Icon
          name={bannerKind === "ship" ? "GitMerge" : "Star"}
          className={cn("size-3", bannerKind !== "ship" && "fill-current")}
          aria-hidden
          data-icon="inline-start"
        />
      ) : null}
      <span className="min-w-0 text-start break-words [unicode-bidi:plaintext]">
        {action.label}
      </span>
      {action.recommended ? (
        <span
          className={bannerKind ? "sr-only" : "shrink-0 font-normal whitespace-nowrap opacity-70"}
        >
          Recommended
        </span>
      ) : null}
    </Button>
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

/** The full width of the fade opens the preview. Its center labels the action. */
function Detail({ content, onToggleGone }: { content: string; onToggleGone: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useToggleShown({ box, onToggleGone, open, content });
  const id = useId();
  return (
    <div className="relative min-w-0">
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
      <Button
        ref={toggle}
        type="button"
        size="sm"
        variant="ghost"
        hidden
        className={cn(
          "z-1 flex w-full items-end justify-center rounded-none px-1 pb-0.5 text-muted-foreground [&[hidden]]:hidden",
          open
            ? "relative h-7"
            : "absolute inset-x-0 bottom-0 h-11 bg-linear-to-b from-transparent via-(--surface-raised-solid) to-(--surface-raised-solid)",
          TAP,
        )}
        aria-controls={id}
        aria-expanded={open}
        onClick={() => {
          if (open && box.current !== null) box.current.scrollTop = 0;
          setOpen(!open);
        }}
      >
        <span
          className={cn(
            surface.edge,
            "flex items-center gap-1 rounded-full bg-(--surface-raised-solid) px-2.5 py-0.5 text-[11px]",
          )}
        >
          {open ? "Less" : "More"}
          <Icon name={open ? "ChevronUp" : "ChevronDown"} aria-hidden className="size-3" />
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
 * Shows More only when the collapsed preview leaves something out: lines past
 * the clamp, or a block it shows in summary. The ResizeObserver callback
 * measures after layout and, being before paint, sets the toggle's `hidden`
 * there, so More paints with the text it belongs to; a state update would
 * paint a frame later. The box's size changes as bb's renderer adds its
 * content after the first commit, so summarised blocks are found then too.
 * Measured only while collapsed, so Less stays shown (and focused) through
 * the collapse until measured. Should the preview turn out to fit, the toggle
 * goes; if it held focus, `onToggleGone` first keeps focus in the banner
 * rather than letting it fall to the page. New content under a box that stays
 * two lines tall changes no size, so it observes afresh. React sets `hidden`
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
    if (open || node === null || button === null || typeof ResizeObserver === "undefined") return;
    const sizes = new ResizeObserver(() => {
      const clipped =
        node.scrollHeight > node.clientHeight + 1 || node.querySelector(SUMMARISED) !== null;
      if (!clipped && button.contains(document.activeElement)) onToggleGone();
      button.hidden = !clipped;
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
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  /** An answer is sending: Send waits, so one answer goes once. */
  pending?: boolean;
}) {
  return (
    <form
      className="flex min-w-0 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() !== "" && !pending) onSubmit(value.trim());
      }}
    >
      <Input
        ref={focusOnMount}
        aria-label="Your answer"
        placeholder="Your answer"
        maxLength={200}
        value={value}
        className={cn(TAP, "h-8 min-w-0 flex-1")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <Button type="submit" size="sm" className={TAP} disabled={value.trim() === "" || pending}>
        Send
      </Button>
    </form>
  );
}

const PHASE_LABEL = { plan: "Plan", implement: "Impl", review: "Review", merge: "Merge" };

function InProgress({ tasks, now }: { tasks: BannerTask[]; now: number }) {
  const [open, setOpen] = useState(true);
  const id = useId();
  return (
    <section
      aria-label="No action needed"
      data-bb-plugin="captain"
      data-bb-plugin-scope-captain=""
      className="min-w-0 text-xs"
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={cn(TAP, "h-9 w-full justify-start gap-2 px-3 font-normal")}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <Icon name="CircleCheck" aria-hidden className="text-muted-foreground" />
        No action needed
        <span className="text-muted-foreground">· {tasks.length} in progress</span>
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          aria-hidden
          className="ms-auto text-muted-foreground"
        />
      </Button>
      <ul
        id={id}
        hidden={!open}
        className={cn("m-0 max-h-56 list-none overflow-y-auto p-0", !open && "hidden")}
      >
        {tasks.map((task) => (
          <li
            key={task.key}
            className={cn(
              surface.divider,
              "flex h-9 min-w-0 items-center gap-2.5 ps-3 pe-1.5 pointer-coarse:h-11",
            )}
          >
            <span className="w-19 shrink-0 truncate font-mono text-[11px] text-muted-foreground max-sm:w-auto max-sm:max-w-16">
              {task.key}
            </span>
            <span title={task.title} className="min-w-0 flex-1 truncate text-[13px]">
              {task.title}
            </span>
            <TaskPhase task={task} />
            {task.updatedAt > 0 ? (
              <span className="w-7 shrink-0 text-end text-muted-foreground tabular-nums max-sm:hidden">
                {age(now, task.updatedAt)}
              </span>
            ) : null}
            <Button
              asChild
              size="icon"
              variant="ghost"
              className={cn(ICON_BUTTON, "text-muted-foreground")}
            >
              <a
                href={taskHref(task.key)}
                aria-label={`Open task ${task.key}`}
                title={`Open task ${task.key}`}
              >
                <Icon name="ListTodo" aria-hidden />
              </a>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TaskPhase({ task }: { task: BannerTask }) {
  const current = TASK_PHASES.findLast(
    (phase) => task.roles.includes(phase) || (phase === "review" && task.status === "in_review"),
  );
  return (
    <>
      <span className="w-24 shrink-0 truncate text-muted-foreground max-md:hidden">
        {task.roles.length > 0 && current ? `crew · ${PHASE_LABEL[current].toLowerCase()}` : null}
      </span>
      <span className="flex w-29.5 shrink-0 items-center gap-2 max-sm:w-auto">
        {current ? (
          <>
            <span aria-hidden className="flex items-center gap-0.5 max-sm:hidden">
              {TASK_PHASES.map((phase, index) => (
                <span
                  key={phase}
                  className={cn(
                    "h-1 w-3 rounded-sm bg-foreground",
                    phase === current
                      ? "opacity-100"
                      : index < TASK_PHASES.indexOf(current)
                        ? "opacity-45"
                        : "opacity-15",
                  )}
                />
              ))}
            </span>
            <span
              className="font-medium"
              aria-label={current === "implement" ? "Implement" : undefined}
            >
              {PHASE_LABEL[current]}
            </span>
          </>
        ) : null}
      </span>
    </>
  );
}

function taskHref(key: string): string {
  return `/plugins/scott-tasks/tasks/task/${encodeURIComponent(key)}`;
}

type Since = { cutoff: number | null; done: ChangeRef[]; ready: ChangeRef[]; failed: ChangeRef[] };

/** One line of what changed since you last had this thread open; nothing when nothing did. */
function SinceYouLeft({ captainId, since }: { captainId: string; since: Since }) {
  const [open, setOpen] = useState<keyof Omit<Since, "cutoff"> | null>(null);
  const pluginId = usePluginId();
  const seen = useRpcMutation({ contract: captainContract, method: "markSeen" });
  const counts = (
    [
      ["done", since.done, "done"],
      ["ready", since.ready, "ready to ship"],
      ["failed", since.failed, "failed"],
    ] as const
  ).filter(([, refs]) => refs.length > 0);
  if (counts.length === 0) return null;
  const refs = open === null ? [] : since[open];
  return (
    <section
      aria-label="Since you left"
      data-bb-plugin="captain"
      data-bb-plugin-scope-captain=""
      data-testid="captain-since"
      className="flex min-w-0 flex-col gap-1 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
        <span>All clear · since you left:</span>
        {counts.map(([kind, list, label], index) => (
          <Separated key={kind} first={index === 0}>
            <Button
              type="button"
              size="sm"
              variant="link"
              className={cn(TAP, "h-auto px-0 py-0")}
              aria-expanded={open === kind}
              onClick={() => setOpen((current) => (current === kind ? null : kind))}
            >
              {list.length} {label}
            </Button>
          </Separated>
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(TAP, "ms-auto text-muted-foreground")}
          disabled={seen.isPending}
          onClick={() =>
            void seen.mutate({ captainId, client: clientId(pluginId) }).catch(() => undefined)
          }
        >
          Mark seen
        </Button>
      </div>
      {refs.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {refs.map((ref) => (
            <li key={ref.task ?? ref.threadId}>
              <RefLink change={ref} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Separated({ first, children }: { first: boolean; children: ReactNode }) {
  return (
    <>
      {first ? null : <span aria-hidden>·</span>}
      {children}
    </>
  );
}

/** A task opens in Tasks; a failed thread with no task opens the thread. */
function RefLink({ change }: { change: ChangeRef }) {
  const navigate = useBbNavigate();
  const label = change.task ?? change.threadId ?? "";
  if (change.task === null) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={TAP}
        onClick={() => change.threadId && navigate.toThread(change.threadId)}
      >
        {label}
      </Button>
    );
  }
  return (
    <Button asChild size="sm" variant="outline" className={TAP}>
      <a href={taskHref(change.task)} title={change.title ?? undefined}>
        {label}
      </a>
    </Button>
  );
}

/** The answer box opens on request, so it takes focus as it mounts. */
function focusOnMount(node: HTMLInputElement | null): void {
  node?.focus();
}

/** One id per browser profile, so last-seen times are kept per client. Read when sending, not in render. */
function clientId(pluginId: string): string {
  const key = `${pluginId}:client`;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored) return stored;
    const id = `c_${Math.random().toString(36).slice(2, 12)}`;
    window.localStorage.setItem(key, id);
    return id;
  } catch {
    return "c_unknown";
  }
}

/**
 * Advance the cutoff when the pane is hidden: on leaving the thread or hiding
 * the page. Never while it shows, so the line reads against the previous value.
 */
function useLastSeen(captainId: string): void {
  const pluginId = usePluginId();
  const seen = useRpcMutation({ contract: captainContract, method: "markSeen" });
  // The latest mutate, without making it an effect dependency: a re-run would mark seen.
  const mark = useRef(seen.mutate);
  useEffect(() => {
    mark.current = seen.mutate;
  });
  useEffect(() => {
    const leave = () =>
      void mark.current({ captainId, client: clientId(pluginId) }).catch(() => undefined);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      leave();
    };
  }, [captainId, pluginId]);
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
