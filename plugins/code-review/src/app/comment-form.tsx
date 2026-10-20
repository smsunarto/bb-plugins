import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PullRequest, ReviewThread } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { threadLines } from "./format.ts";
import { errorText } from "./notice.tsx";
import { useAddDraft } from "./draft-sync.tsx";
import { draftTextKey, readDraftText, writeDraftText } from "./local-cache.ts";

/** Unsaved text is kept independently from GitHub snapshots, including across app reloads. */
export function useDraftText(key: string, initial = ""): [string, (text: string) => void] {
  const [text, setText] = useState(() => readDraftText(key, initial));
  const update = (next: string) => {
    setText(next);
    // Clearing an old form must preserve a newer buffer in another mount.
    if (next || readDraftText(key, initial) === text) writeDraftText(key, next, initial);
  };
  return [text, update];
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SUBMIT_SHORTCUT = IS_MAC ? "⌘Enter" : "Ctrl+Enter";

/**
 * A comment form: the textarea, its error, and Cancel beside the submit
 * button. Cmd/Ctrl+Enter submits. Escape cancels while there is nothing typed
 * to lose.
 */
export function CommentForm({
  label,
  submitLabel,
  value,
  onChange,
  onSubmit,
  onCancel,
  pending,
  error,
  note,
  blocked = false,
  placeholder = "Leave a comment",
}: {
  /** The textarea's accessible name. */
  label: string;
  submitLabel: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  pending: boolean;
  error: string | null;
  /** A quiet line under the textarea. */
  note?: ReactNode;
  /** Submit stays off. The text can still be edited and copied. */
  blocked?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const ready = value.trim() !== "" && !pending && !blocked;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (ready) onSubmit();
    } else if (event.key === "Escape" && value.trim() === "" && !pending) {
      event.preventDefault();
      onCancel();
    }
  };
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        // Read-only, not disabled, while saving: a disabled field drops focus.
        readOnly={pending}
        // The reader just asked to write, so focus follows the click.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        rows={3}
        className="min-h-16 resize-y bg-background px-2 py-1.5 text-xs"
      />
      {error ? (
        <p role="alert" className="text-destructive-text [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {note ? (
          <p className="mr-auto min-w-0 text-[11px] leading-snug text-muted-foreground">{note}</p>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 font-normal"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-6 gap-1.5 px-2.5 [&_[data-icon-root]]:size-3"
          disabled={!ready}
          aria-busy={pending}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        >
          {pending ? (
            <Icon name="Loading" className="motion-safe:animate-spin" aria-hidden />
          ) : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Said under every form that writes a draft, since that is the plugin's promise. */
export const DRAFT_NOTE = `Saved to your pending review. Nothing is posted until you submit it. ${SUBMIT_SHORTCUT} to save.`;

/**
 * The form a gutter click opens: a new comment on one line or a range, added
 * to the viewer's pending review. Its text is kept per file, so it survives
 * the form moving to another line or remounting.
 *
 * Saving previews the comment immediately. Once GitHub acknowledges it,
 * the confirmed thread replaces the preview and the form closes.
 *
 * After a push or a retarget the picked line numbers may name other code, so
 * the form keeps its text but will not save until the lines are picked again.
 */
export function NewCommentForm({
  pr,
  headRefOid,
  baseRefName,
  linesMoved = false,
  path,
  target,
  onSaved,
  onClose,
}: {
  pr: PullRequest;
  /** The head the diff showed when the lines were picked, which their numbers are counted in. */
  headRefOid: string;
  /** The base the diff compared against when the lines were picked. */
  baseRefName: string;
  /** The diff has a new head or base since the lines were picked. */
  linesMoved?: boolean;
  path: string;
  target: {
    line: number;
    side: ReviewThread["side"];
    startLine: number | null;
    startSide: ReviewThread["side"] | null;
  };
  onSaved: (threadId: string) => void;
  onClose: () => void;
}) {
  // Text typed as one account never opens in the form of another.
  const key = draftTextKey.new(pr, path);
  const [text, setText] = useDraftText(key);
  const add = useAddDraft(pr);
  const where = threadLines({ ...target, originalLine: null });

  return (
    <div className="min-w-0 rounded-md border border-border bg-card px-3 py-2 font-sans text-xs leading-normal text-foreground">
      {add.isSuccess ? (
        // Only when the new thread has not come back with the pull request.
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon name="Check" className="size-3.5 text-success" aria-hidden />
          <output className="mr-auto">Saved to your pending review.</output>
          <Button variant="ghost" size="sm" className="h-6 px-2 font-normal" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <>
          <p className="mb-1.5 font-medium text-muted-foreground">
            Comment on {where.toLowerCase()}
          </p>
          {linesMoved ? (
            <output className="mb-1.5 flex gap-1.5 text-warning-text">
              <Icon name="AlertTriangle" className="mt-px size-3.5 shrink-0" aria-hidden />
              This pull request has changed since you picked these lines. Pick them again in the
              diff to save this comment. Your text is kept.
            </output>
          ) : null}
          <CommentForm
            label={`Comment on ${where.toLowerCase()} of ${path}`}
            submitLabel="Add review comment"
            value={text}
            onChange={setText}
            pending={add.isPending}
            error={add.error ? errorText(add.error) : null}
            note={DRAFT_NOTE}
            blocked={linesMoved}
            onCancel={() => {
              setText("");
              onClose();
            }}
            onSubmit={() =>
              add.mutate(
                {
                  account: pr.account,
                  pullRequestId: pr.id,
                  headRefOid,
                  baseRefName,
                  path,
                  body: text.trim(),
                  line: target.line,
                  startLine: target.startLine,
                  side: target.side,
                  startSide: target.startSide,
                },
                {
                  onSuccess: ({ threadId }) => {
                    onSaved(threadId);
                  },
                },
              )
            }
          />
        </>
      )}
    </div>
  );
}
