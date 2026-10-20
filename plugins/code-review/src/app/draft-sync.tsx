import { useSyncExternalStore } from "react";
import { notifyManager, useMutation, useIsMutating } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import type { PullRequest, ReviewThread, ThreadComment } from "../shared/schema.ts";
import { sameRevision } from "../shared/schema.ts";
import { rpc } from "./rpc.ts";
import { Notice, errorText } from "./notice.tsx";
import { confirmDraftText, draftTextKey } from "./local-cache.ts";

type Change = (pr: PullRequest) => PullRequest;
type Operation = { pr: PullRequest; change: Change };
const identity = (pr: PullRequest) => `${pr.account.toLowerCase()}:${pr.id}`;
export const draftKey = (pr: PullRequest) => ["draft", pr.account.toLowerCase(), pr.id];
export const reviewScope = (pr: PullRequest) => ({ id: `review:${identity(pr)}` });

/**
 * Confirmed query data and pending operations have separate owners. Refetches
 * replace only the former. Removing one failed operation cannot roll back a
 * different comment or a concurrent GitHub edit. Previews are never persisted.
 */
class DraftJournal {
  private operations = new Map<string, Operation>();
  private errors = new Map<string, string>();
  private listeners = new Set<() => void>();
  private version = 0;
  private client: QueryClient;
  constructor(client: QueryClient) {
    this.client = client;
    client.getQueryCache().subscribe((event) => {
      if (event.type !== "removed" || event.query.queryKey[0] !== "pullRequest") return;
      const pr = event.query.state.data as PullRequest | undefined;
      if (!pr) return;
      const key = identity(pr);
      this.errors.delete(key);
      for (const [id, operation] of this.operations) {
        if (identity(operation.pr) === key) this.operations.delete(id);
      }
      this.changed();
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
  begin(pr: PullRequest, change: Change): string {
    const id = crypto.randomUUID();
    this.operations.set(id, { pr, change });
    this.errors.delete(identity(pr));
    this.changed();
    return id;
  }
  finish(id: string, commit?: Change, error?: unknown): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    notifyManager.batch(() => {
      this.operations.delete(id);
      if (commit)
        this.client.setQueryData<PullRequest>(
          rpc.pullRequest.queryKey({ account: operation.pr.account, ref: operation.pr.ref }),
          (current) => (current ? commit(current) : undefined),
        );
      if (error) this.errors.set(identity(operation.pr), errorText(error));
      this.changed();
    });
  }
  preview(pr: PullRequest): PullRequest {
    let result = pr;
    for (const operation of this.operations.values()) {
      if (identity(operation.pr) === identity(pr)) result = operation.change(result);
    }
    return result;
  }
  error(pr: PullRequest): string | undefined {
    return this.errors.get(identity(pr));
  }
}
const journal = new DraftJournal(pluginQueryClient);

export function useDraftPreview(pr: PullRequest | undefined): PullRequest | undefined {
  useSyncExternalStore(journal.subscribe, journal.snapshot, journal.snapshot);
  return pr ? journal.preview(pr) : undefined;
}

export function DraftSyncNotice({ pr }: { pr: PullRequest }) {
  useSyncExternalStore(journal.subscribe, journal.snapshot, journal.snapshot);
  const count = useIsMutating({ mutationKey: draftKey(pr) });
  const error = journal.error(pr);
  if (error)
    return (
      <Notice tone="error" title="GitHub did not save your draft" className="mx-3 mt-2">
        {error} Your text is kept. Check GitHub before retrying if the connection was interrupted.
      </Notice>
    );
  if (count === 0) return null;
  return (
    <output className="px-3 pt-2 text-[11px] text-muted-foreground">Saving draft to GitHub…</output>
  );
}

/** No automatic mutation retries: a lost answer can follow a successful GitHub write. */
function useDraftMutation<In, Out>(
  pr: PullRequest,
  kind: "add" | "reply" | "edit" | "delete",
  write: (input: In) => Promise<Out>,
  change: (input: In, id: string) => Change,
  commit: (input: In, output: Out) => Change,
  savedText?: (input: In) => { key: string; body: string },
) {
  return useMutation<Out, Error, In, string>({
    mutationKey: [...draftKey(pr), kind],
    scope: kind === "add" || kind === "reply" ? undefined : reviewScope(pr),
    retry: false,
    networkMode: "always",
    mutationFn: write,
    onMutate: (input) => {
      const account = pr.account.toLowerCase();
      if (
        pluginQueryClient.isMutating({ mutationKey: ["submitReview", account, pr.id] }) ||
        pluginQueryClient.isMutating({ mutationKey: ["discardReview", account, pr.id] })
      ) {
        throw new Error("Wait for the review to finish before changing its drafts.");
      }
      const id = crypto.randomUUID();
      return journal.begin(pr, change(input, `local:${id}`));
    },
    onSuccess: async (output, input, id) => {
      // Cancel any older read before committing the acknowledged result.
      await pluginQueryClient.cancelQueries({
        queryKey: rpc.pullRequest.queryKey({ account: pr.account, ref: pr.ref }),
      });
      journal.finish(id, commit(input, output));
      const text = savedText?.(input);
      if (text) confirmDraftText(text.key, text.body);
      void pluginQueryClient.invalidateQueries({
        queryKey: rpc.pullRequest.queryKey({ account: pr.account, ref: pr.ref }),
      });
      void pluginQueryClient.invalidateQueries({ queryKey: rpc.inbox.queryKey() });
    },
    onError: (error, _input, id) => {
      if (id) journal.finish(id, undefined, error);
    },
  });
}

function comment(pr: PullRequest, id: string, body: string): ThreadComment {
  return {
    id,
    body,
    author: { login: pr.account, avatarUrl: null },
    createdAt: new Date().toISOString(),
    url: pr.url,
    isDraft: true,
  };
}
function pending(pr: PullRequest, delta: number): PullRequest["pendingReview"] {
  return {
    id: pr.pendingReview?.id ?? "local:pending",
    body: pr.pendingReview?.body ?? "",
    draftCount: Math.max(0, (pr.pendingReview?.draftCount ?? 0) + delta),
  };
}

/** A saved add or reply: GitHub's pending review replaces the preview's placeholder. */
function acknowledged(
  current: PullRequest,
  next: PullRequest,
  output: { pendingReview: { id: string; draftCount: number } },
): PullRequest {
  const drafts = next.threads.reduce(
    (count, thread) => count + thread.comments.filter((item) => item.isDraft).length,
    0,
  );
  return {
    ...next,
    pendingReview: {
      id: output.pendingReview.id,
      draftCount: Math.max(output.pendingReview.draftCount, drafts),
      body: current.pendingReview?.id === output.pendingReview.id ? current.pendingReview.body : "",
    },
  };
}

type Client = ReturnType<typeof rpc.useClient>;
type Input<M extends keyof Client> = Parameters<Client[M]>[0];

export function useAddDraft(pr: PullRequest) {
  const client = rpc.useClient();
  const add =
    (input: Input<"addDraftComment">, threadId: string, commentId: string): Change =>
    (current) => {
      if (current.threads.some((thread) => thread.id === threadId)) return current;
      const moved = !sameRevision(current, input);
      const thread: ReviewThread = {
        id: threadId,
        path: input.path,
        line: moved ? null : input.line,
        startLine: moved ? null : input.startLine,
        startSide: input.startSide,
        side: input.side,
        originalLine: input.line,
        isResolved: false,
        isOutdated: moved,
        isFileLevel: false,
        diffHunk: "",
        comments: [comment(pr, commentId, input.body)],
      };
      return {
        ...current,
        threads: [...current.threads, thread],
        pendingReview: pending(current, 1),
      };
    };
  return useDraftMutation(
    pr,
    "add",
    client.addDraftComment,
    (input, id) => add(input, id, id),
    (input, output) => (current) =>
      acknowledged(current, add(input, output.threadId, output.commentId)(current), output),
    (input) => ({
      key: draftTextKey.new(pr, input.path),
      body: input.body,
    }),
  );
}

export function useReplyDraft(pr: PullRequest) {
  const client = rpc.useClient();
  const reply =
    (input: Input<"replyDraft">, id: string): Change =>
    (current) => {
      if (current.threads.some((thread) => thread.comments.some((item) => item.id === id)))
        return current;
      if (!current.threads.some((thread) => thread.id === input.threadId)) return current;
      return {
        ...current,
        pendingReview: pending(current, 1),
        threads: current.threads.map((thread) =>
          thread.id === input.threadId
            ? { ...thread, comments: [...thread.comments, comment(pr, id, input.body)] }
            : thread,
        ),
      };
    };
  return useDraftMutation(
    pr,
    "reply",
    client.replyDraft,
    reply,
    (input, output) => (current) =>
      acknowledged(current, reply(input, output.commentId)(current), output),
    (input) => ({ key: draftTextKey.reply(pr, input.threadId), body: input.body }),
  );
}

export function useEditDraft(pr: PullRequest) {
  const client = rpc.useClient();
  const edit =
    (input: Input<"editDraft">): Change =>
    (current) => ({
      ...current,
      threads: current.threads.map((thread) => ({
        ...thread,
        comments: thread.comments.map((item) =>
          item.id === input.commentId && item.isDraft ? { ...item, body: input.body } : item,
        ),
      })),
    });
  return useDraftMutation(
    pr,
    "edit",
    client.editDraft,
    edit,
    (input) => edit(input),
    (input) => ({ key: draftTextKey.edit(pr, input.commentId), body: input.body }),
  );
}

export function useDeleteDraft(pr: PullRequest) {
  const client = rpc.useClient();
  const remove =
    (input: Input<"deleteDraft">): Change =>
    (current) => {
      const found = current.threads.some((thread) =>
        thread.comments.some((item) => item.id === input.commentId && item.isDraft),
      );
      if (!found) return current;
      return {
        ...current,
        pendingReview: pending(current, -1),
        threads: current.threads
          .map((thread) => ({
            ...thread,
            comments: thread.comments.filter(
              (item) => item.id !== input.commentId || !item.isDraft,
            ),
          }))
          .filter((thread) => thread.comments.length > 0),
      };
    };
  return useDraftMutation(pr, "delete", client.deleteDraft, remove, (input) => remove(input));
}

/** Apply an acknowledged submit/discard without keeping old drafts until a network read. */
export async function confirmReviewClosed(pr: PullRequest): Promise<void> {
  const queryKey = rpc.pullRequest.queryKey({ account: pr.account, ref: pr.ref });
  await pluginQueryClient.cancelQueries({ queryKey });
  pluginQueryClient.setQueryData<PullRequest>(queryKey, (current) =>
    current
      ? {
          ...current,
          pendingReview: null,
          threads: current.threads
            .map((thread) => ({
              ...thread,
              comments: thread.comments.filter((item) => !item.isDraft),
            }))
            .filter((thread) => thread.comments.length > 0),
        }
      : undefined,
  );
}
