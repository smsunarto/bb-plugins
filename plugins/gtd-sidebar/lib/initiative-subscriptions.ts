// Initiative subscriptions: the runtime that wakes a coordinator without a
// user prompt. A subscription is a durable row in the plugin's SQLite
// database; a single background service sweeps due rows, polls their source,
// and sends ONE digest message to the initiative's coordinator thread.
//
// Delivery is at-least-once by construction. Sources that paginate (Slack)
// keep a durable scan state — page cursor + a backlog of fetched-but-unsent
// events — in the row's `cursor` column, so a poll can stop at its call
// budget mid-window and resume exactly where it left off, and events are
// never dropped because a digest was truncated or a sweep was interrupted.
// Delivered-event rows and scan progress commit only after `threads.send`
// resolves; a crash between send and commit re-sends a bounded digest on the
// next sweep, it never silently loses events.
//
// The module is storage- and transport-injected: tests drive it with an
// in-memory database and fake threads/host/fetch. server.ts wires the real
// `bb` api in via `registerInitiativeSubscriptions`.
import { CronExpressionParser } from "cron-parser";
import type { Database } from "better-sqlite3";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config schemas. server.ts reuses these inside the shared RPC contract and
// the agent tools, so every boundary validates (kind, config) pairs the same
// discriminated way. `label` and `prompt` live on the record — they are common
// to every kind — not inside config.
// ---------------------------------------------------------------------------

export const subscriptionScheduleConfigSchema = z.discriminatedUnion("schedule", [
  z.object({
    schedule: z.literal("cron"),
    /** Standard 5-field cron expression, server-local time. */
    expression: z.string().trim().min(1),
    /** The instruction the coordinator receives when the schedule fires. */
    prompt: z.string().trim().min(1),
  }),
  z.object({
    schedule: z.literal("once"),
    /** Epoch ms. A past timestamp fires on the next sweep. */
    runAt: z.number().int().positive(),
    prompt: z.string().trim().min(1),
  }),
]);

const catchUpField = z
  .boolean()
  .optional()
  .describe("Deliver pre-existing items on the first poll instead of starting from now");

export const githubCiConfigSchema = z.object({
  /** `owner/repo`, matching `gh -R`. */
  repo: z
    .string()
    .trim()
    .regex(/^[^\s/]+\/[^\s/]+$/, "expected owner/repo"),
  /** Restrict to runs on one branch; omit for the repo's recent runs. */
  branch: z.string().trim().min(1).optional(),
  /** Bound BB environment whose checkout + host auth run the gh query. */
  environmentId: z.string().trim().min(1),
  catchUp: catchUpField,
});

export const githubPrConfigSchema = z.object({
  repo: z
    .string()
    .trim()
    .regex(/^[^\s/]+\/[^\s/]+$/, "expected owner/repo"),
  pr: z.number().int().positive(),
  environmentId: z.string().trim().min(1),
  catchUp: catchUpField,
});

export const slackChannelConfigSchema = z.object({
  /** Slack channel id (C…/G…). The bot must be a member. */
  channelId: z.string().trim().min(1),
  catchUp: catchUpField,
});

export const subscriptionConfigSchemas = {
  schedule: subscriptionScheduleConfigSchema,
  "github-ci": githubCiConfigSchema,
  "github-pr": githubPrConfigSchema,
  "slack-channel": slackChannelConfigSchema,
} as const;

export type InitiativeSubscriptionKind = keyof typeof subscriptionConfigSchemas;
export const INITIATIVE_SUBSCRIPTION_KINDS = Object.keys(
  subscriptionConfigSchemas,
) as InitiativeSubscriptionKind[];

export type SubscriptionScheduleConfig = z.infer<typeof subscriptionScheduleConfigSchema>;
export type GitHubCiConfig = z.infer<typeof githubCiConfigSchema>;
export type GitHubPrConfig = z.infer<typeof githubPrConfigSchema>;
export type SlackChannelConfig = z.infer<typeof slackChannelConfigSchema>;

export type InitiativeSubscriptionConfig =
  | SubscriptionScheduleConfig
  | GitHubCiConfig
  | GitHubPrConfig
  | SlackChannelConfig;

