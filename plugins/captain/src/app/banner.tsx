/**
 * Needs you: one item at a time above a Captain's composer, answered with a
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
  Fragment,
  useCallback,
  useEffect,
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
import { captainContract, type ChangeRef } from "../contract/rpc.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { cn } from "./lib/utils.ts";

const NO_INPUT = {};
type ItemUi = { key: string; other: string | null; error: string | null };
const NO_UI: ItemUi = { key: "", other: null, error: null };
const NO_ITEMS: QueueItem[] = [];
/** Ages and Later both read the clock; a minute is fine-grained enough for either. */
const TICK_MS = 30_000;
const FAR = Number.MAX_SAFE_INTEGER;
/** Every control a phone user taps gets a 44px target. */
export const TAP = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
/** Later and Skip: a short pair that sits in the title's first line. */
const DEFER = "h-6 px-2 text-muted-foreground";

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
  const items = useMemo(
    () => orderQueue([...(asks.data?.items ?? NO_ITEMS), ...(crew.data?.items ?? NO_ITEMS)], now),
    [asks.data, crew.data, now],
  );
  const loaded = asks.data !== undefined;
  const since = useRpcQuery({
    contract: captainContract,
    method: "sinceYouLeft",
    input,
    enabled: loaded && items.length === 0,
  });
  useLastSeen(captainId);

  if (!loaded) return null;
  if (items.length === 0) {
    return since.data ? <SinceYouLeft captainId={captainId} since={since.data} /> : null;
  }
  return <Queue captainId={captainId} items={items} now={now} crewError={crew.error?.message} />;
}

