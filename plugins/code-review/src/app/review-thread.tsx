import { useId, useState } from "react";
import { Markdown, UrlLink, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PullRequest, ReviewThread, ThreadComment } from "../shared/schema.ts";
import {
  CommentForm,
  DRAFT_NOTE,
  forgetDraftText,
  refreshAfterDraft,
  useDraftText,
} from "./comment-form.tsx";
import { Button } from "./components/ui/button.tsx";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";
import { plural, threadLines } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";
import { Avatar, Chip, Timestamp } from "./status.tsx";

/*
 * Review threads as the diff shows them: each comment, edit and delete for
 * the viewer's drafts, and a reply box. The forms that write live in
 * `comment-form.tsx`.
 */

const ICON_BUTTON = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  CONTROL_HOVER_TRANSITION,
);

/** One comment. A draft can be edited or deleted; a posted one links to GitHub. */
function Comment({ pr, comment }: { pr: PullRequest; comment: ThreadComment }) {
  // An edit in progress is kept like any other typed text, and reopens with it.
  const [text, setText] = useDraftText(`edit:${comment.id}`);
  const [editing, setEditing] = useState(text !== "");
  const [confirming, setConfirming] = useState(false);
  const author = comment.author?.login ?? "ghost";
  const edit = rpc.editDraft.useMutation({
    onSuccess: async () => {
      await refreshAfterDraft(pr);
      forgetDraftText(`edit:${comment.id}`);
    },
  });
  const remove = rpc.deleteDraft.useMutation({ onSuccess: () => refreshAfterDraft(pr) });

  const stopEditing = () => {
    setText("");
    edit.reset();
    setEditing(false);
  };

  return (
    <article className="flex min-w-0 flex-col gap-1 px-3 py-2" aria-label={`Comment by ${author}`}>
      <header className="flex min-h-6 min-w-0 items-center gap-1.5">
        <Avatar login={author} url={comment.author?.avatarUrl ?? null} />
        <span className="truncate font-semibold">{author}</span>
        {comment.isDraft ? (
          <>
            <span className="shrink-0 text-muted-foreground">
              <Timestamp iso={comment.createdAt} />
            </span>
            <Chip icon="Edit" tone="text-attention">
              Pending
            </Chip>
          </>
        ) : (
          <UrlLink
            href={comment.url}
            className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <Timestamp iso={comment.createdAt} />
          </UrlLink>
        )}
        {comment.isDraft && !editing && !confirming ? (
          <span className="ml-auto flex shrink-0 items-center">
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label="Edit draft comment"
              title="Edit"
              onClick={() => {
                setText(comment.body);
                setEditing(true);
              }}
            >
              <Icon name="Edit" className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label="Delete draft comment"
              title="Delete"
              onClick={() => setConfirming(true)}
            >
              <Icon name="Trash2" className="size-3.5" aria-hidden />
            </button>
          </span>
        ) : null}
      </header>
      {editing ? (
        <CommentForm
          label="Edit draft comment"
          submitLabel="Save"
          value={text}
          onChange={setText}
          pending={edit.isPending}
          error={edit.error ? errorText(edit.error) : null}
          onCancel={stopEditing}
          onSubmit={() =>
            edit.mutate(
              { account: pr.account, commentId: comment.id, body: text.trim() },
              {
                onSuccess: () => {
                  setText("");
                  setEditing(false);
                },
              },
            )
          }
        />
      ) : (
        <Markdown content={comment.body} className="min-w-0 text-xs [overflow-wrap:anywhere]" />
      )}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-surface-destructive px-2 py-1.5">
          <span className="mr-auto text-destructive-text">Delete this draft comment?</span>
          {remove.error ? (
            <span role="alert" className="w-full text-destructive-text">
              {errorText(remove.error)}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 font-normal"
            disabled={remove.isPending}
            onClick={() => {
              remove.reset();
              setConfirming(false);
            }}
          >
            Keep
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-6 gap-1.5 px-2.5 [&_[data-icon-root]]:size-3"
            disabled={remove.isPending}
            aria-busy={remove.isPending}
            // The Delete that asked is gone, so the focus lands on its answer.
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onClick={() => remove.mutate({ account: pr.account, commentId: comment.id })}
          >
            {remove.isPending ? (
              <Icon name="Loading" className="motion-safe:animate-spin" aria-hidden />
            ) : null}
            Delete
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** The reply box: a closed prompt until clicked, then a form that adds a draft reply. */
function Reply({ pr, thread }: { pr: PullRequest; thread: ReviewThread }) {
  // Text typed as one account never opens in the form of another.
  const key = `reply:${pr.account.toLowerCase()}:${thread.id}`;
  const [text, setText] = useDraftText(key);
  // A reply typed before the card last unmounted opens with it.
  const [open, setOpen] = useState(text !== "");
  const reply = rpc.replyDraft.useMutation({
    onSuccess: async () => {
      await refreshAfterDraft(pr);
      forgetDraftText(key);
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        className={cn(
          "flex h-7 w-full cursor-text items-center rounded-md border border-input bg-background px-2 text-left text-muted-foreground hover:border-ring",
          CONTROL_HOVER_TRANSITION,
        )}
        onClick={() => setOpen(true)}
      >
        Reply…
      </button>
    );
  }
  return (
    <CommentForm
      label="Reply"
      placeholder="Reply"
      submitLabel="Add reply to review"
      value={text}
      onChange={setText}
      pending={reply.isPending}
      error={reply.error ? errorText(reply.error) : null}
      note={DRAFT_NOTE}
      onCancel={() => {
        setText("");
        reply.reset();
        setOpen(false);
      }}
      onSubmit={() =>
        reply.mutate(
          {
            account: pr.account,
            pullRequestId: pr.id,
            threadId: thread.id,
            body: text.trim(),
          },
          {
            onSuccess: () => {
              setText("");
              setOpen(false);
            },
          },
        )
      }
    />
  );
}

/**
 * The tail of the hunk an outdated thread was written on, so its comment
 * still has the code it is about.
 */
function HunkExcerpt({ diffHunk }: { diffHunk: string }) {
  const lines = diffHunk.split("\n").filter((line) => !line.startsWith("@@"));
  // Each line keyed by where it sits in the hunk, which never moves.
  const start = Math.max(0, lines.length - 4);
  const tail = lines.slice(start).map((text, offset) => ({ text, row: start + offset }));
  if (tail.length === 0) return null;
  return (
    <pre className="overflow-x-auto border-b border-border bg-background px-3 py-1.5 font-mono text-[11px] leading-5 text-muted-foreground">
      {tail.map(({ text, row }) => (
        <span
          key={row}
          className={cn(
            "block",
            text.startsWith("+") && "text-diff-added",
            text.startsWith("-") && "text-diff-removed",
          )}
        >
          {text || " "}
        </span>
      ))}
    </pre>
  );
}

/** A resolved thread's fold: the word, and while folded, who said what first. */
function ResolvedToggle({
  thread,
  open,
  bodyId,
  label,
  onToggle,
}: {
  thread: ReviewThread;
  open: boolean;
  bodyId: string;
  /** The thread's lines, for one listed away from them. */
  label: string | null;
  onToggle: () => void;
}) {
  const first = thread.comments[0];
  const preview = !open && first ? first : null;
  const more = !open && thread.comments.length > 1;
  return (
    <button
      type="button"
      className="inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left hover:text-foreground"
      aria-expanded={open}
      aria-controls={bodyId}
      onClick={onToggle}
    >
      <Icon
        name="ChevronRight"
        className={cn(
          "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
          open && "rotate-90",
        )}
        aria-hidden
      />
      <Chip icon="CircleCheck" tone="text-success">
        Resolved
      </Chip>
      {label ? <span className="shrink-0">{label}</span> : null}
      {preview ? (
        <span className="min-w-0 truncate">
          <span className="font-semibold">{preview.author?.login ?? "ghost"}</span>:{" "}
          {preview.body.split("\n", 1)[0]}
        </span>
      ) : null}
      {more ? (
        <span className="ml-auto shrink-0">{plural(thread.comments.length, "comment")}</span>
      ) : null}
    </button>
  );
}

/**
 * A review thread: its comments, then a reply box. A resolved thread starts
 * folded to one line, as on GitHub. `showContext` adds the line label and the
 * hunk excerpt, for threads listed away from their line.
 */
export function ReviewThreadView({
  pr,
  thread,
  showContext = false,
}: {
  pr: PullRequest;
  thread: ReviewThread;
  showContext?: boolean;
}) {
  // Folded while resolved, until the reader says otherwise.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? !thread.isResolved;
  const bodyId = useId();
  const where = threadLines(thread);
  const hasHeader = thread.isResolved || showContext;

  return (
    <section
      aria-label={`Comment thread, ${where.toLowerCase()}`}
      className="min-w-0 overflow-hidden rounded-md border border-border bg-card font-sans text-xs leading-normal text-foreground"
    >
      {hasHeader ? (
        <div className="flex min-h-7 min-w-0 items-center gap-1.5 border-b border-border px-2 py-1 text-muted-foreground">
          {thread.isResolved ? (
            <ResolvedToggle
              thread={thread}
              open={open}
              bodyId={bodyId}
              label={showContext ? where : null}
              onToggle={() => setToggled(!open)}
            />
          ) : (
            <span className="min-w-0 truncate">{where}</span>
          )}
          {thread.isOutdated ? (
            <Chip icon="Clock" tone="text-warning-text">
              Outdated
            </Chip>
          ) : null}
        </div>
      ) : null}
      <div id={bodyId} hidden={!open}>
        {open ? (
          <>
            {showContext && thread.diffHunk ? <HunkExcerpt diffHunk={thread.diffHunk} /> : null}
            <div className="divide-y divide-border">
              {thread.comments.map((comment) => (
                <Comment key={comment.id} pr={pr} comment={comment} />
              ))}
            </div>
            <div className="border-t border-border px-3 py-2">
              <Reply pr={pr} thread={thread} />
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
