import {
  experimental_PluginRpcCallError as PluginRpcCallError,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb-plugins/ui/button";
import { Textarea } from "@bb-plugins/ui/textarea";
import { useId, useState, type ReactElement } from "react";
import {
  contract,
  MAX_TEXT_LENGTH,
  type GrokbotAction,
  type GrokbotStatus,
  type LogEntry,
  type SendOutcome,
} from "../shared/contract.ts";

const LOG_PREVIEW_LIMIT = 15;

const selectClass =
  "w-full min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-50";

const EXAMPLE_CONFIG = `{
  "url": "https://grok-bot.example/hooks/bb",
  "key": "<automation key>",
  "bots": [{ "id": "research", "name": "Research bot" }]
}`;

/** The Grok Bot page: compose, ping, and the recent send log. */
export function GrokbotPage(_props: PluginNavPanelProps): ReactElement {
  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <GrokbotPanel threadId={null} />
      </div>
    </div>
  );
}

/** "Send this thread to Grok Bot": the same composer with the thread's context attached. */
export function GrokbotThreadTab({ threadId }: { threadId: string }): ReactElement {
  return (
    <div className="space-y-4">
      <GrokbotPanel threadId={threadId} />
    </div>
  );
}

export function GrokbotPanel({ threadId }: { threadId: string | null }): ReactElement {
  const status = useRpcQuery({ contract, method: "status", input: null });
  const log = useRpcQuery({ contract, method: "log", input: { limit: LOG_PREVIEW_LIMIT } });
  const ready = status.data?.state === "ready";
  return (
    <>
      <StatusSection
        status={status.data}
        loading={status.isLoading}
        error={status.error?.message ?? null}
        recheck={() => void status.refetch()}
      />
      {threadId ? <ThreadContextCard threadId={threadId} /> : null}
      <Composer
        bots={status.data?.state === "ready" ? status.data.bots : []}
        enabled={ready}
        threadId={threadId}
        onSent={() => {
          // A refusal may mean the config changed since the page loaded. The server
          // also invalidates the log after each append (CLI sends included); this
          // refetch covers a send whose response, and invalidation, never arrived.
          void status.refetch();
          void log.refetch();
        }}
      />
      <SendLog
        entries={log.data?.entries}
        loading={log.isLoading}
        error={log.error?.message ?? null}
        retry={() => void log.refetch()}
      />
    </>
  );
}

function StatusSection(props: {
  status: GrokbotStatus | undefined;
  loading: boolean;
  error: string | null;
  recheck: () => void;
}): ReactElement {
  if (props.loading && !props.status) {
    return <div aria-busy="true" className="h-9 animate-pulse rounded-md bg-muted" />;
  }
  if (!props.status) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        <span>Cannot read the Grok Bot status: {props.error ?? "unknown error"}</span>
        <Button size="sm" variant="outline" onClick={props.recheck}>
          Retry
        </Button>
      </div>
    );
  }
  if (props.status.state === "ready") {
    const bots = props.status.bots.length;
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground">
          Configured
        </span>
        <span className="min-w-0 break-all text-muted-foreground">
          {props.status.configPath} ·{" "}
          {bots === 0 ? "no bots listed" : `${bots} bot${bots === 1 ? "" : "s"}`}
        </span>
      </div>
    );
  }
  return (
    <section
      aria-label="Grok Bot is not configured"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Not configured</h2>
        <Button size="sm" variant="outline" onClick={props.recheck}>
          Check again
        </Button>
      </div>
      <p className="break-words text-sm text-muted-foreground">{props.status.reason}</p>
      <p className="text-sm text-muted-foreground">
        Create the file on the bb server's machine with mode 600. Sending stays off until it reads
        cleanly:
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs text-foreground">
        {EXAMPLE_CONFIG}
      </pre>
    </section>
  );
}