function Queue({
  captainId,
  items,
  now,
  crewError,
}: {
  captainId: string;
  items: QueueItem[];
  now: number;
  crewError: string | undefined;
}) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const item = items[0] as QueueItem;
  const sending = isSending(item);
  const { other, error, patchUi } = useItemUi(item.key);
  const setOther = (value: string | null) => patchUi({ other: value });
  const { answer, later, skip, fail } = useItemCommands(captainId, item.key, root, (value) =>
    patchUi({ error: value }),
  );
  const actions = sending ? [] : itemActions(item, { answer, navigate, sdk, fail });

  // When More or Less goes while it has focus, focus lands on the banner, where
  // Enter answers. The Enter that follows was meant for the toggle: it does nothing.
  const toggleGone = useRef(false);
  const onToggleGone = useCallback(() => {
    root?.focus();
    toggleGone.current = true;
  }, [root]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const swallow = toggleGone.current && event.key === "Enter";
    toggleGone.current = false;
    if (swallow) {
      event.preventDefault();
      return;
    }
    const run = shortcut(event, actions, sending ? null : { later, skip });
    if (run === undefined) return;
    event.preventDefault();
    run();
  };

  const detail = item.kind === "blocked" ? null : item.detail;
  return (
    // A toolbar: one focus stop whose keys answer, defer and skip the item it shows.
    <div
      ref={setRoot}
      role="toolbar"
      tabIndex={0}
      aria-label={`Needs you, ${items.length} item${items.length === 1 ? "" : "s"}`}
      aria-keyshortcuts="1 2 3 4 5 6 7 8 9 Enter L S"
      data-bb-plugin="captain"
      data-bb-plugin-scope-captain=""
      data-testid="captain-needs-you"
      onKeyDown={onKeyDown}
      onBlur={() => {
        toggleGone.current = false;
      }}
      className="flex min-w-0 flex-col gap-2 px-3 py-2 text-xs outline-none focus-visible:outline-1"
    >
      {/* On touch, Later's and Skip's targets end with the heading and More's starts with the
          detail (see Heading and Detail), so this gap need not part them. */}
      <div className="flex min-w-0 flex-col gap-0.5 pointer-coarse:gap-1.5">
        <Heading
          title={title(item)}
          meta={itemMeta(item, items.length, now)}
          crewError={crewError}
          defer={sending ? null : { later, skip }}
        />
        {detail ? <Detail key={item.key} content={detail} onToggleGone={onToggleGone} /> : null}
      </div>
      {other !== null ? (
        <OtherAnswer
          value={other}
          onChange={setOther}
          onCancel={() => {
            setOther(null);
            root?.focus();
          }}
          onSubmit={(text) => item.kind === "ask" && answer(item.id, text)}
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

/** Per-item UI, tagged with its item so a new item starts collapsed with no answer box. */
function useItemUi(key: string) {
  const [ui, setUi] = useState<ItemUi>(NO_UI);
  const { other, error } = ui.key === key ? ui : NO_UI;
  const patchUi = (patch: Partial<Omit<ItemUi, "key">>) =>
    setUi((current) => ({ ...(current.key === key ? current : NO_UI), ...patch, key }));
  return { other, error, patchUi };
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
): (() => void) | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const target = event.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return undefined;
  const key = event.key.toLowerCase();
  if (/^[1-9]$/u.test(key)) return actions[Number(key) - 1]?.run;
  // Enter on a focused button is that button's own click. A held Enter repeats
  // onto the banner when the button it pressed goes away; that is no answer.
  if (key === "enter") {
    return target === event.currentTarget && !event.repeat ? actions[0]?.run : undefined;
  }
  if (key === "l") return defer?.later;
  if (key === "s") return defer?.skip;
  return undefined;
}

/** Place in the queue (only when there is more than one), task and age. */
function itemMeta(item: QueueItem, count: number, now: number): string[] {
  return [
    count > 1 ? `1 of ${count}` : null,
    item.task,
    item.since === null ? null : age(now, item.since),
  ].filter((part): part is string => Boolean(part));
}

/**
 * The title, with the item's task and age trailing it so they take no row of
 * their own, and Later and Skip in the corner: deferring is not answering.
 */
function Heading({
  title: text,
  meta,
  crewError,
  defer,
}: {
  title: string;
  meta: string[];
  crewError: string | undefined;
  defer: { later: () => void; skip: () => void } | null;
}) {
  const parts = meta.map((text) => ({ text, error: null as string | null }));
  if (crewError) parts.push({ text: "crew not read", error: crewError });
  return (
    <div className="flex min-w-0 items-start gap-2">
      <p className="m-0 min-w-0 flex-1 py-px text-sm font-medium break-words text-foreground">
        {/* Isolated, so a right-to-left title cannot reorder the meta; each takes
            its base direction from its text, while the margin follows the card's
            direction. The title's end margin, not a leading pad, spaces them, so
            a wrapped meta starts flush. */}
        <span className="me-1.5 [unicode-bidi:plaintext]">{text}</span>
        {parts.length > 0 ? " " : null}
        {parts.length > 0 ? (
          // Each part stays whole and the meta wraps between parts, so it never
          // overflows a narrow card and keeps the title's baseline.
          <span
            className="text-xs font-normal text-muted-foreground tabular-nums [unicode-bidi:plaintext]"
            translate="no"
          >
            {parts.map((part, index) => (
              <Fragment key={part.text}>
                <span
                  className={cn("whitespace-nowrap", part.error && "text-destructive")}
                  title={part.error ?? undefined}
                >
                  {part.text}
                  {index < parts.length - 1 ? " ·" : null}
                </span>
                {index < parts.length - 1 ? " " : null}
              </Fragment>
            ))}
          </span>
        ) : null}
      </p>
      {defer ? (
        <span className="-me-1.5 -mt-0.5 flex shrink-0 items-center pointer-coarse:-mt-3">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(TAP, DEFER)}
            aria-keyshortcuts="L"
            aria-description="Hide for an hour"
            onClick={defer.later}
          >
            Later
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(TAP, DEFER)}
            aria-keyshortcuts="S"
            aria-description="Move to the back of the queue"
            onClick={defer.skip}
          >
            Skip
          </Button>
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
}: {
  action: Action;
  index: number;
  /** False where no key handler answers by number, as outside the banner. */
  shortcuts?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={action.primary ? "default" : "outline"}
      className={cn(TAP, "h-auto min-h-8 max-w-full py-1.5 text-start whitespace-normal")}
      aria-keyshortcuts={shortcuts && index < 9 ? String(index + 1) : undefined}
      onClick={action.run}
    >
      <span className="min-w-0 text-start break-words [unicode-bidi:plaintext]">
        {action.label}
      </span>
      {action.recommended ? (
        <span className="shrink-0 font-normal whitespace-nowrap opacity-70">Recommended</span>
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
 * Collapsed: two lines ending in an ellipsis, capped at three line heights.
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
  "line-clamp-2 max-h-[3lh] [&_p]:my-0 [&_ul]:my-0 [&_ol]:my-0 [&_li]:my-0 [&_blockquote]:my-0 [&_h1]:my-0 [&_h2]:my-0 [&_h3]:my-0 [&_h4]:my-0 [&_h5]:my-0 [&_h6]:my-0 [&_hr]:my-0 [&_button]:hidden [&_div:has(>div>div>button)]:contents [&_div:has(>div>button)]:contents [&_div:has(>pre)>div]:hidden [&_div:has(>div>div>button)>div~div]:hidden [&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent! [&_pre]:p-0 [&_pre>code]:leading-snug! [&_pre_span]:leading-snug! [&_pre_span]:text-inherit! [&_div:has(>div>table)]:contents [&_div:has(>table)]:contents [&_table]:block [&_table]:border-0 [&_thead]:contents [&_tbody]:contents [&_tr]:block [&_th]:inline [&_th]:border-0 [&_th]:p-0 [&_th]:font-medium [&_td]:inline [&_td]:border-0 [&_td]:p-0 [&_th+th]:before:content-['_·_'] [&_td+td]:before:content-['_·_'] [&_img]:my-0! [&_img]:inline [&_img]:h-[1lh] [&_img]:w-auto [&_img]:align-top!";
/**
 * Blocks the preview shows only in summary: a code block or diagram, found by
 * its frame's buttons (a diagram draws only once visible), a table, an image.
 */
const SUMMARISED = "button, table, img";

/**
 * The detail, two lines until opened. More shows only when those two lines
 * leave something out; it and Less sit in a fixed column beside the text, so
 * More appearing never narrows the text it measures. On touch, the toggle's
 * 44px target reaches below its line, never above, so it stays clear of
 * Skip's above it.
 */
function Detail({ content, onToggleGone }: { content: string; onToggleGone: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useToggleShown({ box, onToggleGone, open, content });
  return (
    <div className="flex min-w-0 items-end gap-2">
      <div
        ref={box}
        data-detail-box=""
        className={cn(
          "min-w-0 flex-1",
          DETAIL_BOX,
          open ? "max-h-[10lh] overflow-y-auto" : PREVIEW,
        )}
        onScroll={(event) => {
          if (open) return;
          const active = document.activeElement;
          // Only keyboard focus on a link past the shown lines scrolls the clipped box
          // without a pointer: show the whole detail so the focused link is in view. Any
          // other scroll (a press on a half-hidden chip, find-in-page) snaps back.
          if (
            active instanceof HTMLElement &&
            event.currentTarget.contains(active) &&
            active.matches(":focus-visible")
          ) {
            setOpen(true);
          } else {
            event.currentTarget.scrollTop = 0;
          }
        }}
      >
        <Markdown content={content} className={DETAIL_TEXT} />
      </div>
      <div className="flex w-11 shrink-0 justify-end">
        {/* Hidden from its first paint; useToggleShown shows it once measured. One
            line tall, so showing it changes no height with a mouse. */}
        <Button
          ref={toggle}
          type="button"
          size="sm"
          variant="ghost"
          hidden
          className={cn(
            TAP,
            "h-auto px-1.5 py-0 leading-snug text-muted-foreground pointer-coarse:-mb-1.5 [&[hidden]]:hidden",
          )}
          aria-expanded={open}
          onClick={() => {
            // The preview starts at its first line, wherever the open detail was scrolled.
            if (open && box.current !== null) box.current.scrollTop = 0;
            setOpen(!open);
          }}
        >
          {open ? "Less" : "More"}
        </Button>
      </div>
    </div>
  );
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
      <a
        href={`/plugins/scott-tasks/tasks/task/${encodeURIComponent(change.task)}`}
        title={change.title ?? undefined}
      >
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
