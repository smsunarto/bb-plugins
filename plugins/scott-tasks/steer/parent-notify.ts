import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ParentNotification, TasksStore } from "../db";
import { errorMessage, sdkErrorCode } from "../shared/errors";
import { sleepUnlessAborted } from "../shared/sleep";

/** Attempts before a notifying comment is marked undeliverable. */
export const PARENT_NOTIFY_MAX_ATTEMPTS = 6;
/** Wait after the nth failed attempt; the last delay repeats for later attempts. */
export const PARENT_NOTIFY_BACKOFF_MS = [1, 2, 5, 15].map((minutes) => minutes * 60_000);
/** How often the redelivery timer looks for due comments while none is scheduled sooner. */
export const PARENT_NOTIFY_IDLE_MS = 60_000;
/** One attempt's reads and send; shorter than the first retry, so no second claim overlaps it. */
const ATTEMPT_DEADLINE_MS = 30_000;
const DUE_BATCH = 50;
const FIRST_LINE_MAX_LENGTH = 200;

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

function retryDelayMs(attempt: number): number {
  const index = Math.min(attempt, PARENT_NOTIFY_BACKOFF_MS.length) - 1;
  return PARENT_NOTIFY_BACKOFF_MS[index] ?? PARENT_NOTIFY_IDLE_MS;
}

export interface WakeLineInput {
  taskKey: string;
  body: string;
  threadId: string;
  presetName: string | null;
  attachments: readonly { id: string; fileName: string }[];
}

/** `[tasks] KEY first line · thr_x Preset · att_1 a.md, att_2 b.png`; no attachment segment without files. */
export function wakeLine(input: WakeLineInput): string {
  const firstLine = input.body.split("\n").find((line) => line.trim() !== "") ?? "";
  const summary = firstLine.trim().slice(0, FIRST_LINE_MAX_LENGTH);
  const segments = [
    `[tasks] ${input.taskKey} ${summary}`,
    input.presetName === null ? input.threadId : `${input.threadId} ${input.presetName}`,
  ];
  if (input.attachments.length > 0) {
    segments.push(
      input.attachments.map((attachment) => `${attachment.id} ${attachment.fileName}`).join(", "),
    );
  }
  return segments.join(" · ");
}

/**
 * Run one attempt against a deadline. Racing does not stop the attempt, so the
 * deadline also aborts its signal: an expired attempt whose read resumes later
 * must not send after a retry has already delivered.
 */
