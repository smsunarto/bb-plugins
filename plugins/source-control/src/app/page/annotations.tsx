/**
 * What the diff shows under a line (boards A and A3): each finding or
 * comment with the checkbox the rail and the thread tab share, its replies,
 * the reader's pending drafts with Edit and Delete, and the composer that
 * writes one. Text being typed lives in its composer alone, so a keystroke
 * redraws that composer and nothing else.
 */
import { Markdown } from "@get-bb/plugin-sdk/app";
import { memo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Anchor, Draft } from "../../core/items.ts";
import { Button } from "../components/ui/button.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { useEscapeLayer } from "../escape.ts";
import { cx } from "../format.ts";
import { newDraftId, type ReviewActions } from "../review-data.ts";
import { useAskAgent } from "./ask-panel.tsx";
import { itemAuthor, type Entry, type ItemEntry } from "../review-model.ts";
import {
  BotMark,
  Checkbox,
  FixingMark,
  Me,
  GitHubAvatar,
  PriorityChip,
  StatePill,
} from "../review-ui.tsx";

/** A new comment being written on a line. */
export type ComposerEntry = { kind: "composer"; id: string; anchor: Anchor };
export type LineEntry = Entry | ComposerEntry;

/** What every annotation of one file shares; one object for the file's life. */
export type AnnotationContext = {
  actions: ReviewActions;
  closeComposer(): void;
};

/** Only for tests: told each time a line's annotations draw. */
export const annotationProbe: { onRender: ((key: string) => void) | null } = { onRender: null };

const TEXT_BUTTON =
  "shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[12px] leading-4 text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-60";

function blockClass(inset: boolean): string {
  // Under a diff line, the block starts at the code column; above the diff, it lines up with it.
  return cx(
    "flex min-w-0 flex-col gap-2 border-y border-solid border-border-hairline bg-sidebar py-3 pe-4 text-start whitespace-normal",
    inset ? "ps-4" : "ps-15",
  );
}

// ── Composer ───────────────────────────────────────────────────────────