/** Validate a (kind, config) pair; throws a readable error on mismatch. */
export function parseSubscriptionConfig(
  kind: InitiativeSubscriptionKind,
  config: unknown,
): InitiativeSubscriptionConfig {
  const schema = subscriptionConfigSchemas[kind];
  if (!schema) throw new Error(`Unknown subscription kind "${kind}"`);
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${kind} config: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  if (kind === "schedule" && (parsed.data as SubscriptionScheduleConfig).schedule === "cron") {
    // Validate the expression up front so a bad schedule fails at creation,
    // not on the first sweep — with the same error shape as schema failures.
    try {
      CronExpressionParser.parse((parsed.data as { expression: string }).expression);
    } catch (error) {
      throw new Error(`Invalid schedule config: ${describeError(error)}`, { cause: error });
    }
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Store. Two tables: the subscription rows and the delivered-event dedupe set.
// server.ts appends INITIATIVE_SUBSCRIPTION_MIGRATIONS to the plugin's single
// migrations array. Statements are append-only — label/prompt/poll_interval_ms
// arrive as ALTERs so a database that already ran the CREATE converges.
// ---------------------------------------------------------------------------

export const INITIATIVE_SUBSCRIPTION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS initiative_subscriptions (
     id                 TEXT PRIMARY KEY,
     initiative_id      TEXT NOT NULL,
     kind               TEXT NOT NULL,
     config             TEXT NOT NULL,
     enabled            INTEGER NOT NULL DEFAULT 1,
     next_run_at        INTEGER,
     last_run_at        INTEGER,
     last_status        TEXT,
     last_error         TEXT,
     cursor             TEXT,
     retry_after_until  INTEGER,
     delivery_attempts  INTEGER NOT NULL DEFAULT 0,
     created_at         INTEGER NOT NULL,
     updated_at         INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS initiative_subscriptions_due
     ON initiative_subscriptions (enabled, next_run_at)`,
  `CREATE TABLE IF NOT EXISTS initiative_subscription_deliveries (
     subscription_id TEXT NOT NULL,
     event_id        TEXT NOT NULL,
     delivered_at    INTEGER NOT NULL,
     PRIMARY KEY (subscription_id, event_id)
   )`,
  `ALTER TABLE initiative_subscriptions ADD COLUMN label TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE initiative_subscriptions ADD COLUMN prompt TEXT`,
  `ALTER TABLE initiative_subscriptions ADD COLUMN poll_interval_ms INTEGER`,
];

export type SubscriptionStatus =
  | "ok"
  | "quiet"
  | "baseline"
  | "error"
  | "rate_limited"
  | "delivery_error"
  | "invalid_config";

export interface InitiativeSubscription {
  id: string;
  initiativeId: string;
  kind: InitiativeSubscriptionKind;
  /** Human name shown in the tray and on digests, e.g. "CI on main". */
  label: string;
  /** Standing coordinator instruction wrapping each digest, when set. */
  prompt: string | null;
  /**
   * Parsed config, or null when the stored row cannot be validated. Corrupt
   * rows stay listed — `configError` says why — and the engine parks them
   * (nextRunAt = null) instead of retrying a poisoned row forever.
   */
  config: InitiativeSubscriptionConfig | null;
  configError: string | null;
  enabled: boolean;
  pollIntervalMs: number | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: SubscriptionStatus | null;
  lastError: string | null;
  /** Opaque per-kind durable state (scan position + backlog for slack). */
  cursor: string | null;
  retryAfterUntil: number | null;
  deliveryAttempts: number;
  createdAt: number;
  updatedAt: number;
}

interface SubscriptionRow {
  id: string;
  initiative_id: string;
  kind: string;
  config: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  cursor: string | null;
  retry_after_until: number | null;
  delivery_attempts: number;
  created_at: number;
  updated_at: number;
  label: string;
  prompt: string | null;
  poll_interval_ms: number | null;
}

/** Key-sorted stringify so semantically identical configs produce one key. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function rowToSubscription(row: SubscriptionRow): InitiativeSubscription {
  const kind = row.kind as InitiativeSubscriptionKind;
  let config: InitiativeSubscriptionConfig | null = null;
  let configError: string | null = null;
  try {
    config = parseSubscriptionConfig(kind, JSON.parse(row.config));
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    kind,
    label: row.label,
    prompt: row.prompt,
    config,
    configError,
    enabled: row.enabled === 1,
    pollIntervalMs: row.poll_interval_ms,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as SubscriptionStatus | null,
    lastError: row.last_error,
    cursor: row.cursor,
    retryAfterUntil: row.retry_after_until,
    deliveryAttempts: row.delivery_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateSubscriptionInput {
  id: string;
  initiativeId: string;
  kind: InitiativeSubscriptionKind;
  label: string;
  prompt?: string | null;
  config: unknown;
  pollIntervalMs?: number;
  now?: number;
}

export interface SubscriptionStore {
  create(
    input: CreateSubscriptionInput & { initialCursor?: string | null },
  ): InitiativeSubscription;
  get(id: string): InitiativeSubscription | null;
  list(initiativeId?: string): InitiativeSubscription[];
  /** Enabled rows whose next_run_at has arrived and that are not backing off. */
  listDue(now: number): InitiativeSubscription[];
  setEnabled(id: string, enabled: boolean, now: number): void;
  update(
    id: string,
    patch: { label?: string; prompt?: string | null; config?: unknown; pollIntervalMs?: number },
    now: number,
  ): InitiativeSubscription;
  remove(id: string): void;
  /** Event ids already delivered for one subscription. */
  deliveredEventIds(subscriptionId: string): Set<string>;
  /**
   * Persist poll-side state (cursor doc) without touching run bookkeeping —
   * used to save fetched progress before the digest send is attempted.
   */
  saveCursor(subscriptionId: string, cursor: string, now: number): void;
  /**
   * Commit a successful delivery in one transaction: dedupe rows + cursor +
   * run bookkeeping. Anything less atomic would lie about what was delivered.
   */
  recordDelivery(input: {
    subscriptionId: string;
    eventIds: string[];
    cursor: string | null;
    nextRunAt: number | null;
    status?: SubscriptionStatus;
    now: number;
    disableAfter?: boolean;
  }): void;
  recordPollResult(input: {
    subscriptionId: string;
    status: SubscriptionStatus;
    error: string | null;
    nextRunAt: number | null;
    retryAfterUntil?: number | null;
    cursor?: string | null;
    now: number;
  }): void;
  recordDeliveryFailure(input: {
    subscriptionId: string;
    error: string;
    nextRunAt: number;
    now: number;
  }): void;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 30_000;

export function createSubscriptionStore(db: Database): SubscriptionStore {
  const insertSubscription = db.prepare(
    `INSERT INTO initiative_subscriptions
       (id, initiative_id, kind, config, enabled, next_run_at, last_run_at,
        last_status, last_error, cursor, retry_after_until, delivery_attempts,
        created_at, updated_at, label, prompt, poll_interval_ms)
     VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, NULL, ?, NULL, 0, ?, ?, ?, ?, ?)`,
  );
  const selectById = db.prepare(`SELECT * FROM initiative_subscriptions WHERE id = ?`);
  const selectAll = db.prepare(`SELECT * FROM initiative_subscriptions ORDER BY created_at`);
  const selectByInitiative = db.prepare(
    `SELECT * FROM initiative_subscriptions WHERE initiative_id = ? ORDER BY created_at`,
  );
  const selectDue = db.prepare(
    `SELECT * FROM initiative_subscriptions
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         AND (retry_after_until IS NULL OR retry_after_until <= ?)
       ORDER BY next_run_at`,
  );
  const selectDelivered = db.prepare(
    `SELECT event_id FROM initiative_subscription_deliveries WHERE subscription_id = ?`,
  );
  const insertDelivery = db.prepare(
    `INSERT OR IGNORE INTO initiative_subscription_deliveries
       (subscription_id, event_id, delivered_at) VALUES (?, ?, ?)`,
  );

  const normalizedInterval = (pollIntervalMs: number | undefined): number =>
    Math.max(pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS);

  const computeNextRun = (
    kind: InitiativeSubscriptionKind,
    config: InitiativeSubscriptionConfig,
    pollIntervalMs: number | undefined,
    now: number,
  ): number | null => {
    if (kind === "schedule") {
      const parsed = config as SubscriptionScheduleConfig;
      if (parsed.schedule === "once") return parsed.runAt;
      return CronExpressionParser.parse(parsed.expression, { currentDate: new Date(now) })
        .next()
        .getTime();
    }
    return now + normalizedInterval(pollIntervalMs);
  };

  return {
    create(input) {
      const now = input.now ?? Date.now();
      const config = parseSubscriptionConfig(input.kind, input.config);
      const label = input.label.trim();
      if (label.length === 0) throw new Error("subscription label is required");
      insertSubscription.run(
        input.id,
        input.initiativeId,
        input.kind,
        JSON.stringify(config),
        computeNextRun(input.kind, config, input.pollIntervalMs, now),
        input.initialCursor ?? null,
        now,
        now,
        label,
        input.prompt ?? null,
        normalizedInterval(input.pollIntervalMs),
      );
      const created = this.get(input.id);
      if (!created) throw new Error(`subscription ${input.id} failed to persist`);
      return created;
    },
    get(id) {
      const row = selectById.get(id) as SubscriptionRow | undefined;
      return row ? rowToSubscription(row) : null;
    },
    list(initiativeId) {
      const rows = (
        initiativeId === undefined
          ? (selectAll.all() as SubscriptionRow[])
          : (selectByInitiative.all(initiativeId) as SubscriptionRow[])
      ) as SubscriptionRow[];
      return rows.map(rowToSubscription);
    },
    listDue(now) {
      const rows = selectDue.all(now, now) as SubscriptionRow[];
      return rows.map(rowToSubscription);
    },
    setEnabled(id, enabled, now) {
      db.prepare(
        `UPDATE initiative_subscriptions SET enabled = ?, updated_at = ? WHERE id = ?`,
      ).run(enabled ? 1 : 0, now, id);
    },
    update(id, patch, now) {
      const existing = this.get(id);
      if (!existing) throw new Error(`subscription ${id} not found`);
      const nextConfig =
        patch.config === undefined
          ? existing.config
          : parseSubscriptionConfig(existing.kind, patch.config);
      const nextLabel = patch.label === undefined ? existing.label : patch.label.trim();
      if (nextLabel.length === 0) throw new Error("subscription label is required");
      const nextPollInterval =
        patch.pollIntervalMs === undefined
          ? existing.pollIntervalMs
          : normalizedInterval(patch.pollIntervalMs);
      // Material source change: the written config differs (or the prior one
      // was corrupt) → cursor, dedupe history, and backoff reset to the new
      // source's baseline in the SAME transaction as the config write — a
      // crash between the two cannot leave new config with old progress.
      const configChanged =
        patch.config !== undefined &&
        (existing.config === null ||
          stableStringify(nextConfig) !== stableStringify(existing.config));
      db.transaction(() => {
        db.prepare(
          `UPDATE initiative_subscriptions
             SET label = ?, prompt = ?, config = ?, poll_interval_ms = ?,
                 next_run_at = ?, last_error = NULL, updated_at = ?
                 ${configChanged ? ", cursor = ?, delivery_attempts = 0, retry_after_until = NULL" : ""}
             WHERE id = ?`,
        ).run(
          nextLabel,
          patch.prompt === undefined ? existing.prompt : patch.prompt,
          JSON.stringify(nextConfig),
          nextPollInterval,
          patch.config === undefined || nextConfig === null
            ? existing.nextRunAt
            : computeNextRun(existing.kind, nextConfig, nextPollInterval ?? undefined, now),
          now,
          ...(configChanged && nextConfig !== null
            ? [initialCursorFor(existing.kind, nextConfig, now)]
            : []),
          id,
        );
        if (configChanged) {
          db.prepare(
            `DELETE FROM initiative_subscription_deliveries WHERE subscription_id = ?`,
          ).run(id);
        }
      })();
      const updated = this.get(id);
      if (!updated) throw new Error(`subscription ${id} failed to persist`);
      return updated;
    },
    remove(id) {
      db.prepare(`DELETE FROM initiative_subscription_deliveries WHERE subscription_id = ?`).run(
        id,
      );
      db.prepare(`DELETE FROM initiative_subscriptions WHERE id = ?`).run(id);
    },
    deliveredEventIds(subscriptionId) {
      const rows = selectDelivered.all(subscriptionId) as { event_id: string }[];
      return new Set(rows.map((row) => row.event_id));
    },
    saveCursor(subscriptionId, cursor, now) {
      db.prepare(`UPDATE initiative_subscriptions SET cursor = ?, updated_at = ? WHERE id = ?`).run(
        cursor,
        now,
        subscriptionId,
      );
    },
    recordDelivery({ subscriptionId, eventIds, cursor, nextRunAt, status, now, disableAfter }) {
      db.transaction(() => {
        for (const eventId of eventIds) insertDelivery.run(subscriptionId, eventId, now);
        db.prepare(
          `UPDATE initiative_subscriptions
             SET cursor = ?, last_run_at = ?, last_status = ?, last_error = NULL,
                 next_run_at = ?, retry_after_until = NULL, delivery_attempts = 0,
                 enabled = CASE WHEN ? THEN 0 ELSE enabled END, updated_at = ?
           WHERE id = ?`,
        ).run(cursor, now, status ?? "ok", nextRunAt, disableAfter ? 1 : 0, now, subscriptionId);
      })();
    },
    recordPollResult({ subscriptionId, status, error, nextRunAt, retryAfterUntil, cursor, now }) {
      db.prepare(
        `UPDATE initiative_subscriptions
           SET last_run_at = ?, last_status = ?, last_error = ?, next_run_at = ?,
               retry_after_until = COALESCE(?, retry_after_until),
               cursor = COALESCE(?, cursor), updated_at = ?
         WHERE id = ?`,
      ).run(
        now,
        status,
        error,
        nextRunAt,
        retryAfterUntil ?? null,
        cursor ?? null,
        now,
        subscriptionId,
      );
    },
    recordDeliveryFailure({ subscriptionId, error, nextRunAt, now }) {
      db.prepare(
        `UPDATE initiative_subscriptions
           SET last_run_at = ?, last_status = 'delivery_error', last_error = ?,
               next_run_at = ?, delivery_attempts = delivery_attempts + 1, updated_at = ?
         WHERE id = ?`,
      ).run(now, error, nextRunAt, now, subscriptionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Poll results. A one-shot poller (GitHub — its query already returns the
// full window) returns fresh events plus the cursor to store AFTER delivery.
// Slack returns a backlog view: the durable scan state + the sorted pending
// events to drain from. Poll failures return a typed error, never throw past
// the engine boundary.
// ---------------------------------------------------------------------------

export interface SubscriptionEvent {
  /** Stable dedupe id per source (gh run+attempt, comment node id, slack ts…). */
  eventId: string;
  /** One digest line, already formatted for the coordinator. */
  text: string;
  /** Source event time (epoch ms) for ordering. */
  occurredAt: number;
}

export type PollOutcome =
  | {
      ok: true;
      /** One-shot sources: fresh, dedupe-filtered events. */
      events: SubscriptionEvent[];
      cursor: string | null;
    }
  | {
      ok: true;
      /** Backlog sources (slack): durable state already safe to persist. */
      backlog: SlackPollResult;
    }
  | { ok: false; error: string; retryAfterUntil?: number };

// ---------------------------------------------------------------------------
// GitHub pollers. They call the plugin's host entry, which execs `gh` inside
// the bound environment's checkout — the host user's own gh auth, so no token
// ever touches the plugin.
// ---------------------------------------------------------------------------

export interface GitHubCiRun {
  databaseId: number;
  attempt: number;
  name: string;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  event: string;
  headBranch: string;
  url: string;
  updatedAt: string;
}

export interface GitHubPrSnapshot {
  number: number;
  title: string;
  url: string;
  state: string;
  mergedAt: string | null;
  comments: { id: string; author: { login: string } | null; body: string; createdAt: string }[];
  reviews: {
    id: string;
    author: { login: string } | null;
    body: string;
    state: string;
    submittedAt: string;
  }[];
  /** Inline code comments — `gh pr view` never returns these. */
  reviewComments: {
    id: string;
    author: { login: string } | null;
    body: string;
    createdAt: string;
    path: string;
    line: number | null;
    inReplyToId: string | null;
  }[];
}

/** gh fields requested by the host bridge for `githubPrActivity` scalars. */
export const GH_PR_JSON_FIELDS = "number,title,url,state,mergedAt,updatedAt";

/** Host bridge result unions — same shape the contract validates. */
export type GitHubCiRunsResult = { ok: true; runs: GitHubCiRun[] } | { ok: false; error: string };
export type GitHubPrActivityResult =
  | { ok: true; snapshot: GitHubPrSnapshot }
  | { ok: false; error: string };

function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function ciRunsToEvents(
  runs: GitHubCiRun[],
  delivered: ReadonlySet<string>,
): SubscriptionEvent[] {
  return runs
    .filter((run) => run.status === "completed")
    .map((run) => ({
      // attempt distinguishes a rerun of the same run: a failed run that is
      // retried delivers again instead of being swallowed by dedupe.
      eventId: `gh-ci-${run.databaseId}-a${run.attempt}`,
      occurredAt: Date.parse(run.updatedAt) || 0,
      text: `${run.conclusion ?? "completed"} · ${run.name} on ${run.headBranch} — ${excerpt(run.displayTitle, 80)} (${run.url})`,
    }))
    .filter((event) => !delivered.has(event.eventId))
    .sort((a, b) => a.occurredAt - b.occurredAt);
}

function prStateEvents(snapshot: GitHubPrSnapshot): SubscriptionEvent[] {
  if (snapshot.state === "MERGED" || snapshot.mergedAt) {
    return [
      {
        eventId: `gh-pr-${snapshot.number}-state-merged`,
        occurredAt: Date.parse(snapshot.mergedAt ?? "") || Date.now(),
        text: `PR #${snapshot.number} was merged`,
      },
    ];
  }
  if (snapshot.state === "CLOSED") {
    return [
      {
        eventId: `gh-pr-${snapshot.number}-state-closed`,
        occurredAt: Date.now(),
        text: `PR #${snapshot.number} was closed`,
      },
    ];
  }
  return [];
}

