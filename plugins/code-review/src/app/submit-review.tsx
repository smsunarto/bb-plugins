import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { UrlLink, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { useMutationState } from "@tanstack/react-query";
import type { MutationKey } from "@tanstack/react-query";
import type { PullRequest, ReviewEvent } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { plural } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { Notice, errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";

const EVENTS: readonly { id: ReviewEvent; label: string; detail: string }[] = [
  { id: "COMMENT", label: "Comment", detail: "General feedback, without approving." },
  { id: "APPROVE", label: "Approve", detail: "These changes are ready to merge." },
  {
    id: "REQUEST_CHANGES",
    label: "Request changes",
    detail: "Feedback that must be addressed before merging.",
  },
];

/** A review changes the pull request and the viewer's place in the inbox. */
function refreshAfterReview(pr: PullRequest): Promise<unknown> {
  return Promise.all([
    pluginQueryClient.invalidateQueries({
      queryKey: rpc.pullRequest.queryKey({ account: pr.account, ref: pr.ref }),
    }),
    pluginQueryClient.invalidateQueries({ queryKey: rpc.inbox.queryKey() }),
  ]);
}

/**
 * One pull request's review requests in the mutation cache. The cache
 * outlives the popover and the button, so every mount sees a request that is
 * out, whichever mount sent it. The key is GitHub's id, not the ref: a URL
 * names the same pull request in any casing. Each account has its own
 * pending review, so its own requests.
 */
function reviewKeys(pr: PullRequest): { submit: MutationKey; discard: MutationKey } {
  const account = pr.account.toLowerCase();
  return {
    submit: ["submitReview", account, pr.id],
    discard: ["discardReview", account, pr.id],
  };
}

/**
 * Whether a request is out right now. A click or a key can land before the
 * render that shows a request as out, so actions ask the cache, not the props.
 */
function isOut(mutationKey: MutationKey): boolean {
  return pluginQueryClient.isMutating({ mutationKey }) > 0;
}

/**
 * The latest request under a key, as the cache holds it. The hook's own
 * result only knows requests sent from this mount, so a page opened again
 * would miss how an earlier one's request ended.
 */
function useLatestRequest(mutationKey: MutationKey): { out: boolean; error: Error | null } {
  const latest = useMutationState({
    filters: { mutationKey },
    select: (mutation) => ({
      mutation,
      status: mutation.state.status,
      error: mutation.state.error,
    }),
  }).at(-1);
  const error = latest?.status === "error" ? latest.error : null;
  const failed = error ? latest?.mutation : undefined;
  // Committed means painted: the reader has seen this refusal.
  useEffect(() => {
    if (failed) seenRefusals.add(failed);
  }, [failed]);
  return { out: latest?.status === "pending", error };
}

/**
 * Refusals the reader has seen. A request can fail in the moment between
 * its answer and the render that would show it, so closing then must not
 * dismiss it: it shows at the next opening instead.
 */
const seenRefusals = new WeakSet<object>();

/** Dismisses settled requests under a key, but not a refusal nobody has seen. One still out stays. */
function forgetSettled(mutationKey: MutationKey): void {
  const cache = pluginQueryClient.getMutationCache();
  for (const mutation of cache.findAll({ mutationKey })) {
    const { status } = mutation.state;
    if (status === "pending") continue;
    if (status === "error" && !seenRefusals.has(mutation)) continue;
    cache.remove(mutation);
  }
}

/**
 * The one way anything reaches GitHub. Draft comments wait in the viewer's
 * pending review until this submits them, together with the summary and the
 * verdict. The button carries the draft count so they are never forgotten.
 */
export function SubmitReviewButton({ pr }: { pr: PullRequest }) {
  const [open, setOpen] = useState(false);
  // Held here, not in the form, so closing the popover by accident keeps the text.
  const [body, setBody] = useState(pr.pendingReview?.body ?? "");
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [submitted, setSubmitted] = useState<{ url: string | null } | null>(null);
  const keys = reviewKeys(pr);
  // Every close goes through here, Done and a finished discard too.
  const changeOpen = (next: boolean) => {
    setOpen(next);
    // Every opening starts at the form, also after Done or after a review
    // that landed once the popover had closed.
    setSubmitted(null);
    // A refusal shows until the popover closes, so one that lands while it
    // is closed shows at the next opening. Requests still out stay.
    if (!next) {
      forgetSettled(keys.submit);
      forgetSettled(keys.discard);
    }
  };
  // Cleanup sits in the hook's options, not in a `mutate` callback, so it
  // runs whether or not the popover is open when GitHub answers.
  const submit = rpc.submitReview.useMutation({
    mutationKey: keys.submit,
    onSuccess: (result) => {
      void refreshAfterReview(pr);
      setBody("");
      setEvent("COMMENT");
      setSubmitted({ url: result.url });
    },
  });
  const discard = rpc.discardReview.useMutation({
    mutationKey: keys.discard,
    onSuccess: () => {
      void refreshAfterReview(pr);
      setBody("");
      changeOpen(false);
    },
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const drafts = pr.pendingReview?.draftCount ?? 0;

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs">
          Submit review
          {drafts > 0 ? (
            <>
              <span
                aria-hidden
                className="min-w-4 rounded-full bg-background/25 px-1 text-[11px] tabular-nums"
              >
                {drafts}
              </span>
              <span className="sr-only">({plural(drafts, "draft comment")})</span>
            </>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-labelledby={titleId}
        mobileTitle="Submit review"
        autoFocusRef={submitted ? undefined : textareaRef}
        className="w-88 p-3 text-xs"
      >
        <h2 id={titleId} className="mb-2 text-sm font-semibold">
          {submitted ? "Review submitted" : "Submit review"}
        </h2>
        {submitted ? (
          <Submitted url={submitted.url} onClose={() => changeOpen(false)} />
        ) : (
          <ReviewForm
            pr={pr}
            body={body}
            event={event}
            submit={submit}
            discard={discard}
            textareaRef={textareaRef}
            onBodyChange={setBody}
            onEventChange={setEvent}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function Submitted({ url, onClose }: { url: string | null; onClose: () => void }) {
  return (
    <output className="flex flex-col gap-3 text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Icon name="CircleCheck" className="size-3.5 text-success" aria-hidden />
        Your review is on GitHub.
      </span>
      <span className="flex items-center justify-end gap-2">
        {url ? (
          <UrlLink
            href={url}
            className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
          >
            View on GitHub
            <Icon name="ExternalLink" className="size-3" aria-hidden />
          </UrlLink>
        ) : null}
        <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={onClose}>
          Done
        </Button>
      </span>
    </output>
  );
}

type SubmitMutation = ReturnType<typeof rpc.submitReview.useMutation>;
type DiscardMutation = ReturnType<typeof rpc.discardReview.useMutation>;

function ReviewForm({
  pr,
  body,
  event,
  submit,
  discard,
  textareaRef,
  onBodyChange,
  onEventChange,
}: {
  pr: PullRequest;
  body: string;
  event: ReviewEvent;
  submit: SubmitMutation;
  discard: DiscardMutation;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onBodyChange: (body: string) => void;
  onEventChange: (event: ReviewEvent) => void;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const keys = reviewKeys(pr);
  const lastSubmit = useLatestRequest(keys.submit);
  const lastDiscard = useLatestRequest(keys.discard);
  const submitting = lastSubmit.out;
  const bodyId = useId();
  const hintId = useId();

  const drafts = pr.pendingReview?.draftCount ?? 0;
  // A verdict picked before it became unavailable falls back to a comment.
  const chosen = pr.viewer.canApprove ? event : "COMMENT";
  // GitHub turns away a comment or a change request that says nothing.
  const empty = chosen !== "APPROVE" && drafts === 0 && body.trim() === "";

  const send = () => {
    // Submitting while the drafts are being deleted would race the deletion.
    if (empty || isOut(keys.submit) || isOut(keys.discard)) return;
    submit.mutate({
      account: pr.account,
      pullRequestId: pr.id,
      headRefOid: pr.headRefOid,
      event: chosen,
      body: body.trim(),
    });
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(formEvent) => {
        formEvent.preventDefault();
        send();
      }}
    >
      <div>
        <label htmlFor={bodyId} className="sr-only">
          Review summary
        </label>
        <Textarea
          ref={textareaRef}
          id={bodyId}
          value={body}
          rows={4}
          placeholder="Leave a comment"
          className="min-h-20 resize-y text-xs"
          aria-describedby={empty ? hintId : undefined}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          onChange={(change) => onBodyChange(change.target.value)}
          onKeyDown={(key) => {
            if (key.key === "Enter" && (key.metaKey || key.ctrlKey)) {
              key.preventDefault();
              send();
            }
          }}
        />
        {drafts > 0 ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {plural(drafts, "draft comment")} will be posted with this review.
          </p>
        ) : null}
      </div>

      <EventChoices pr={pr} chosen={chosen} onChange={onEventChange} />

      {lastSubmit.error ? (
        <Notice tone="error" title="GitHub did not take the review">
          {errorText(lastSubmit.error)}
        </Notice>
      ) : null}

      {/* A form reopened while the discard is out shows it in progress, or refused. */}
      {confirmingDiscard || lastDiscard.out || lastDiscard.error ? (
        <ConfirmDiscard
          pr={pr}
          discard={discard}
          onCancel={() => {
            // The next confirmation starts clean, without this refusal.
            forgetSettled(keys.discard);
            setConfirmingDiscard(false);
          }}
        />
      ) : (
        <div className="flex items-center gap-2">
          {pr.pendingReview ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs font-normal text-destructive-text"
              disabled={submitting}
              onClick={() => setConfirmingDiscard(true)}
            >
              Discard drafts
            </Button>
          ) : null}
          {empty ? (
            <p id={hintId} className="min-w-0 flex-1 text-end text-[11px] text-subtle-foreground">
              Write a comment to submit.
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <Button
            type="submit"
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={empty || submitting}
          >
            {submitting ? "Submitting…" : "Submit review"}
          </Button>
        </div>
      )}
    </form>
  );
}

/** Comment, Approve, or Request changes. Only the first is open to the author or on a closed pull request. */
function EventChoices({
  pr,
  chosen,
  onChange,
}: {
  pr: PullRequest;
  chosen: ReviewEvent;
  onChange: (event: ReviewEvent) => void;
}) {
  const name = useId();
  const reasonId = useId();
  const { canApprove, isAuthor } = pr.viewer;
  const reason = isAuthor
    ? "You opened this pull request, so you can only comment on it."
    : "This pull request is not open, so you can only comment on it.";
  return (
    <fieldset
      className="m-0 flex flex-col gap-0.5 border-0 p-0"
      aria-describedby={canApprove ? undefined : reasonId}
    >
      <legend className="sr-only">Review type</legend>
      {EVENTS.map((option) => {
        const disabled = option.id !== "COMMENT" && !canApprove;
        return (
          <label
            key={option.id}
            title={disabled ? reason : undefined}
            className={cn(
              "grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-md px-2 py-1.5",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-state-hover",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={chosen === option.id}
              disabled={disabled}
              onChange={() => onChange(option.id)}
              className="row-span-2 mt-0.5 accent-primary"
            />
            <span className="font-medium text-foreground">{option.label}</span>
            <span className="text-muted-foreground">{option.detail}</span>
          </label>
        );
      })}
      {canApprove ? null : (
        <p id={reasonId} className="px-2 pt-0.5 text-[11px] text-subtle-foreground">
          {reason}
        </p>
      )}
    </fieldset>
  );
}

/** Deleting the pending review takes every draft with it, so it asks first. */
function ConfirmDiscard({
  pr,
  discard,
  onCancel,
}: {
  pr: PullRequest;
  discard: DiscardMutation;
  onCancel: () => void;
}) {
  const keys = reviewKeys(pr);
  const { out: discarding, error } = useLatestRequest(keys.discard);
  const drafts = pr.pendingReview?.draftCount ?? 0;
  const what = drafts > 0 ? plural(drafts, "draft comment") : "the pending review";
  return (
    <fieldset className="m-0 flex flex-col gap-2 rounded-md border border-surface-destructive-border bg-surface-destructive px-2.5 py-2">
      <legend className="sr-only">Confirm discard</legend>
      <p className="text-foreground">
        Discard {what}? This deletes {drafts === 1 ? "it" : "them"} from GitHub and cannot be
        undone.
      </p>
      {error ? (
        <p role="alert" className="text-destructive-text">
          {errorText(error)}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={discarding}
          onClick={() => {
            // Keep waits for a discard that is out, even one this render does not show yet.
            if (!isOut(keys.discard)) onCancel();
          }}
        >
          Keep
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={discarding}
          onClick={() => {
            // Deleting the drafts while they are being submitted would race the review.
            if (isOut(keys.discard) || isOut(keys.submit)) return;
            discard.mutate({ account: pr.account, pullRequestId: pr.id });
          }}
        >
          {discarding ? "Discarding…" : "Discard"}
        </Button>
      </div>
    </fieldset>
  );
}
