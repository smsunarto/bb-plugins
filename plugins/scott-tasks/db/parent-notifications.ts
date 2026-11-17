import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ParentNotification } from "./types";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

interface ParentNotificationRow {
  comment_id: string;
  state: ParentNotification["state"];
  target_thread_id: string | null;
  attempts: number;
  next_attempt_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
}

/** The row shapes the table's CHECK constraints admit, read back as the typed state. */
function notificationFromRow(row: ParentNotificationRow): ParentNotification {
  switch (row.state) {
    case "pending":
      return {
        state: "pending",
        targetThreadId: row.target_thread_id,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at ?? "",
        lastError: row.last_error,
      };
    case "delivered":
      return {
        state: "delivered",
        targetThreadId: row.target_thread_id ?? "",
        attempts: row.attempts,
        deliveredAt: row.delivered_at ?? "",
      };
    case "undeliverable":
      return {
        state: "undeliverable",
        targetThreadId: row.target_thread_id,
        attempts: row.attempts,
        reason: row.last_error ?? "",
      };
  }
}

/**
 * Delivery state of notifying comments, kept in the database so a restart
 * resumes where the last run stopped. An attempt is claimed before it is sent:
 * the claim bumps `attempts` only from the count the caller read and moves
 * `next_attempt_at` to the retry time, so two senders never send one attempt,
 * and a crash mid-send leaves a row the next due pass retries.
 */
export function createParentNotificationStore(db: PluginDatabase, now: () => string) {
  function getParentNotification(commentId: string): ParentNotification | undefined {
    const row = db
      .prepare<[string], ParentNotificationRow>(
        "SELECT * FROM comment_parent_notifications WHERE comment_id = ?",
      )
      .get(commentId);
    return row ? notificationFromRow(row) : undefined;
  }

  function requireParentNotification(commentId: string): ParentNotification {
    const notification = getParentNotification(commentId);
    if (!notification) throw new Error(`comment ${commentId} does not notify its parent`);
    return notification;
  }

  /** Mark a comment as notifying, due at once. Repeating it keeps the existing record. */
  function startParentNotification(
    commentId: string,
    targetThreadId: string | null,
  ): ParentNotification {
    const timestamp = now();
    db.prepare<[string, string | null, string, string, string]>(
      `
      INSERT INTO comment_parent_notifications (
        comment_id, state, target_thread_id, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, 'pending', ?, 0, ?, ?, ?)
      ON CONFLICT (comment_id) DO NOTHING
    `,
    ).run(commentId, targetThreadId, timestamp, timestamp, timestamp);
    return requireParentNotification(commentId);
  }

  /**
   * Claim attempt `fromAttempts + 1` of a due record. Returns false when another
   * sender already claimed it, its retry time is still ahead (an attempt is in
   * flight or backing off), or the record left `pending`.
   */
  function claimParentNotificationAttempt(
    commentId: string,
    fromAttempts: number,
    retryAt: string,
  ): boolean {
    const timestamp = now();
    return (
      db
        .prepare<[string, string, string, number, string]>(
          `
          UPDATE comment_parent_notifications
          SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
          WHERE comment_id = ? AND state = 'pending' AND attempts = ? AND next_attempt_at <= ?
        `,
        )
        .run(retryAt, timestamp, commentId, fromAttempts, timestamp).changes === 1
    );
  }

  function setParentNotificationTarget(commentId: string, targetThreadId: string): void {
    db.prepare<[string, string, string]>(
      `
      UPDATE comment_parent_notifications SET target_thread_id = ?, updated_at = ?
      WHERE comment_id = ? AND state = 'pending'
    `,
    ).run(targetThreadId, now(), commentId);
  }

  function recordParentNotificationDelivered(
    commentId: string,
    targetThreadId: string,
  ): ParentNotification {
    const timestamp = now();
    db.prepare<[string, string, string, string]>(
      `
      UPDATE comment_parent_notifications
      SET state = 'delivered', target_thread_id = ?, next_attempt_at = NULL,
        delivered_at = ?, last_error = NULL, updated_at = ?
      WHERE comment_id = ? AND state = 'pending'
    `,
    ).run(targetThreadId, timestamp, timestamp, commentId);
    return requireParentNotification(commentId);
  }

  /** A failed attempt stays pending until its claimed retry time. */
  function recordParentNotificationFailure(commentId: string, error: string): ParentNotification {
    db.prepare<[string, string, string]>(
      `
      UPDATE comment_parent_notifications SET last_error = ?, updated_at = ?
      WHERE comment_id = ? AND state = 'pending'
    `,
    ).run(error, now(), commentId);
    return requireParentNotification(commentId);
  }

  function markParentNotificationUndeliverable(
    commentId: string,
    reason: string,
  ): ParentNotification {
    db.prepare<[string, string, string]>(
      `
      UPDATE comment_parent_notifications
      SET state = 'undeliverable', next_attempt_at = NULL, last_error = ?, updated_at = ?
      WHERE comment_id = ? AND state = 'pending'
    `,
    ).run(reason, now(), commentId);
    return requireParentNotification(commentId);
  }

  /** Pending notifications whose next attempt is due, oldest first. */
  function listDueParentNotifications(limit: number): string[] {
    return db
      .prepare<[string, number], { comment_id: string }>(
        `
        SELECT comment_id FROM comment_parent_notifications
        WHERE state = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at, comment_id
        LIMIT ?
      `,
      )
      .all(now(), limit)
      .map((row) => row.comment_id);
  }

  function nextParentNotificationDueAt(): string | null {
    return (
      db
        .prepare<[], { due: string | null }>(
          "SELECT MIN(next_attempt_at) AS due FROM comment_parent_notifications WHERE state = 'pending'",
        )
        .get()?.due ?? null
    );
  }

  return {
    getParentNotification,
    startParentNotification,
    claimParentNotificationAttempt,
    setParentNotificationTarget,
    recordParentNotificationDelivered,
    recordParentNotificationFailure,
    markParentNotificationUndeliverable,
    listDueParentNotifications,
    nextParentNotificationDueAt,
  };
}