export function prSnapshotToEvents(
  snapshot: GitHubPrSnapshot,
  delivered: ReadonlySet<string>,
): SubscriptionEvent[] {
  const events: SubscriptionEvent[] = [];
  for (const comment of snapshot.comments ?? []) {
    events.push({
      eventId: `gh-pr-${snapshot.number}-comment-${comment.id}`,
      occurredAt: Date.parse(comment.createdAt) || 0,
      text: `${comment.author?.login ?? "ghost"} commented: ${excerpt(comment.body)}`,
    });
  }
  for (const review of snapshot.reviews ?? []) {
    events.push({
      eventId: `gh-pr-${snapshot.number}-review-${review.id}`,
      occurredAt: Date.parse(review.submittedAt) || 0,
      text: `${review.author?.login ?? "ghost"} reviewed (${review.state.toLowerCase().replace(/_/g, " ")}): ${excerpt(review.body || "(no summary)")}`,
    });
  }
  for (const comment of snapshot.reviewComments ?? []) {
    const where = comment.line !== null ? `${comment.path}:${comment.line}` : comment.path;
    events.push({
      eventId: `gh-pr-${snapshot.number}-rc-${comment.id}`,
      occurredAt: Date.parse(comment.createdAt) || 0,
      text: `${comment.author?.login ?? "ghost"} commented on ${where}: ${excerpt(comment.body)}`,
    });
  }
  events.push(...prStateEvents(snapshot));
  return events
    .filter((event) => !delivered.has(event.eventId))
    .sort((a, b) => a.occurredAt - b.occurredAt);
}