async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  label: string,
): Promise<T> {
  const expired = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired.abort();
      reject(new Error(`${label} timed out after ${ATTEMPT_DEADLINE_MS / 1000}s`));
    }, ATTEMPT_DEADLINE_MS);
  });
  try {
    return await Promise.race([run(expired.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

type AttemptOutcome =
  | { kind: "delivered"; targetThreadId: string }
  | { kind: "undeliverable"; reason: string }
  | { kind: "failed"; error: string };

/** The attempt is still the latest claim on a pending record and has not expired. */
function ownsAttempt(
  store: TasksStore,
  commentId: string,
  attempt: number,
  signal: AbortSignal,
): boolean {
  if (signal.aborted) return false;
  const current = store.getParentNotification(commentId);
  return current?.state === "pending" && current.attempts === attempt;
}

/**
 * The commenting thread when bb would accept it as the wake's sender, so the
 * parent reads the wake as that agent's message. Null when the reporter is the
 * parent itself, or is deleted or gone: the wake still goes, without a sender.
 */
async function wakeSender(
  bb: BbPluginApi,
  commenter: string,
  target: string,
  known: Thread | undefined,
): Promise<string | null> {
  if (commenter === target) return null;
  try {
    const thread = known ?? (await bb.sdk.threads.get({ threadId: commenter }));
    return thread.deletedAt === null ? commenter : null;
  } catch (error) {
    if (sdkErrorCode(error) === "thread_not_found") return null;
    throw error;
  }
}

/**
 * Send the wake line as `sender`. bb rejects a sender deleted since the read
 * before it sends anything, so resending without one cannot deliver twice.
 * False when the attempt lost its claim before that resend, which then waits
 * for the retry that owns it.
 */
async function sendWake(
  bb: BbPluginApi,
  target: string,
  text: string,
  sender: string | null,
  stillOwned: () => boolean,
): Promise<boolean> {
  const args = {
    threadId: target,
    input: [{ type: "text" as const, text, mentions: [] }],
    mode: "steer-if-active" as const,
  };
  if (sender === null) {
    await bb.sdk.threads.send(args);
    return true;
  }
  try {
    await bb.sdk.threads.send({ ...args, senderThreadId: sender });
  } catch (error) {
    if (sdkErrorCode(error) !== "parent_thread_invalid") throw error;
    if (!stillOwned()) return false;
    await bb.sdk.threads.send(args);
  }
  return true;
}

const SUPERSEDED: AttemptOutcome = { kind: "failed", error: "attempt expired before sending" };

async function attemptDelivery(
  bb: BbPluginApi,
  store: TasksStore,
  commentId: string,
  knownTargetThreadId: string | null,
  attempt: number,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  const comment = store.getComment(commentId);
  const task = comment ? store.getTask(comment.taskId) : undefined;
  if (!comment || !task || comment.source.kind !== "agent") {
    return { kind: "undeliverable", reason: "the comment has no commenting thread" };
  }
  const commenter = comment.source.threadId;
  let target = knownTargetThreadId;
  let commenterThread: Thread | undefined;
  try {
    if (target === null) {
      commenterThread = await bb.sdk.threads.get({ threadId: commenter });
      if (commenterThread.parentThreadId === null) {
        return { kind: "undeliverable", reason: `thread ${commenter} has no parent thread` };
      }
      target = commenterThread.parentThreadId;
      if (!ownsAttempt(store, commentId, attempt, signal)) return SUPERSEDED;
      store.setParentNotificationTarget(commentId, target);
    }
    const parent = await bb.sdk.threads.get({ threadId: target });
    if (parent.deletedAt !== null) {
      return { kind: "undeliverable", reason: `parent thread ${target} is deleted` };
    }
    if (parent.archivedAt !== null) {
      return { kind: "undeliverable", reason: `parent thread ${target} is archived` };
    }
    const text = wakeLine({
      taskKey: task.key,
      body: comment.body,
      threadId: commenter,
      presetName: store.getTaskThreadByThreadId(task.id, commenter)?.presetName ?? null,
      attachments: store.listAttachmentsForComment(comment.id),
    });
    const sender = await wakeSender(bb, commenter, target, commenterThread);
    // A read can outlive the deadline; a retry may have claimed or delivered since.
    if (!ownsAttempt(store, commentId, attempt, signal)) return SUPERSEDED;
    const sent = await sendWake(bb, target, text, sender, () =>
      ownsAttempt(store, commentId, attempt, signal),
    );
    return sent ? { kind: "delivered", targetThreadId: target } : SUPERSEDED;
  } catch (error) {
    if (sdkErrorCode(error) === "thread_not_found") {
      return { kind: "undeliverable", reason: `thread ${target ?? commenter} was not found` };
    }
    return { kind: "failed", error: errorMessage(error) };
  }
}

/**
 * Make the next delivery attempt for a notifying comment, if one is owed.
 * Safe to call from several places at once: only the caller whose claim wins
 * sends, and a record past its attempt cap converges to undeliverable.
 */
export async function deliverParentNotification(
  bb: BbPluginApi,
  store: TasksStore,
  commentId: string,
): Promise<ParentNotification | undefined> {
  const current = store.getParentNotification(commentId);
  if (current?.state !== "pending") return current;
  // Not due: an attempt is in flight or backing off.
  if (Date.parse(current.nextAttemptAt) > Date.now()) return current;
  if (current.attempts >= PARENT_NOTIFY_MAX_ATTEMPTS) {
    return store.markParentNotificationUndeliverable(
      commentId,
      `gave up after ${current.attempts} attempts${current.lastError ? `: ${current.lastError}` : ""}`,
    );
  }
  const attempt = current.attempts + 1;
  const retryAt = new Date(Date.now() + retryDelayMs(attempt)).toISOString();
  if (!store.claimParentNotificationAttempt(commentId, current.attempts, retryAt)) {
    return store.getParentNotification(commentId);
  }

  const outcome = await withDeadline(
    (signal) => attemptDelivery(bb, store, commentId, current.targetThreadId, attempt, signal),
    `wake attempt ${attempt}`,
  ).catch((error: unknown): AttemptOutcome => ({ kind: "failed", error: errorMessage(error) }));
  switch (outcome.kind) {
    case "delivered":
      return store.recordParentNotificationDelivered(commentId, outcome.targetThreadId);
    case "undeliverable":
      return store.markParentNotificationUndeliverable(commentId, outcome.reason);
    case "failed":
      bb.log.warn(`wake for comment ${commentId} failed (attempt ${attempt}): ${outcome.error}`);
      return attempt >= PARENT_NOTIFY_MAX_ATTEMPTS
        ? store.markParentNotificationUndeliverable(
            commentId,
            `gave up after ${attempt} attempts: ${outcome.error}`,
          )
        : store.recordParentNotificationFailure(commentId, outcome.error);
  }
}

/** One pass over the notifying comments whose next attempt is due. */
export async function redeliverDueParentNotifications(
  bb: BbPluginApi,
  store: TasksStore,
  signal?: AbortSignal,
): Promise<void> {
  for (const commentId of store.listDueParentNotifications(DUE_BATCH)) {
    if (signal?.aborted) return;
    try {
      await deliverParentNotification(bb, store, commentId);
    } catch (error) {
      bb.log.warn(`could not redeliver comment ${commentId}: ${errorMessage(error)}`);
    }
  }
}

function nextPassDelayMs(store: TasksStore): number {
  const due = store.nextParentNotificationDueAt();
  if (due === null) return PARENT_NOTIFY_IDLE_MS;
  return Math.min(Math.max(Date.parse(due) - Date.now(), 1_000), PARENT_NOTIFY_IDLE_MS);
}

/**
 * Retries undelivered wake lines. All state is in the database, so a restart
 * resumes with the first pass: whatever came due while the plugin was down.
 */
export function registerParentNotifyRedelivery(bb: BbPluginApi, store: TasksStore): void {
  bb.background.service("parent-notify-redelivery", {
    async start(signal) {
      while (!signal.aborted) {
        await redeliverDueParentNotifications(bb, store, signal);
        await sleepUnlessAborted(signal, nextPassDelayMs(store));
      }
    },
  });
}
