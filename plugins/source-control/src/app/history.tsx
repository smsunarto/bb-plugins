/**
 * GitButler's operation history for the thread's workspace: a snapshot it
 * took before each write, newest first. Read only, as in gitbutler
 * (`src/app/history-screen.tsx`): a restore rewrites the workspace, so each
 * row asks the agent for it in the composer instead. Read only once the
 * card is opened.
 */
import {
  experimental_copyToClipboard as copyToClipboard,
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
  useComposer,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useState } from "react";
import { describeProblem } from "../core/change.ts";
import type { OplogEntry } from "../core/oplog.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { absoluteTime, cx, shortAge, shortId } from "./format.ts";
import { Button } from "./components/ui/button.tsx";

/**
 * `but` titles most entries with the operation's own name, as in
 * "CreateCommit". Those read as words here. Any other title is kept as written.
 */
export function operationTitle(title: string): string {
  if (!/^(?:[A-Z][a-z0-9]+)+$/.test(title)) return title;
  const [first = "", ...rest] = title.split(/(?=[A-Z])/);
  return [first, ...rest.map((word) => word.toLowerCase())].join(" ");
}

/** What the reader asks the agent for a snapshot. The tab never restores one itself. */
export function restoreRequest(entry: OplogEntry, title: string, path: string): string {
  return `Restore the GitButler workspace to snapshot ${entry.id} (${title}) with \`but oplog restore\`.\n\nCheckout: ${path}`;
}

/** `text` as a Markdown quote, ending on a new line so the reader's own words follow it unquoted. */
function quoteMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").trim().split("\n");
  return `${lines.map((line) => (line.length > 0 ? `> ${line}` : ">")).join("\n")}\n`;
}

/** Quotes `text` at the end of the thread's composer and focuses it; null outside a thread. */
function useAskAgent(): ((text: string) => void) | null {
  const composer = useComposer();
  const ask = useCallback(
    (text: string) => {
      composer.insert(quoteMarkdown(text), { at: "end", block: true });
      composer.focus();
    },
    [composer],
  );
  return composer.scope.kind === "new-thread" ? null : ask;
}

const ICON_BUTTON = "size-6 text-muted-foreground";

function OperationRow({ entry, path, now }: { entry: OplogEntry; path: string; now: number }) {
  const ask = useAskAgent();
  const title = operationTitle(entry.title);
  const short = shortId(entry.id);
  return (
    <li
      className="flex min-w-0 items-start gap-2 border-t border-border-hairline px-3 py-2 first:border-t-0"
      data-testid="sc-oplog-row"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12px] leading-4 font-medium text-foreground" title={title}>
          {title}
        </span>
        {entry.body ? (
          <span className="truncate text-[11px] leading-4 text-muted-foreground" title={entry.body}>
            {entry.body}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] leading-4 text-muted-foreground">
          <code className="font-mono tabular-nums" translate="no">
            {short}
          </code>
          {entry.createdAt ? (
            <time dateTime={entry.createdAt} title={absoluteTime(entry.createdAt)}>
              {shortAge(entry.createdAt, now)}
            </time>
          ) : null}
        </span>
      </span>
      <Button
        variant="ghost"
        size="icon"
        className={ICON_BUTTON}
        aria-label={`Copy snapshot id ${short}`}
        title={`Copy snapshot id ${short}`}
        onClick={() => void copyToClipboard({ text: entry.id })}
      >
        <Icon name="Copy" className="size-3" aria-hidden />
      </Button>
      {ask ? (
        <Button
          variant="ghost"
          size="icon"
          className={ICON_BUTTON}
          aria-label={`Ask agent to restore snapshot ${short}`}
          title={`Ask agent to restore snapshot ${short}`}
          onClick={() => ask(restoreRequest(entry, title, path))}
        >
          <Icon name="MessageSquarePlus" className="size-3" aria-hidden />
        </Button>
      ) : null}
    </li>
  );
}

function Operations({ threadId, path, now }: { threadId: string; path: string; now: number }) {
  const oplog = useRpcQuery({
    contract: sourceControlContract,
    method: "oplog",
    input: { threadId },
  });
  const data = oplog.data;
  const note = (text: string) => (
    <p className="m-0 flex flex-wrap items-center gap-2 px-3 py-2 text-[12px] leading-4 text-muted-foreground">
      {text}
      {data?.ok === false || oplog.error ? (
        <Button variant="outline" onClick={() => void oplog.refetch()}>
          Try again
        </Button>
      ) : null}
    </p>
  );
  if (!data)
    return oplog.error
      ? note(`History failed to load. ${oplog.error.message}`)
      : note("Loading operations…");
  if (!data.ok) return note(`History unavailable. ${describeProblem(data.problem)}`);
  if (data.value.entries.length === 0)
    return note("No operations yet. GitButler lists each change it makes to this workspace here.");
  return (
    // Each row draws its own top rule: a divider utility would add a child selector the CSS guard refuses.
    <ol className="m-0 list-none p-0">
      {data.value.entries.map((entry) => (
        <OperationRow key={entry.id} entry={entry} path={path} now={now} />
      ))}
    </ol>
  );
}

/** A folded card at the tab's foot, for GitButler workspaces only. */
export function HistoryCard({
  threadId,
  path,
  now,
  className,
}: {
  threadId: string;
  path: string;
  now: number;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={className} aria-label="Operation history" data-testid="sc-history">
      <header className="flex min-h-10 min-w-0 items-center px-3 py-2">
        <button
          type="button"
          className="flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[4px] border-0 bg-transparent p-0 text-start"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon
            name="ChevronDown"
            className={cx(
              "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              !open && "-rotate-90",
            )}
            aria-hidden
          />
          <span className="truncate text-[13px] leading-5 font-semibold text-foreground">
            Operation history
          </span>
        </button>
      </header>
      {open ? (
        <div className="border-t border-border-hairline">
          <Operations threadId={threadId} path={path} now={now} />
        </div>
      ) : null}
    </section>
  );
}