// ---------------------------------------------------------------------------
// Slack poller. Read-only conversations.history/replies via Web API; the bot
// token comes from plugin settings and is never logged or persisted here.
//
// The durable cursor is a JSON document, not a bare timestamp:
//   {
//     watermark,           // ts below which every channel message is accounted
//                          // for — only advances when a scan finishes its window
//     scan: {              // an in-progress channel scan, if any
//       windowOldest,      //   the `oldest` bound the scan started from
//       nextPageCursor,    //   Slack's opaque page cursor — resumes mid-window
//       topTs              //   newest ts seen so far this scan
//     } | null,
//     pending,             // fetched events not yet delivered (the backlog),
//                          // persisted so a truncated digest or a crash never
//                          // drops them
//   }
// conversations.history paginates NEWEST-first: a partial page set covers the
// top of the window but not the bottom, so `watermark` must not move until the
// scan completes (has_more false). Page fetches are limited to the backlog's
// remaining capacity, so a nearly-full backlog never makes the scan skip over
// messages it had no room to keep. A legacy bare-ts or earlier JSON cursor
// upgrades on parse.
// ---------------------------------------------------------------------------

const SLACK_API_BASE = "https://slack.com/api";
/** Pages per poll — bounds how long one busy channel holds a sweep. */
const SLACK_MAX_HISTORY_PAGES = 5;
const SLACK_HISTORY_PAGE_SIZE = 50;
/** Backlog cap — fetching pauses while this many events await delivery. */
const SLACK_MAX_PENDING = 200;

export interface SlackPendingEvent {
  eventId: string;
  /** Source slack ts — also the sort key for digest ordering. */
  ts: string;
  occurredAt: number;
  text: string;
}

export interface SlackPollState {
  watermark: string | null;
  scan: { windowOldest: string; nextPageCursor: string | null; topTs: string } | null;
  pending: SlackPendingEvent[];
}

function parsePendingEntry(item: {
  eventId?: unknown;
  ts?: unknown;
  occurredAt?: unknown;
  text?: unknown;
}): SlackPendingEvent | null {
  if (typeof item?.eventId !== "string" || typeof item.ts !== "string") return null;
  if (typeof item.text !== "string") return null;
  return {
    eventId: item.eventId,
    ts: item.ts,
    occurredAt: typeof item.occurredAt === "number" ? item.occurredAt : 0,
    text: item.text,
  };
}

function parseScanState(
  scan: {
    windowOldest?: unknown;
    nextPageCursor?: unknown;
    topTs?: unknown;
  } | null,
): SlackPollState["scan"] {
  if (!scan || typeof scan.windowOldest !== "string") return null;
  return {
    windowOldest: scan.windowOldest,
    nextPageCursor: typeof scan.nextPageCursor === "string" ? scan.nextPageCursor : null,
    topTs: typeof scan.topTs === "string" ? scan.topTs : scan.windowOldest,
  };
}

export function parseSlackCursor(raw: string | null): SlackPollState {
  const empty: SlackPollState = { watermark: null, scan: null, pending: [] };
  if (raw === null) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const value = parsed as {
        watermark?: unknown;
        scan?: Parameters<typeof parseScanState>[0];
        pending?: Parameters<typeof parsePendingEntry>[0][];
      };
      return {
        watermark: typeof value.watermark === "string" ? value.watermark : null,
        scan: parseScanState(value.scan ?? null),
        pending: (value.pending ?? [])
          .map(parsePendingEntry)
          .filter((item): item is SlackPendingEvent => item !== null),
      };
    }
  } catch {
    // Bare-ts cursor from before the JSON shape — treat it as the watermark.
  }
  return { ...empty, watermark: raw };
}

export function serializeSlackCursor(state: SlackPollState): string {
  return JSON.stringify(state);
}

/** Remove accepted events from the pending backlog after the send commits. */
export function slackStateAfterDelivery(
  state: SlackPollState,
  acceptedEventIds: ReadonlySet<string>,
): SlackPollState {
  return { ...state, pending: state.pending.filter((item) => !acceptedEventIds.has(item.eventId)) };
}

export interface SlackPollResult {
  /** All pending events, oldest first — the engine drains up to maxEvents. */
  drain: SlackPendingEvent[];
  state: SlackPollState;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
}

const SLACK_SKIP_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
]);

function isDeliverableSlackMessage(message: SlackMessage): boolean {
  return (
    typeof message.ts === "string" &&
    message.ts.length > 0 &&
    (!message.subtype || !SLACK_SKIP_SUBTYPES.has(message.subtype)) &&
    typeof message.text === "string" &&
    message.text.trim().length > 0
  );
}

function slackEventId(channelId: string, ts: string): string {
  return `slack-${channelId}-${ts}`;
}

function slackMessageToPending(channelId: string, message: SlackMessage): SlackPendingEvent {
  return {
    eventId: slackEventId(channelId, message.ts),
    ts: message.ts,
    occurredAt: Math.floor(Number.parseFloat(message.ts) * 1000),
    text: `${message.user ? `<${message.user}>` : message.bot_id ? "bot" : "unknown"}: ${excerpt(message.text ?? "")}`,
  };
}

export function slackMessagesToEvents(
  messages: SlackMessage[],
  delivered: ReadonlySet<string>,
  channelId: string,
): SubscriptionEvent[] {
  return messages
    .filter(isDeliverableSlackMessage)
    .map((message) => slackMessageToPending(channelId, message))
    .filter((event) => !delivered.has(event.eventId))
    .sort((a, b) => a.occurredAt - b.occurredAt);
}

