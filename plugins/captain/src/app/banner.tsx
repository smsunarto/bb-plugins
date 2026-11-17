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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
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
type ItemUi = { key: string; other: string | null; why: boolean; error: string | null };
const NO_UI: ItemUi = { key: "", other: null, why: false, error: null };
const NO_ITEMS: QueueItem[] = [];
/** Ages and Later both read the clock; a minute is fine-grained enough for either. */
const TICK_MS = 30_000;
const FAR = Number.MAX_SAFE_INTEGER;
/** Every control a phone user taps gets a 44px target. */
const TAP = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";

export function NeedsYouBanner() {
  const { scope } = useComposer();
  return scope.kind === "thread" ? <CaptainGate threadId={scope.threadId} /> : null;
}

function CaptainGate({ threadId }: { threadId: string }) {
  const captains = useRpcQuery({ contract: captainContract, method: "captains", input: NO_INPUT });
  return captains.data?.ids.includes(threadId) ? <Banner captainId={threadId} /> : null;
}

type Action = { label: string; run: () => void; primary?: boolean; hint?: string };

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
  // Per-item UI, tagged with its item so a new item starts collapsed with no answer box.
  const [ui, setUi] = useState<ItemUi>(() => ({ key: "", other: null, why: false, error: null }));
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

  const item = items[0] as QueueItem;
  const sending = isSending(item);
  const { other, why, error } = ui.key === item.key ? ui : NO_UI;
  const patchUi = (patch: Partial<Omit<ItemUi, "key">>) =>
    setUi((current) => ({
      ...(current.key === item.key ? current : NO_UI),
      ...patch,
      key: item.key,
    }));
  const setOther = (value: string | null) => patchUi({ other: value });
  const setError = (value: string | null) => patchUi({ error: value });

  const keepFocus = () => {
    if (root?.contains(document.activeElement)) root.focus();
  };
  const fail = (failure: unknown) => setError((failure as Error).message);
  const answer = (askId: string, text: string) => {
    keepFocus();
    setError(null);
    void resolve
      .mutate({ askId, answer: text })
      .then((result) => {
        if (result.state === "undelivered") setError(result.warnings.join("; "));
      })
      .catch(fail);
  };
  const later = () => {
    keepFocus();
    void defer.mutate({ captainId, key: item.key, action: "later" }).catch(fail);
  };
  const skip = () => {
    keepFocus();
    void defer.mutate({ captainId, key: item.key, action: "skip" }).catch(fail);
  };
  const actions = sending ? [] : itemActions(item, { answer, navigate, sdk, fail });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const key = event.key.toLowerCase();
    let run: (() => void) | undefined;
    if (/^[1-9]$/u.test(key)) run = actions[Number(key) - 1]?.run;
    // Enter on a focused button is that button's own click.
    else if (key === "enter" && target === event.currentTarget) run = actions[0]?.run;
    else if (key === "l" && !sending) run = later;
    else if (key === "s" && !sending) run = skip;
    if (run === undefined) return;
    event.preventDefault();
    run();
  };

  const detail = item.kind === "ask" ? item.detail : item.kind === "health" ? item.detail : null;
  const task = item.task;
  return (
    // A toolbar: one focus stop whose keys answer, defer and skip the item it shows.
    <div
      ref={setRoot}
      role="toolbar"
      tabIndex={0}
      aria-label={`Needs you, ${items.length} item${items.length === 1 ? "" : "s"}`}
      aria-keyshortcuts="1 2 3 4 5 6 7 8 9 Enter L S"
      data-bb-plugin="captain"
      data-testid="captain-needs-you"
      onKeyDown={onKeyDown}
      className="group flex min-w-0 flex-col gap-1.5 px-3 py-2 text-xs outline-none focus-visible:outline-1"
    >
      <header className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <span className="shrink-0 font-medium">Needs you · 1 of {items.length}</span>
        {crewError ? (
          <span className="min-w-0 truncate" title={crewError}>
            · crew not read
          </span>
        ) : null}
        <span className="ms-auto min-w-0 truncate tabular-nums" translate="no">
          {[task, item.since === null ? null : age(now, item.since)].filter(Boolean).join(" · ")}
        </span>
      </header>
      <p className="m-0 min-w-0 text-sm font-medium break-words text-foreground">{title(item)}</p>
      {detail ? (
        why ? (
          <Markdown content={detail} className="min-w-0 text-xs text-muted-foreground" />
        ) : (
          <p className="m-0 line-clamp-2 min-w-0 break-words whitespace-pre-line text-muted-foreground">
            {detail}
          </p>
        )
      ) : null}
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
          <Button
            key={action.label}
            type="button"
            size="sm"
            variant={action.primary ? "default" : "outline"}
            className={TAP}
            aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
            aria-description={action.hint}
            onClick={action.run}
          >
            <span
              aria-hidden
              className="hidden opacity-60 group-focus-within:inline pointer-coarse:hidden"
            >
              {index + 1}
            </span>
            {action.label}
          </Button>
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
        <span className="ms-auto flex items-center gap-1">
          {detail ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(TAP, "text-muted-foreground")}
              aria-expanded={why}
              onClick={() => patchUi({ why: !why })}
            >
              {why ? "Less" : "Why"}
            </Button>
          ) : null}
          {sending ? null : (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={cn(TAP, "text-muted-foreground")}
                aria-keyshortcuts="L"
                aria-description="Hide for an hour"
                onClick={later}
              >
                Later
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={cn(TAP, "text-muted-foreground")}
                aria-keyshortcuts="S"
                aria-description="Move to the back of the queue"
                onClick={skip}
              >
                Skip ›
              </Button>
            </>
          )}
        </span>
      </div>
      {error ? <p className="m-0 min-w-0 break-words text-destructive">{error}</p> : null}
    </div>
  );
}

function title(item: QueueItem): string {
  if (item.kind === "blocked") {
    return `${item.role ?? "Crew"} needs you: ${item.title}`;
  }
  return item.kind === "ask" ? item.text : item.title;
}

function itemActions(
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
        ...(index === 0 ? { hint: "Recommended" } : {}),
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

function OtherAnswer({
  value,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  return (
    <form
      className="flex min-w-0 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() !== "") onSubmit(value.trim());
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
      <Button type="submit" size="sm" className={TAP} disabled={value.trim() === ""}>
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
function useNow(...lists: (readonly QueueItem[] | undefined)[]): number {
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
