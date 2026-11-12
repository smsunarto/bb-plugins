/**
 * Ask agent (board A2): a floating bb conversation about the open Change,
 * in the review page itself. Nothing mounts until the first open; after it
 * the panel and its ThreadChat stay mounted, hidden while closed, so the
 * conversation, scroll and composer text survive close and reopen. It is not
 * modal: the page stays usable behind it.
 */
import {
  experimental_VoiceInputTextarea as VoiceInputTextarea,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  ThreadChat,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { sourceControlContract } from "../../contract/rpc.ts";
import type { ChangeKey } from "../../core/ids.ts";
import type { ChangeDetail } from "../../core/review.ts";
import { Button } from "../components/ui/button.tsx";
import { useEscapeLayer } from "../escape.ts";
import { cx } from "../format.ts";

/** Where a question comes from: the header's button, or a diff line with its text. */
export type AskRequest = {
  trigger: HTMLElement | null;
  /** A question typed under a diff line: sent at once, naming the line. */
  line?: { path: string; line: number | null; old: boolean; text: string };
};

const AskContext = createContext<((request: AskRequest) => void) | null>(null);

/** Opens the Ask panel; null outside the review page. */
export function useAskAgent(): ((request: AskRequest) => void) | null {
  return useContext(AskContext);
}

// ── Icons ──────────────────────────────────────────────────────────────

export function BotIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <path
        d="M12 8V4H8M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM2 14h2M20 14h2M15 13v2M9 13v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M3.5 8.5L8.5 3.5M4.5 3.5H8.5V7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
      <path
        d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M6 10V2M2.5 5.5L6 2L9.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Drag ───────────────────────────────────────────────────────────────

/**
 * Drag by the header: the panel's and the page's rects are read once on
 * pointer down; each move only writes a transform. Listeners live on the
 * header for the drag alone, through pointer capture.
 */
function useDrag(enabled: boolean) {
  const offset = useRef({ x: 0, y: 0 });
  return useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const node = event.currentTarget.closest("dialog");
      const page = node?.offsetParent;
      if (!enabled || !node || !page || event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button")) return;
      const handle = event.currentTarget;
      const rect = node.getBoundingClientRect();
      const area = page.getBoundingClientRect();
      const from = { x: event.clientX, y: event.clientY };
      const at = offset.current;
      // How far the pointer may go each way with the panel still inside the page.
      const min = { x: from.x - (rect.left - area.left), y: from.y - (rect.top - area.top) };
      const max = {
        x: from.x + (area.right - rect.right),
        y: from.y + (area.bottom - rect.bottom),
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
      const move = (next: PointerEvent) => {
        const x = Math.min(max.x, Math.max(min.x, next.clientX));
        const y = Math.min(max.y, Math.max(min.y, next.clientY));
        offset.current = { x: at.x + x - from.x, y: at.y + y - from.y };
        node.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px)`;
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
    [enabled],
  );
}

// ── Panel ──────────────────────────────────────────────────────────────

type Ready = Extract<ChangeDetail, { state: "change" }>;

/**
 * Below bb's `md` breakpoint the composer's context row renders no segments,
 * only the inherited permission label and the context meter, as a half-empty
 * strip above the input. bb's own phone thread page drops that row; so does
 * this panel. The Ask thread's permission mode is fixed by the plugin. The
 * row is bb's `div`; naming the tag keeps the rule out of the universal
 * bucket bb's style recalculation matches against every element.
 */
const PHONE_CHAT = "[&_div[data-follow-up-composer-footer]]:hidden";

const ICON_BUTTON = "size-6 px-0 text-muted-foreground hover:text-foreground";

/** Why questions cannot be sent now, or null. */
function unavailable(detail: Ready | null): string | null {
  const problem = detail?.problem;
  if (problem?.kind !== "host-offline" || detail?.revision?.source.kind !== "host") return null;
  return `${problem.host} is not answering, so questions wait until it is back.`;
}

/** Before the Ask thread exists: a plain composer whose first send forks it. */
function FirstQuestion({
  initial,
  onText,
  onSend,
  sending,
  blocked,
  focus,
}: {
  initial: string;
  onText(text: string): void;
  onSend(text: string): Promise<boolean>;
  sending: boolean;
  blocked: boolean;
  focus: { readonly current: HTMLTextAreaElement | null };
}) {
  const [text, setText] = useState(initial);
  const [voice, setVoice] = useState(false);
  const body = text.trim();
  const canSend = body.length > 0 && !sending && !blocked && !voice;
  const change = (value: string) => {
    setText(value);
    onText(value);
  };
  const submit = () => {
    if (!canSend) return;
    void onSend(body).then((sent) => {
      if (sent) change("");
      return sent;
    });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 px-3 pb-3">
      <p className="m-0 px-1 text-[13px] leading-5 text-muted-foreground">
        Ask about this change. The agent reads it where it lives and answers here.
      </p>
      <div className="flex flex-col gap-3 rounded-[12px] bg-surface-raised p-3">
        <VoiceInputTextarea
          ref={focus}
          value={text}
          onValueChange={change}
          onVoiceInputActiveChange={setVoice}
          onKeyDown={onKeyDown}
          rows={2}
          aria-label="Question"
          placeholder="Ask anything."
          className="w-full min-w-0 resize-none border-0 bg-transparent p-0 font-sans text-[13px] leading-5 text-foreground outline-none placeholder:text-(--tertiary-foreground)"
        />
        <div className="flex items-center justify-end">
          <Button
            variant="default"
            aria-label="Send question"
            disabled={!canSend}
            onClick={submit}
            className="size-6 rounded-full px-0 disabled:opacity-40"
          >
            <SendIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

function AskPanel({
  changeKey,
  open,
  phone,
  opens,
  threadId,
  sending,
  error,
  draft,
  onDraft,
  onSend,
  onClose,
}: {
  changeKey: ChangeKey;
  open: boolean;
  /** Times the panel was opened: each asks ThreadChat to focus its composer. */
  opens: number;
  phone: boolean;
  threadId: string | null;
  sending: boolean;
  error: string | null;
  draft: string;
  onDraft(text: string): void;
  onSend(text: string): Promise<boolean>;
  onClose(): void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeDetail",
    keys: [changeKey],
  });
  const found = query.data?.[changeKey];
  const detail = found?.state === "change" ? found : null;
  const blocked = unavailable(detail);
  const navigate = useBbNavigate();
  const full = useRpcMutation({ contract: sourceControlContract, method: "openAskAsThread" });
  const [fullError, setFullError] = useState<string | null>(null);
  const onPointerDown = useDrag(!phone);

  // Opening moves focus to the composer: the thread's through `opens`, or the first question's.
  useLayoutEffect(() => {
    if (open && !threadId) textarea.current?.focus();
  }, [open, threadId]);

  // Escape closes the panel before bb's own Escape ("Back to app") sees it.
  useEscapeLayer(panel, onClose, { open });

  const openFull = async () => {
    if (!threadId) return;
    setFullError(null);
    try {
      const result = await full.mutate({ key: changeKey });
      if (result.ok) navigate.toThread(result.threadId);
      else setFullError(result.message);
    } catch (reason) {
      setFullError(reason instanceof Error ? reason.message : "Couldn't open the thread.");
    }
  };

  const row = detail?.row;
  const title = row ? `Ask about ${row.number ? `#${row.number}` : row.branch}` : "Ask agent";
  const problem = error ?? fullError;
  return (
    <dialog
      ref={panel}
      open={open}
      aria-label={title}
      data-testid="sc-ask-panel"
      className={cx(
        "absolute inset-auto z-20 m-0 flex-col overflow-clip rounded-[12px] border border-solid border-border bg-popover p-0 text-foreground shadow-[0_16px_40px_#00000080] open:flex",
        phone
          ? "inset-x-4 bottom-4 h-[min(560px,calc(100%-32px))] w-auto max-w-none"
          : "right-6 bottom-6 h-[min(560px,calc(100%-48px))] w-[min(392px,calc(100%-32px))]",
      )}
    >
      <div
        onPointerDown={onPointerDown}
        className={cx(
          "flex h-10 shrink-0 touch-none items-center gap-2 border-b border-solid border-border-hairline ps-3 pe-2 select-none",
          !phone && "cursor-grab active:cursor-grabbing",
        )}
      >
        <span className="text-muted-foreground">
          <BotIcon />
        </span>
        <span className="shrink-0 text-[13px] leading-5 font-semibold text-foreground">
          {title}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
          {row?.title ?? ""}
        </span>
        <Button
          variant="ghost"
          aria-label="Open as full thread"
          title="Open as full thread"
          disabled={!threadId || full.isPending}
          onClick={() => void openFull()}
          className={ICON_BUTTON}
        >
          <OpenIcon />
        </Button>
        <Button
          variant="ghost"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          className={ICON_BUTTON}
        >
          <CloseIcon />
        </Button>
      </div>
      {blocked ? (
        <output
          data-testid="sc-ask-offline"
          className="flex shrink-0 items-center gap-2 border-b border-solid border-border-hairline bg-surface-recessed px-3 py-2 text-[12px] leading-4 text-muted-foreground"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
          {blocked}
        </output>
      ) : null}
      {problem ? (
        <p role="alert" className="m-0 shrink-0 px-3 pt-2 text-[12px] leading-4 text-warning">
          {problem}
        </p>
      ) : null}
      {threadId ? (
        <ThreadChat
          threadId={threadId}
          variant="compact"
          focusRequest={opens}
          className={cx("min-h-0 flex-1", phone && PHONE_CHAT)}
        />
      ) : (
        <FirstQuestion
          key={changeKey}
          initial={draft}
          onText={onDraft}
          onSend={onSend}
          sending={sending}
          blocked={blocked !== null}
          focus={textarea}
        />
      )}
    </dialog>
  );
}

// ── Host ───────────────────────────────────────────────────────────────

/**
 * Gives the page `useAskAgent` and draws the panel once it has been opened.
 * It sits outside the per-Change view, so switching Change keeps it mounted.
 */
export function AskHost({
  changeKey,
  phone,
  children,
}: {
  changeKey: ChangeKey | null;
  phone: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [opens, setOpens] = useState(0);
  const mounted = opens > 0;
  const [shown, setShown] = useState<ChangeKey | null>(changeKey);
  if (changeKey && changeKey !== shown) setShown(changeKey);
  if (!changeKey && open) setOpen(false);
  const trigger = useRef<HTMLElement | null>(null);
  // Typed first questions, by Change, for this page's life.
  const [drafts] = useState(() => new Map<string, string>());
  // Threads a question made, by Change, before the stored read catches up.
  const [made, setMade] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "ask" });
  const mutate = useRef(mutation.mutate);
  useLayoutEffect(() => {
    mutate.current = mutation.mutate;
  });

  const send = useCallback(
    async (
      key: ChangeKey,
      question: { text: string; path?: string; line?: number; old?: boolean },
    ) => {
      setSending(true);
      setError(null);
      try {
        const result = await mutate.current({ key, ...question });
        if (!result.ok) {
          setError(result.message);
          return false;
        }
        setMade((before) =>
          before[key] === result.threadId ? before : { ...before, [key]: result.threadId },
        );
        return true;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Couldn't send the question.");
        return false;
      } finally {
        setSending(false);
      }
    },
    [],
  );

  const openAsk = useCallback(
    (request: AskRequest) => {
      if (!changeKey) return;
      trigger.current = request.trigger;
      setOpens((count) => count + 1);
      setOpen(true);
      const { line } = request;
      if (line)
        void send(changeKey, {
          text: line.text,
          path: line.path,
          ...(line.line ? { line: line.line, old: line.old } : {}),
        });
    },
    [changeKey, send],
  );

  const close = useCallback(() => {
    setOpen(false);
    const back = trigger.current;
    if (back?.isConnected) back.focus();
  }, []);

  const asks = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "askForChange",
    keys: shown ? [shown] : [],
    enabled: mounted && shown !== null,
  });
  const threadId = shown ? (asks.data?.[shown]?.threadId ?? made[shown] ?? null) : null;
  const onDraft = useCallback(
    (text: string) => {
      if (shown) drafts.set(shown, text);
    },
    [shown, drafts],
  );
  const onSend = useCallback(
    (text: string) => (shown ? send(shown, { text }) : Promise.resolve(false)),
    [shown, send],
  );
  const value = useMemo(() => (changeKey ? openAsk : null), [changeKey, openAsk]);
  return (
    <AskContext.Provider value={value}>
      {children}
      {mounted && shown ? (
        <AskPanel
          changeKey={shown}
          open={open}
          opens={opens}
          phone={phone}
          threadId={threadId}
          sending={sending}
          error={error}
          draft={drafts.get(shown) ?? ""}
          onDraft={onDraft}
          onSend={onSend}
          onClose={close}
        />
      ) : null}
    </AskContext.Provider>
  );
}