export type SlackApiResult =
  | { ok: true; messages: SlackMessage[]; hasMore: boolean; nextCursor?: string }
  | { ok: false; error: string; retryAfterMs?: number };

async function callSlackApi(
  fetchImpl: typeof fetch,
  token: string,
  method: "conversations.history",
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<SlackApiResult> {
  const url = new URL(`${SLACK_API_BASE}/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
  } catch (error) {
    if (signal.aborted) return { ok: false, error: "aborted" };
    return {
      ok: false,
      error: `network: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 429) {
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    return {
      ok: false,
      error: "rate_limited",
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 60_000,
    };
  }
  let body: {
    ok?: boolean;
    error?: string;
    messages?: SlackMessage[];
    has_more?: boolean;
    response_metadata?: { next_cursor?: string };
    retry_after?: number;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, error: `invalid response (HTTP ${response.status})` };
  }
  if (!body.ok) {
    const retryAfterMs = body.error === "ratelimited" ? (body.retry_after ?? 60) * 1000 : undefined;
    return { ok: false, error: body.error ?? "unknown_error", retryAfterMs };
  }
  return {
    ok: true,
    messages: body.messages ?? [],
    hasMore: body.has_more ?? false,
    nextCursor: body.response_metadata?.next_cursor,
  };
}

// ---------------------------------------------------------------------------
// Engine. Injected deps keep every bb surface behind a narrow interface so
// tests exercise the real logic with fakes.
// ---------------------------------------------------------------------------

export interface SubscriptionEngineDeps {
  /** Global opt-in. Checked before polling and again before delivery. */
  isEnabled(): boolean;
  store: SubscriptionStore;
  /** Resolve an initiative's coordinator thread; null = gone/not yet created. */
  getCoordinatorThreadId(initiativeId: string): Promise<string | null>;
  /** Archived/disabled initiatives must not produce work — backend supplies. */
  isInitiativeActive(initiativeId: string): Promise<boolean> | boolean;
  threads: {
    get(args: {
      threadId: string;
    }): Promise<{ archivedAt: number | null; deletedAt: number | null }>;
    send(args: {
      threadId: string;
      input: { type: "text"; text: string; mentions: never[] }[];
      /** "auto" dispatches when idle, queues when busy — digests never lost. */
      mode: "auto";
    }): Promise<unknown>;
  };
  environments: {
    get(args: { environmentId: string }): Promise<{ hostId: string; path: string | null }>;
  };
  host: {
    call(
      method: "githubCiRuns" | "githubPrActivity",
      input: Record<string, unknown>,
      options: { hostId: string; signal?: AbortSignal },
    ): Promise<unknown>;
  };
  getSlackToken(): Promise<string | undefined>;
  publish(channel: string, payload: unknown): void;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  fetchImpl?: typeof fetch;
  now(): number;
  /** Max events per digest; overflow stays in the backlog for the next sweep. */
  maxEventsPerDigest?: number;
  /** Delivery retry backoff base; attempt n waits n²×base, capped 15min. */
  deliveryRetryBaseMs?: number;
}

export const SUBSCRIPTIONS_REALTIME_CHANNEL = "initiative-subscriptions";

const MAX_DIGEST_EVENTS_DEFAULT = 25;
const DELIVERY_RETRY_BASE_DEFAULT = 30_000;
const DELIVERY_RETRY_CAP_MS = 15 * 60_000;
/** Marker stored in `cursor` once a non-catch-up poll subscription baselined. */
const BASELINE_CURSOR = "established";

function slackTsFromMs(ms: number): string {
  return (ms / 1000).toFixed(6);
}

/**
 * The durable start position for a (kind, config) pair. Poll subscriptions
 * without catch-up start "now"-ish — slack stamps the watermark at create
 * time, github baselines on the first poll (cursor stays null until then).
 */
export function initialCursorFor(
  kind: InitiativeSubscriptionKind,
  config: InitiativeSubscriptionConfig,
  now: number,
): string | null {
  const catchUp = (config as { catchUp?: boolean }).catchUp === true;
  if (kind === "slack-channel") {
    return serializeSlackCursor({
      watermark: catchUp ? "0" : slackTsFromMs(now),
      scan: null,
      pending: [],
    });
  }
  if (kind !== "schedule" && catchUp) return "0";
  return null;
}