function Composer({
  actions,
  draftId,
  anchor,
  replyTo,
  initial,
  submitLabel,
  primary,
  onDone,
}: {
  actions: ReviewActions;
  draftId: string;
  anchor: Anchor;
  replyTo: string | null;
  initial: string;
  submitLabel: string;
  /** A new comment's button is filled; a reply's is outlined. */
  primary: boolean;
  onDone: () => void;
}) {
  // A new comment can be asked of the agent instead (a guess: A2 and A3 draw no line entry).
  const askAgent = useAskAgent();
  const canAsk = askAgent !== null && replyTo === null && initial === "";
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = text.trim();
  // Escape inside the composer closes it; the page stays.
  const root = useRef<HTMLDivElement>(null);
  useEscapeLayer(root, onDone);
  const submit = () => {
    if (!body || saving) return;
    setSaving(true);
    setError(null);
    actions.saveDraft({ id: draftId, anchor, body, replyTo }).then(
      () => onDone(),
      (reason: unknown) => {
        setSaving(false);
        setError(reason instanceof Error ? reason.message : "Couldn't save the comment.");
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div ref={root} className="flex min-w-0 flex-col gap-2" data-testid="sc-composer">
      <div className="flex items-center gap-2">
        <Me />
      </div>
      <Textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by the reader's own click
        autoFocus
        value={text}
        aria-label={replyTo ? "Reply" : "Comment"}
        placeholder={replyTo ? "Reply…" : "Leave a comment…"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className={cx(
          "w-full min-w-0 resize-y rounded-[8px] border border-solid border-primary bg-background px-3 py-2 font-sans text-[13px] leading-5 text-foreground shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_15%,transparent)] outline-none placeholder:text-(--tertiary-foreground) focus-visible:ring-0",
          replyTo ? "min-h-10" : "min-h-14",
        )}
      />
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        {error ? (
          <span role="alert" className="min-w-0 flex-1 text-[12px] leading-4 text-warning">
            {error}
          </span>
        ) : null}
        {canAsk ? (
          <button
            type="button"
            data-testid="sc-ask-line"
            className={cx(TEXT_BUTTON, "me-auto flex items-center gap-1.5 px-2")}
            disabled={!body || saving}
            onClick={(event) => {
              askAgent({
                trigger: event.currentTarget,
                line: {
                  path: anchor.path,
                  line: anchor.line,
                  old: anchor.side === "LEFT",
                  text: body,
                },
              });
              onDone();
            }}
          >
            Ask agent
          </button>
        ) : null}
        <button type="button" className={cx(TEXT_BUTTON, "px-2")} onClick={onDone}>
          Cancel
        </button>
        <Button
          variant={primary ? "default" : "outline"}
          disabled={!body || saving}
          onClick={submit}
          className={cx("h-6 px-3 font-semibold", !primary && "border-border")}
        >
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}

// ── Drafts ─────────────────────────────────────────────────────────────

/** A pending draft: "You · Pending", Edit and Delete, then its text, or its composer while edited. */
const DraftBody = memo(function DraftBody({
  draft,
  actions,
}: {
  draft: Draft;
  actions: ReviewActions;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (editing)
    return (
      <Composer
        actions={actions}
        draftId={draft.id}
        anchor={draft.anchor}
        replyTo={draft.replyTo}
        initial={draft.body}
        submitLabel="Save"
        primary={draft.replyTo === null}
        onDone={() => setEditing(false)}
      />
    );
  const onDelete = () => {
    setDeleting(true);
    setError(null);
    actions.deleteDraft(draft.id).catch((reason: unknown) => {
      setDeleting(false);
      setError(reason instanceof Error ? reason.message : "Couldn't delete the comment.");
    });
  };
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="sc-draft" data-draft={draft.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Me />
        {draft.state === "outdated" ? (
          <StatePill tone="quiet">Outdated</StatePill>
        ) : (
          <StatePill tone="warning">Pending</StatePill>
        )}
        <span className="min-w-0 flex-1" />
        <button type="button" className={TEXT_BUTTON} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className={TEXT_BUTTON} disabled={deleting} onClick={onDelete}>
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
      <p className="m-0 min-w-0 text-[13px] leading-5 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
        {draft.body}
      </p>
      {error ? (
        <span role="alert" className="text-[12px] leading-4 text-warning">
          {error}
        </span>
      ) : null}
    </div>
  );
});

// ── Items ──────────────────────────────────────────────────────────────

function Reply({ author, body }: { author: string; body: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <GitHubAvatar login={author} className="size-3.5" />
        <span className="text-[12px] leading-4 font-semibold text-foreground">{author}</span>
      </div>
      <Markdown
        content={body}
        className="min-w-0 text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]"
      />
    </div>
  );
}

function ItemMark({ item }: { item: ItemEntry["item"] }) {
  if (item.priority !== null) return <PriorityChip priority={item.priority} />;
  if (item.origin.kind === "forge" && !item.origin.bot)
    return <GitHubAvatar login={item.origin.author} className="size-3.5" />;
  return <BotMark />;
}

/** "Ask agent to fix", or "Agent fixing" once a batch took it. */
function FixToggle({ entry, actions }: { entry: ItemEntry; actions: ReviewActions }) {
  const { item, checked } = entry;
  if (entry.fixing)
    return (
      <span
        className="flex h-6 shrink-0 items-center gap-2 px-2"
        data-testid="sc-annotation-fixing"
      >
        <FixingMark />
        <span className="text-[12px] leading-4 font-medium whitespace-pre text-warning">
          Agent fixing
        </span>
      </span>
    );
  return (
    <Checkbox
      checked={checked}
      label="Ask agent to fix"
      testId="sc-annotation-check"
      onChange={(next) => actions.setSelected([item.id], next)}
      className={cx(
        "h-6 gap-2 rounded-[6px] px-2",
        checked
          ? "bg-[color-mix(in_oklab,var(--primary)_12%,transparent)]"
          : "hover:bg-surface-raised",
      )}
    >
      <span className="text-[12px] leading-4 font-medium whitespace-pre text-foreground">
        Ask agent to fix
      </span>
    </Checkbox>
  );
}

/** Dismiss for a bb finding, which has no thread to answer; Reply for a GitHub thread. */
function ItemAction({
  item,
  actions,
  replying,
  onReply,
}: {
  item: ItemEntry["item"];
  actions: ReviewActions;
  replying: boolean;
  onReply: () => void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (item.origin.kind !== "bb")
    return (
      <button
        type="button"
        className={TEXT_BUTTON}
        data-testid="sc-reply"
        disabled={replying}
        onClick={onReply}
      >
        Reply
      </button>
    );
  const onDismiss = async () => {
    setDismissing(true);
    setError(null);
    try {
      await actions.dismissItem(item.id);
    } catch (reason) {
      setDismissing(false);
      setError(reason instanceof Error ? reason.message : "Couldn't dismiss it.");
    }
  };
  return (
    <>
      <button
        type="button"
        className={TEXT_BUTTON}
        data-testid="sc-dismiss"
        disabled={dismissing}
        onClick={() => void onDismiss()}
      >
        {dismissing ? "Dismissing…" : "Dismiss"}
      </button>
      {error ? (
        <span role="alert" className="basis-full text-[12px] leading-4 text-warning">
          {error}
        </span>
      ) : null}
    </>
  );
}

const ItemBlock = memo(function ItemBlock({
  entry,
  inset,
  context,
}: {
  entry: ItemEntry;
  inset: boolean;
  context: AnnotationContext;
}) {
  const { item } = entry;
  const [replying, setReplying] = useState<string | null>(null);
  const thread = item.replies.length > 0 || entry.replies.length > 0 || replying !== null;
  return (
    <div
      className={blockClass(inset)}
      data-sc-anchor={item.id}
      data-testid="sc-annotation"
      data-item={item.id}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ItemMark item={item} />
        <span className="min-w-0 truncate text-[12px] leading-4 font-semibold text-foreground">
          {item.title ?? itemAuthor(item)}
        </span>
        {entry.label ? (
          <span className="min-w-0 truncate text-[12px] leading-4 text-(--tertiary-foreground)">
            · {entry.label}
          </span>
        ) : null}
        {entry.outdated ? <StatePill tone="quiet">Outdated</StatePill> : null}
        {item.state === "resolved" ? <StatePill tone="quiet">Resolved</StatePill> : null}
        <span className="min-w-0 flex-1" />
        <FixToggle entry={entry} actions={context.actions} />
        <ItemAction
          item={item}
          actions={context.actions}
          replying={replying !== null}
          onReply={() => setReplying(newDraftId())}
        />
      </div>
      <Markdown
        content={item.body}
        className="min-w-0 text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]"
      />
      {thread ? (
        <div className="flex min-w-0 gap-2">
          <span aria-hidden className="w-0.5 shrink-0 rounded-full bg-border" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {item.replies.map((reply) => (
              <Reply key={reply.id} author={reply.author} body={reply.body} />
            ))}
            {entry.replies.map((draft) => (
              <DraftBody key={draft.id} draft={draft} actions={context.actions} />
            ))}
            {replying !== null ? (
              <Composer
                actions={context.actions}
                draftId={replying}
                anchor={item.anchor}
                replyTo={item.id}
                initial=""
                submitLabel="Add reply"
                primary={false}
                onDone={() => setReplying(null)}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
});

const DraftBlock = memo(function DraftBlock({
  draft,
  inset,
  context,
}: {
  draft: Draft;
  inset: boolean;
  context: AnnotationContext;
}) {
  return (
    <div className={blockClass(inset)} data-sc-anchor={`draft:${draft.id}`}>
      <DraftBody draft={draft} actions={context.actions} />
    </div>
  );
});

const NewComment = memo(function NewComment({
  entry,
  inset,
  context,
}: {
  entry: ComposerEntry;
  inset: boolean;
  context: AnnotationContext;
}) {
  // One id per opened composer: saving it twice is one draft.
  const [draftId] = useState(newDraftId);
  return (
    <div className={blockClass(inset)}>
      <Composer
        actions={context.actions}
        draftId={draftId}
        anchor={entry.anchor}
        replyTo={null}
        initial=""
        submitLabel="Add comment"
        primary
        onDone={context.closeComposer}
      />
    </div>
  );
});

/** Everything under one line (or above the diff), in order. Redraws only when its entries change. */
export const LineThread = memo(function LineThread({
  lineKey,
  entries,
  inset,
  context,
}: {
  lineKey: string;
  entries: readonly LineEntry[];
  inset: boolean;
  context: AnnotationContext;
}) {
  annotationProbe.onRender?.(lineKey);
  const blocks: ReactNode[] = entries.map((entry) => {
    if (entry.kind === "item")
      return <ItemBlock key={entry.id} entry={entry} inset={inset} context={context} />;
    if (entry.kind === "draft")
      return <DraftBlock key={entry.id} draft={entry.draft} inset={inset} context={context} />;
    return <NewComment key={entry.id} entry={entry} inset={inset} context={context} />;
  });
  return (
    <div
      className="flex min-w-0 flex-col font-sans"
      data-testid="sc-line-thread"
      data-line={lineKey}
    >
      {blocks}
    </div>
  );
});

/** The "+" Pierre shows in the gutter of the hovered line (board A3). */
export function AddCommentButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Comment on this line"
      title="Comment on this line"
      data-testid="sc-add-comment"
      onClick={onClick}
      className="flex size-[18px] cursor-pointer items-center justify-center rounded-[4px] border-0 bg-(--primary) p-0 text-primary-foreground"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path
          d="M5 2V8M2 5H8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
