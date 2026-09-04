import type { CommentOp, CommentsFile, CommentThread } from "./comments.ts";

// Pure op semantics shared by the server store and the app's optimistic
// overlay. Zod-free so the app imports it as a value.

export class UnknownThreadError extends Error {
  override readonly name = "UnknownThreadError";
  constructor(threadId: string) {
    super(`unknown comment thread ${threadId}`);
  }
}

function replaceThread(
  file: CommentsFile,
  threadId: string,
  update: (thread: CommentThread) => CommentThread,
): CommentsFile {
  const index = file.threads.findIndex((thread) => thread.id === threadId);
  const existing = file.threads[index];
  if (existing === undefined) throw new UnknownThreadError(threadId);
  const next = update(existing);
  if (next === existing) return file;
  return { ...file, threads: file.threads.with(index, next) };
}

/** Idempotent. Applying the same op twice returns the same file. */
export function applyOp(file: CommentsFile, op: CommentOp, nowMs: number): CommentsFile {
  switch (op.op) {
    case "open":
      return file.threads.some((thread) => thread.id === op.thread.id)
        ? file
        : { ...file, threads: [...file.threads, op.thread] };
    case "reply":
      return replaceThread(file, op.threadId, (thread) =>
        thread.messages.some((message) => message.id === op.message.id)
          ? thread
          : { ...thread, messages: [...thread.messages, op.message] },
      );
    case "resolve":
      return replaceThread(file, op.threadId, (thread) => {
        if (op.resolved === (thread.resolvedAtMs !== null)) return thread;
        return { ...thread, resolvedAtMs: op.resolved ? nowMs : null };
      });
  }
}

/** True once the file already carries what the op asked for. */
export function reflects(file: CommentsFile, op: CommentOp): boolean {
  const thread = file.threads.find(
    (candidate) => candidate.id === (op.op === "open" ? op.thread.id : op.threadId),
  );
  if (thread === undefined) return false;
  switch (op.op) {
    case "open":
      return true;
    case "reply":
      return thread.messages.some((message) => message.id === op.message.id);
    case "resolve":
      return op.resolved === (thread.resolvedAtMs !== null);
  }
}