export function createSubscriptionEngine(deps: SubscriptionEngineDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxEvents = deps.maxEventsPerDigest ?? MAX_DIGEST_EVENTS_DEFAULT;
  const retryBase = deps.deliveryRetryBaseMs ?? DELIVERY_RETRY_BASE_DEFAULT;
  /** Per-subscription execution claim — manual and scheduled runs share it. */
  const inFlight = new Set<string>();
  const abortController = new AbortController();
  let disposed = false;

  const deliveryBackoff = (attempts: number) =>
    Math.min(attempts * attempts * retryBase, DELIVERY_RETRY_CAP_MS);

  const pollIntervalFor = (subscription: InitiativeSubscription): number =>
    Math.max(subscription.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS);

  function nextRunAfter(subscription: InitiativeSubscription, now: number): number | null {
    if (subscription.kind === "schedule") {
      const config = subscription.config as SubscriptionScheduleConfig;
      if (config.schedule === "once") return null;
      try {
        return CronExpressionParser.parse(config.expression, { currentDate: new Date(now) })
          .next()
          .getTime();
      } catch {
        return now + pollIntervalFor(subscription);
      }
    }
    return now + pollIntervalFor(subscription);
  }

  /**
   * True while the stored row still carries the config this run started with.
   * A material config change makes the in-flight run stale: its fetched
   * events belong to the old source and must never reach the new one.
   * Derived from kind+parsed config so corrupt rows fingerprint uniformly.
   */
  function configKeyOf(subscription: {
    kind: InitiativeSubscriptionKind;
    config: InitiativeSubscriptionConfig | null;
  }): string {
    return `${subscription.kind}|${subscription.config === null ? "invalid" : stableStringify(subscription.config)}`;
  }

  async function configCurrent(subscription: InitiativeSubscription): Promise<boolean> {
    const fresh = deps.store.get(subscription.id);
    return fresh !== null && configKeyOf(fresh) === configKeyOf(subscription);
  }

  /**
   * Re-read the row and re-check the initiative right before sending: a slow
   * poll may span a disable/delete/archive/config edit, and nothing fetched
   * may be delivered once the owner turned it off or repointed the source.
   */
  async function stillDeliverable(subscription: InitiativeSubscription): Promise<boolean> {
    if (disposed || !deps.isEnabled()) return false;
    const fresh = deps.store.get(subscription.id);
    if (!fresh || !fresh.enabled) return false;
    if (configKeyOf(fresh) !== configKeyOf(subscription)) return false;
    return deps.isInitiativeActive(subscription.initiativeId);
  }

  async function pollSlack(
    subscription: InitiativeSubscription,
    config: SlackChannelConfig,
  ): Promise<PollOutcome> {
    const token = await deps.getSlackToken();
    if (!token) {
      return {
        ok: false,
        error: "slack-not-configured: set the plugin's Slack bot token in settings",
      };
    }
    const state = parseSlackCursor(subscription.cursor);
    const delivered = deps.store.deliveredEventIds(subscription.id);
    const pendingIds = new Set(state.pending.map((item) => item.eventId));
    const room = () => SLACK_MAX_PENDING - state.pending.length;

    /** Add a fetched message to the durable backlog unless already accounted. */
    const enqueue = (message: SlackMessage) => {
      if (!isDeliverableSlackMessage(message) || room() <= 0) return;
      const item = slackMessageToPending(config.channelId, message);
      if (delivered.has(item.eventId) || pendingIds.has(item.eventId)) return;
      pendingIds.add(item.eventId);
      state.pending.push(item);
    };

    /** Persist progress, then fail — a mid-scan 429 resumes where it stopped. */
    const fail = (error: string, retryAfterMs?: number): PollOutcome => {
      deps.store.saveCursor(subscription.id, serializeSlackCursor(state), deps.now());
      return retryAfterMs === undefined
        ? { ok: false, error }
        : { ok: false, error, retryAfterUntil: deps.now() + retryAfterMs };
    };

    // Channel history: continue the in-progress scan or open a new one at the
    // watermark. Newest-first pages mean the watermark only moves when a scan
    // completes its window; the page cursor carries us across sweeps. Each
    // request's limit is the backlog's remaining capacity, so a fetched page
    // can never contain more deliverable messages than we can durably keep —
    // a nearly-full backlog shrinks the page instead of dropping its tail.
    for (let page = 0; page < SLACK_MAX_HISTORY_PAGES && room() > 0; page++) {
      if (abortController.signal.aborted) return { ok: false, error: "aborted" };
      const scan = state.scan ?? {
        windowOldest: state.watermark ?? "0",
        nextPageCursor: null,
        topTs: state.watermark ?? "0",
      };
      const history = await callSlackApi(
        fetchImpl,
        token,
        "conversations.history",
        {
          channel: config.channelId,
          oldest: scan.windowOldest,
          inclusive: "false",
          limit: String(Math.min(SLACK_HISTORY_PAGE_SIZE, room())),
          ...(scan.nextPageCursor ? { cursor: scan.nextPageCursor } : {}),
        },
        abortController.signal,
      );
      if (!history.ok) return fail(history.error, history.retryAfterMs);
      for (const message of history.messages) {
        if (isDeliverableSlackMessage(message)) enqueue(message);
        if (message.ts > scan.topTs) scan.topTs = message.ts;
      }
      if (!history.hasMore || !history.nextCursor) {
        // Scan completed its window — everything ≤ topTs is now delivered or
        // durably pending, so the watermark may advance.
        state.scan = null;
        if (scan.topTs > (state.watermark ?? "0")) state.watermark = scan.topTs;
        break;
      }
      state.scan = { ...scan, nextPageCursor: history.nextCursor };
    }

    const drain = [...state.pending].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return { ok: true, backlog: { drain, state } };
  }

  async function poll(subscription: InitiativeSubscription): Promise<PollOutcome> {
    if (subscription.config === null) {
      return { ok: false, error: `invalid stored config: ${subscription.configError}` };
    }
    const delivered = deps.store.deliveredEventIds(subscription.id);
    switch (subscription.kind) {
      case "github-ci":
      case "github-pr": {
        const config = subscription.config as GitHubCiConfig | GitHubPrConfig;
        let environment: { hostId: string; path: string | null };
        try {
          environment = await deps.environments.get({ environmentId: config.environmentId });
        } catch (error) {
          return { ok: false, error: `environment unavailable: ${describeError(error)}` };
        }
        if (!environment.path) {
          return { ok: false, error: "bound environment has no checkout on its host" };
        }
        if (subscription.kind === "github-ci") {
          const ci = config as GitHubCiConfig;
          let result: unknown;
          try {
            result = await deps.host.call(
              "githubCiRuns",
              { cwd: environment.path, repo: ci.repo, branch: ci.branch },
              { hostId: environment.hostId, signal: abortController.signal },
            );
          } catch (error) {
            return { ok: false, error: `gh query failed: ${describeError(error)}` };
          }
          const outcome = result as GitHubCiRunsResult;
          if (!outcome.ok) return { ok: false, error: outcome.error };
          return {
            ok: true,
            events: ciRunsToEvents(outcome.runs, delivered),
            cursor: subscription.cursor,
          };
        }
        const pr = config as GitHubPrConfig;
        let result: unknown;
        try {
          result = await deps.host.call(
            "githubPrActivity",
            { cwd: environment.path, repo: pr.repo, pr: pr.pr },
            { hostId: environment.hostId, signal: abortController.signal },
          );
        } catch (error) {
          return { ok: false, error: `gh query failed: ${describeError(error)}` };
        }
        const outcome = result as GitHubPrActivityResult;
        if (!outcome.ok) return { ok: false, error: outcome.error };
        return {
          ok: true,
          events: prSnapshotToEvents(outcome.snapshot, delivered),
          cursor: subscription.cursor,
        };
      }
      case "slack-channel":
        return pollSlack(subscription, subscription.config as SlackChannelConfig);
      case "schedule":
        // Schedules don't poll — the event is the tick itself, formatted by
        // runOne. This branch is unreachable through execute but kept for
        // exhaustiveness.
        return { ok: true, events: [], cursor: subscription.cursor };
    }
  }

  function formatDigest(
    subscription: InitiativeSubscription,
    events: { text: string }[],
    remaining: number,
  ): string {
    const lines = events.map((event) => `- ${event.text}`).join("\n");
    const suffix = remaining > 0 ? `\n- (+${remaining} more, delivered on the next check)` : "";
    const header = `[subscription "${subscription.label}" · ${subscription.kind} · ${new Date(deps.now()).toISOString()}]`;
    const instruction = subscription.prompt ? `\n${subscription.prompt}\n` : "";
    return `${header}${instruction}\n${lines}${suffix}`;
  }

  async function deliver(subscription: InitiativeSubscription, text: string): Promise<void> {
    const coordinatorId = await deps.getCoordinatorThreadId(subscription.initiativeId);
    if (!coordinatorId) throw new Error("coordinator thread missing");
    let thread: { archivedAt: number | null; deletedAt: number | null } | null = null;
    try {
      thread = await deps.threads.get({ threadId: coordinatorId });
    } catch (error) {
      throw new Error(`coordinator thread unavailable: ${describeError(error)}`, { cause: error });
    }
    if (thread === null || thread.deletedAt !== null) {
      throw new Error("coordinator thread deleted");
    }
    if (thread.archivedAt !== null) {
      throw new Error("coordinator thread archived — unarchive to resume this subscription");
    }
    if (disposed || !deps.isEnabled()) throw new Error("subscription engine disabled");
    await deps.threads.send({
      threadId: coordinatorId,
      input: [{ type: "text", text, mentions: [] }],
      mode: "auto",
    });
  }

  const notify = (subscriptionId: string) =>
    deps.publish(SUBSCRIPTIONS_REALTIME_CHANNEL, { subscriptionId });

  /**
   * Deliver a digest, recording a retryable failure instead of throwing.
   * Returns true only when the send was accepted.
   */
  async function tryDeliver(subscription: InitiativeSubscription, text: string): Promise<boolean> {
    try {
      await deliver(subscription, text);
      return true;
    } catch (error) {
      // A stale run must not write backoff state onto a reconfigured row.
      if (!(await configCurrent(subscription))) return false;
      deps.store.recordDeliveryFailure({
        subscriptionId: subscription.id,
        error: describeError(error),
        nextRunAt: deps.now() + deliveryBackoff(subscription.deliveryAttempts + 1),
        now: deps.now(),
      });
      notify(subscription.id);
      return false;
    }
  }

  async function runSchedule(
    subscription: InitiativeSubscription,
    config: SubscriptionScheduleConfig,
    now: number,
  ): Promise<void> {
    if (!(await tryDeliver(subscription, config.prompt))) return;
    if (!(await configCurrent(subscription))) return;
    deps.store.recordDelivery({
      subscriptionId: subscription.id,
      eventIds: [`schedule-${subscription.id}-${now}`],
      cursor: subscription.cursor,
      nextRunAt: config.schedule === "once" ? null : nextRunAfter(subscription, now),
      now,
      disableAfter: config.schedule === "once",
    });
    notify(subscription.id);
  }

  /** Backlog sources (slack): persist fetched state, re-check, drain. */
  async function commitBacklogOutcome(
    subscription: InitiativeSubscription,
    backlog: SlackPollResult,
    now: number,
  ): Promise<void> {
    const { drain, state } = backlog;
    // Fetch progress (pending backlog + scan cursors) is durable before any
    // send attempt — a crash or disable mid-way loses nothing. A config change
    // mid-poll makes the run stale: the new source's baseline owns the row.
    if (!(await configCurrent(subscription))) return;
    deps.store.saveCursor(subscription.id, serializeSlackCursor(state), deps.now());
    if (!(await stillDeliverable(subscription))) return;
    const accepted = drain.slice(0, maxEvents);
    if (accepted.length === 0) {
      deps.store.recordPollResult({
        subscriptionId: subscription.id,
        status: "quiet",
        error: null,
        nextRunAt: nextRunAfter(subscription, now),
        retryAfterUntil: null,
        cursor: serializeSlackCursor(state),
        now: deps.now(),
      });
      return;
    }
    if (disposed) return;
    if (
      !(await tryDeliver(
        subscription,
        formatDigest(subscription, accepted, drain.length - accepted.length),
      ))
    ) {
      return;
    }
    if (disposed) return; // sent before the abort — leave commit for next load
    if (!(await configCurrent(subscription))) return;
    const acceptedIds = new Set(accepted.map((event) => event.eventId));
    deps.store.recordDelivery({
      subscriptionId: subscription.id,
      eventIds: [...acceptedIds],
      cursor: serializeSlackCursor(slackStateAfterDelivery(state, acceptedIds)),
      nextRunAt: nextRunAfter(subscription, deps.now()),
      now: deps.now(),
    });
    notify(subscription.id);
  }

  /** One-shot sources (github): the query returns the whole window, so unsent
   * overflow is re-fetched next sweep — no durable backlog needed. */
  async function commitOneShotOutcome(
    subscription: InitiativeSubscription,
    outcome: Extract<PollOutcome, { ok: true; events: SubscriptionEvent[] }>,
    now: number,
  ): Promise<void> {
    const catchUp = (subscription.config as { catchUp?: boolean }).catchUp === true;
    if (!(await configCurrent(subscription))) return;
    if (subscription.cursor === null && !catchUp) {
      // First successful poll of a non-catch-up subscription establishes the
      // baseline: pre-existing items are marked delivered without a digest,
      // so subscribing to a busy source does not dump history.
      deps.store.recordDelivery({
        subscriptionId: subscription.id,
        eventIds: outcome.events.map((event) => event.eventId),
        cursor: outcome.cursor ?? BASELINE_CURSOR,
        nextRunAt: nextRunAfter(subscription, now),
        status: "baseline",
        now,
      });
      notify(subscription.id);
      return;
    }

    const events = outcome.events.slice(0, maxEvents);
    if (events.length === 0) {
      deps.store.recordPollResult({
        subscriptionId: subscription.id,
        status: "quiet",
        error: null,
        nextRunAt: nextRunAfter(subscription, now),
        retryAfterUntil: null,
        now,
      });
      return;
    }

    if (!(await stillDeliverable(subscription))) return;
    if (
      !(await tryDeliver(
        subscription,
        formatDigest(subscription, events, outcome.events.length - events.length),
      ))
    ) {
      return;
    }
    if (disposed) return;
    if (!(await configCurrent(subscription))) return;
    deps.store.recordDelivery({
      subscriptionId: subscription.id,
      eventIds: events.map((event) => event.eventId),
      cursor: outcome.cursor,
      nextRunAt: nextRunAfter(subscription, deps.now()),
      now: deps.now(),
    });
    notify(subscription.id);
  }

  async function runOne(subscription: InitiativeSubscription): Promise<void> {
    const now = deps.now();
    if (disposed) return;

    if (subscription.config === null) {
      // A corrupt row parks itself: the error stays visible on the record,
      // the schedule stops, and nothing is silently retried forever.
      deps.store.recordPollResult({
        subscriptionId: subscription.id,
        status: "invalid_config",
        error: subscription.configError ?? "invalid stored config",
        nextRunAt: null,
        now,
      });
      notify(subscription.id);
      return;
    }

    if (!(await deps.isInitiativeActive(subscription.initiativeId))) {
      // Paused/archived initiative: skip silently. Polls and crons re-arm at
      // the next future slot so resuming does not burst-deliver a backlog —
      // but a pending one-shot keeps its run_at, since overwriting it with
      // null would silently consume a send the user still expects.
      const pendingOnce =
        subscription.kind === "schedule" &&
        (subscription.config as SubscriptionScheduleConfig).schedule === "once";
      deps.store.recordPollResult({
        subscriptionId: subscription.id,
        status: "quiet",
        error: null,
        nextRunAt: pendingOnce ? subscription.nextRunAt : nextRunAfter(subscription, now),
        now,
      });
      return;
    }

    if (subscription.kind === "schedule") {
      await runSchedule(subscription, subscription.config as SubscriptionScheduleConfig, now);
      return;
    }

    let outcome: PollOutcome;
    try {
      outcome = await poll(subscription);
    } catch (error) {
      outcome = { ok: false, error: describeError(error) };
    }
    if (disposed) return; // reload/disable landed mid-poll — record nothing
    // A config edit mid-poll re-baselined the row; this run's outcome belongs
    // to the old source and must not write status, cursor, or errors onto it.
    if (!(await configCurrent(subscription))) return;

    if (!outcome.ok) {
      deps.store.recordPollResult({
        subscriptionId: subscription.id,
        status:
          outcome.error === "rate_limited" || outcome.error === "ratelimited"
            ? "rate_limited"
            : "error",
        error: outcome.error,
        nextRunAt:
          outcome.retryAfterUntil !== undefined
            ? outcome.retryAfterUntil
            : nextRunAfter(subscription, now),
        retryAfterUntil: outcome.retryAfterUntil,
        now,
      });
      notify(subscription.id);
      return;
    }

    if ("backlog" in outcome) {
      await commitBacklogOutcome(subscription, outcome.backlog, now);
      return;
    }
    await commitOneShotOutcome(subscription, outcome, now);
  }

  async function execute(id: string): Promise<"ran" | "in-flight" | "not-found" | "disposed"> {
    if (disposed || !deps.isEnabled()) return "disposed";
    if (inFlight.has(id)) return "in-flight";
    const subscription = deps.store.get(id);
    if (!subscription) return "not-found";
    inFlight.add(id);
    try {
      await runOne(subscription);
      return "ran";
    } finally {
      inFlight.delete(id);
    }
  }

  const api = {
    /**
     * One pass over every due subscription. Each subscription executes under
     * its own claim, so a manual runNow during the sweep cannot double-send.
     */
    async sweep(): Promise<void> {
      if (disposed || !deps.isEnabled()) return;
      for (const subscription of deps.store.listDue(deps.now())) {
        if (disposed) return;
        try {
          await execute(subscription.id);
        } catch (error) {
          deps.log.error(`subscription ${subscription.id} sweep failed: ${describeError(error)}`);
        }
      }
    },
    /** Force one subscription now (UI "run once", tests). */
    async runNow(id: string): Promise<"ran" | "in-flight" | "not-found" | "disposed"> {
      return execute(id);
    },
    /** Create with the kind's durable start position already computed. */
    createSubscription(input: CreateSubscriptionInput): InitiativeSubscription {
      const config = parseSubscriptionConfig(input.kind, input.config);
      const created = deps.store.create({
        ...input,
        config,
        initialCursor: initialCursorFor(input.kind, config, input.now ?? deps.now()),
      });
      notify(created.id);
      return created;
    },
    /** Upsert helper for the RPC/agent-tool boundary. */
    upsertSubscription(input: {
      subscriptionId?: string;
      initiativeId: string;
      kind: InitiativeSubscriptionKind;
      label: string;
      prompt?: string | null;
      config: unknown;
      enabled?: boolean;
      pollIntervalMs?: number;
      now?: number;
    }): InitiativeSubscription {
      const now = input.now ?? deps.now();
      if (input.subscriptionId) {
        // store.update is one transaction: a material config change resets
        // cursor + dedupe + backoff alongside the config write, while
        // label/prompt-only edits preserve all progress.
        deps.store.update(
          input.subscriptionId,
          {
            label: input.label,
            prompt: input.prompt,
            config: input.config,
            pollIntervalMs: input.pollIntervalMs,
          },
          now,
        );
        if (input.enabled !== undefined) {
          deps.store.setEnabled(input.subscriptionId, input.enabled, now);
        }
        const result = deps.store.get(input.subscriptionId);
        if (!result) throw new Error(`subscription ${input.subscriptionId} failed to persist`);
        notify(result.id);
        return result;
      }
      const created = api.createSubscription({
        id: `sub-${crypto.randomUUID()}`,
        initiativeId: input.initiativeId,
        kind: input.kind,
        label: input.label,
        prompt: input.prompt,
        config: input.config,
        pollIntervalMs: input.pollIntervalMs,
        now,
      });
      // createSubscription already published; a disabled flag flips the row
      // but one notification still covers the whole mutation.
      if (input.enabled === false) deps.store.setEnabled(created.id, false, now);
      return deps.store.get(created.id) ?? created;
    },
    /**
     * The single delete path — RPC, agent tool, and tests must all go through
     * here so removal publishes a realtime refresh. store.remove() alone
     * leaves every open Listening tray stale.
     */
    deleteSubscription(id: string): boolean {
      if (deps.store.get(id) === null) return false;
      deps.store.remove(id);
      notify(id);
      return true;
    },
    /** Drop subscriptions whose initiative is gone (backend wires deletes). */
    removeForInitiative(initiativeId: string): void {
      for (const subscription of deps.store.list(initiativeId)) {
        deps.store.remove(subscription.id);
        notify(subscription.id);
      }
    },
    /**
     * Stop accepting work and abort in-flight network calls. After dispose no
     * digest is sent and no bookkeeping is written; a reload starts a fresh
     * engine over the same durable rows.
     */
    dispose(): void {
      disposed = true;
      abortController.abort();
    },
    /** Test/introspection hook: is a run for this subscription in flight? */
    isRunning(id: string): boolean {
      return inFlight.has(id);
    },
  };
  return api;
}