function ThreadContextCard({ threadId }: { threadId: string }): ReactElement {
  const thread = useRpcQuery({ contract, method: "threadContext", input: { threadId } });
  const rows: [string, string | null | undefined][] = [
    ["Thread", thread.data?.title ?? threadId],
    ["Project", thread.data?.project],
    ["Branch", thread.data?.branch],
  ];
  return (
    <section aria-label="Thread context" className="rounded-lg border border-border bg-card p-3">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Sends with this thread's context
      </h2>
      {thread.error ? (
        <p className="text-sm text-destructive">Cannot read this thread: {thread.error.message}</p>
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate text-foreground">
                {thread.isLoading ? (
                  <span className="inline-block h-4 w-32 animate-pulse rounded bg-muted align-middle" />
                ) : (
                  (value ?? "—")
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

type LastResult =
  | { kind: "outcome"; action: GrokbotAction; outcome: SendOutcome; logged: boolean }
  | { kind: "refused"; action: GrokbotAction; message: string }
  | { kind: "unknown"; action: GrokbotAction; message: string };

/** Codes the server returns before any webhook request; anything else may have been delivered. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "conflict",
  "forbidden",
  "invalid",
  "invalid_input",
  "not_found",
]);

function failureKind(error: unknown): "refused" | "unknown" {
  return error instanceof PluginRpcCallError && NOT_SENT_CODES.has(error.code)
    ? "refused"
    : "unknown";
}

function Composer(props: {
  bots: readonly { id: string; name: string }[];
  enabled: boolean;
  threadId: string | null;
  onSent: () => void;
}): ReactElement {
  const ids = { text: useId(), bot: useId() };
  const [text, setText] = useState("");
  const [targetBot, setTargetBot] = useState("");
  const [last, setLast] = useState<LastResult | null>(null);
  const send = useRpcMutation({ contract, method: "send" });
  const selectedBot = props.bots.some((bot) => bot.id === targetBot) ? targetBot : "";

  const run = async (action: GrokbotAction) => {
    try {
      const { outcome, logged } = await send.mutate({
        action,
        targetBot: selectedBot || null,
        ...(action === "message" ? { text } : {}),
        threadId: props.threadId,
      });
      setLast({ kind: "outcome", action, outcome, logged });
      if (outcome.ok && action === "message") setText("");
    } catch (error) {
      setLast({
        kind: failureKind(error),
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      props.onSent();
    }
  };

  const disabled = !props.enabled || send.isPending;
  const canSend = !disabled && text.trim() !== "";
  return (
    <form
      aria-label="Send to Grok Bot"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) void run("message");
      }}
    >
      <div className="space-y-1">
        <label htmlFor={ids.bot} className="text-xs font-medium text-muted-foreground">
          Target bot
        </label>
        <select
          id={ids.bot}
          className={selectClass}
          value={selectedBot}
          disabled={disabled}
          onChange={(event) => setTargetBot(event.target.value)}
        >
          <option value="">No target (the router decides)</option>
          {props.bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name === bot.id ? bot.id : `${bot.name} (${bot.id})`}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.text} className="text-xs font-medium text-muted-foreground">
          Message
        </label>
        <Textarea
          id={ids.text}
          rows={4}
          maxLength={MAX_TEXT_LENGTH}
          value={text}
          disabled={disabled}
          placeholder={
            props.enabled
              ? props.threadId
                ? "What should Grok Bot do with this thread?"
                : "Message Grok Bot"
              : "Configure Grok Bot to send messages"
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSend) {
              event.preventDefault();
              void run("message");
            }
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!canSend}>
          {send.isPending && send.pendingInputs[0]?.action === "message"
            ? "Sending…"
            : props.threadId
              ? "Send thread"
              : "Send"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => void run("ping")}
        >
          {send.isPending && send.pendingInputs[0]?.action === "ping" ? "Pinging…" : "Ping"}
        </Button>
        <ResultLine last={last} />
      </div>
    </form>
  );
}

function ResultLine({ last }: { last: LastResult | null }): ReactElement | null {
  if (!last) return null;
  const verb = last.action === "ping" ? "Ping" : "Message";
  if (last.kind === "refused") {
    return <output className="min-w-0 text-sm text-destructive">Not sent: {last.message}</output>;
  }
  if (last.kind === "unknown") {
    return (
      <output className="min-w-0 text-sm text-destructive">
        Delivery unknown: {last.message} · Check Recent sends before sending again
      </output>
    );
  }
  const { ok, status, error, durationMs } = last.outcome;
  const unlogged = last.logged ? "" : " · not saved to the send log";
  return (
    <output className={`min-w-0 text-sm ${ok ? "text-foreground" : "text-destructive"}`}>
      {ok
        ? `${verb} sent · HTTP ${status} · ${durationMs}ms${unlogged}`
        : `${verb} failed · ${error ?? `HTTP ${status}`} · ${durationMs}ms${unlogged}`}
    </output>
  );
}

function SendLog(props: {
  entries: LogEntry[] | undefined;
  loading: boolean;
  error: string | null;
  retry: () => void;
}): ReactElement {
  return (
    <section aria-label="Send log" className="space-y-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Recent sends
      </h2>
      {props.error ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>
            {props.entries ? "Could not refresh the send log" : "Could not load the send log"}:{" "}
            {props.error}
          </span>
          <Button size="sm" variant="outline" onClick={props.retry}>
            Retry
          </Button>
        </div>
      ) : null}
      {props.loading && !props.entries ? (
        <div aria-busy="true" className="h-16 animate-pulse rounded-md bg-muted" />
      ) : !props.entries ? null : props.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {props.entries.map((entry) => (
            <LogRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LogRow({ entry }: { entry: LogEntry }): ReactElement {
  const result = entry.ok
    ? `HTTP ${entry.status}`
    : (entry.error ?? (entry.status === null ? "failed" : `HTTP ${entry.status}`));
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-sm">
      <span
        className={`text-xs font-medium ${entry.ok ? "text-foreground" : "text-destructive"}`}
        aria-label={entry.ok ? "sent" : "failed"}
      >
        {entry.ok ? "●" : "✕"}
      </span>
      <span className="font-medium text-foreground">{entry.action}</span>
      {entry.target_bot ? (
        <span className="text-muted-foreground">→ {entry.target_bot}</span>
      ) : null}
      {entry.context ? (
        <span className="truncate text-muted-foreground">
          {entry.context.project ?? entry.context.thread_id}
          {entry.context.branch ? ` · ${entry.context.branch}` : ""}
        </span>
      ) : null}
      <span
        className={`ml-auto text-xs ${entry.ok ? "text-muted-foreground" : "text-destructive"}`}
      >
        {result}
      </span>
      <time className="text-xs text-muted-foreground" dateTime={entry.ts}>
        {formatTime(entry.ts)}
      </time>
      {entry.action === "message" && entry.textPreview ? (
        <p className="basis-full truncate text-muted-foreground">{entry.textPreview}</p>
      ) : null}
    </li>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