export type SubscriptionEngine = ReturnType<typeof createSubscriptionEngine>;

// ---------------------------------------------------------------------------
// Runtime registration. server.ts calls this once with the live `bb` api and
// the initiative lookups it owns; everything else stays inside the module.
// ---------------------------------------------------------------------------

export interface InitiativeSubscriptionRuntimeDeps {
  isEnabled(): boolean;
  getCoordinatorThreadId(initiativeId: string): Promise<string | null>;
  isInitiativeActive(initiativeId: string): Promise<boolean> | boolean;
  getSlackToken(): Promise<string | undefined>;
  hostCall: SubscriptionEngineDeps["host"]["call"];
  sweepIntervalMs?: number;
}

/**
 * Register the sweep service and lifecycle wiring against `bb`. Returns the
 * engine so server.ts can also expose `runNow`/CRUD over RPC. The service's
 * abort signal disposes the engine: an in-flight poll finishes unwinding but
 * never sends or commits after reload/disable.
 */
export function registerInitiativeSubscriptions(
  bb: {
    storage: { database(): Database };
    background: {
      service(name: string, service: { start(signal: AbortSignal): void | Promise<void> }): void;
    };
    sdk: {
      threads: SubscriptionEngineDeps["threads"];
      environments: SubscriptionEngineDeps["environments"];
    };
    realtime: { publish(channel: string, payload: unknown): void };
    log: SubscriptionEngineDeps["log"];
    onDispose(hook: () => void | Promise<void>): void;
  },
  runtime: InitiativeSubscriptionRuntimeDeps,
): SubscriptionEngine {
  const store = createSubscriptionStore(bb.storage.database());
  const createEngine = (): SubscriptionEngine =>
    createSubscriptionEngine({
      store,
      isEnabled: runtime.isEnabled,
      getCoordinatorThreadId: runtime.getCoordinatorThreadId,
      isInitiativeActive: runtime.isInitiativeActive,
      threads: bb.sdk.threads,
      environments: bb.sdk.environments,
      host: { call: runtime.hostCall },
      getSlackToken: runtime.getSlackToken,
      publish: (channel, payload) => bb.realtime.publish(channel, payload),
      log: bb.log,
      now: () => Date.now(),
    });
  // CRUD only needs the durable store and publish callback, so keep it
  // available before the first run and while bb backs off between restarts.
  const mutationEngine = createEngine();
  let currentEngine: SubscriptionEngine | null = null;
  // RPC and agent-tool registrations keep this stable facade while each
  // background-service run owns a fresh abortable engine instance.
  const engine: SubscriptionEngine = {
    sweep: () => currentEngine?.sweep() ?? Promise.resolve(),
    runNow: (id) => currentEngine?.runNow(id) ?? Promise.resolve("disposed"),
    createSubscription: (input) => mutationEngine.createSubscription(input),
    upsertSubscription: (input) => mutationEngine.upsertSubscription(input),
    deleteSubscription: (id) => mutationEngine.deleteSubscription(id),
    removeForInitiative: (initiativeId) => mutationEngine.removeForInitiative(initiativeId),
    dispose: () => {
      currentEngine?.dispose();
      currentEngine = null;
      mutationEngine.dispose();
    },
    isRunning: (id) => currentEngine?.isRunning(id) ?? false,
  };

  const sweepInterval = runtime.sweepIntervalMs ?? 15_000;
  bb.background.service("initiative-subscriptions", {
    start(signal) {
      const runEngine = createEngine();
      currentEngine?.dispose();
      currentEngine = runEngine;
      if (signal.aborted) {
        runEngine.dispose();
        currentEngine = null;
        return;
      }
      const timer = setInterval(() => {
        void runEngine.sweep().catch((error) => {
          bb.log.warn(`initiative subscription sweep failed: ${describeError(error)}`);
        });
      }, sweepInterval);
      return new Promise<Event>((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      }).then(() => {
        clearInterval(timer);
        runEngine.dispose();
        if (currentEngine === runEngine) currentEngine = null;
        return undefined;
      });
    },
  });
  bb.onDispose(() => engine.dispose());

  return engine;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
