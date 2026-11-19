import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ASK_KINDS, type AskKind } from "../contract/queue.ts";
import { parseRole, type Role } from "./roles.ts";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/**
 * `captain/data.db`: only what nothing else records. The asks are the one
 * piece of work-facing state; the rest is bookkeeping. Append-only: never
 * edit or reorder a shipped statement, only add new ones.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE captains (
    thread_id TEXT PRIMARY KEY CHECK (thread_id GLOB 'thr_*'),
    name TEXT NOT NULL,
    home_project_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    merge_task_key TEXT,
    dream_task_key TEXT
  )`,
  `CREATE TABLE captain_repos (
    captain_id TEXT NOT NULL REFERENCES captains(thread_id),
    bb_project_id TEXT NOT NULL,
    tasks_project_key TEXT NOT NULL,
    PRIMARY KEY (captain_id, bb_project_id)
  )`,
  `CREATE TABLE crew_roles (
    thread_id TEXT PRIMARY KEY CHECK (thread_id GLOB 'thr_*'),
    captain_id TEXT NOT NULL,
    role TEXT NOT NULL,
    report_due_since INTEGER,
    contract_sent INTEGER NOT NULL DEFAULT 0 CHECK (contract_sent IN (0, 1))
  )`,
  `CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    captain_id TEXT NOT NULL,
    task_key TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'ship', 'access', 'improve')),
    text TEXT NOT NULL,
    detail TEXT NOT NULL,
    options TEXT,
    asked_at INTEGER NOT NULL,
    answer TEXT,
    answered_at INTEGER,
    answer_delivered_at INTEGER,
    snoozed_until INTEGER,
    skip_order INTEGER
  )`,
  `CREATE TABLE notices (
    key TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    sent_at INTEGER,
    snoozed_until INTEGER,
    skip_order INTEGER
  )`,
  `CREATE TABLE last_seen (
    captain_id TEXT NOT NULL,
    client TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (captain_id, client)
  )`,
  // Answer delivery retries: attempts made and when the next is due.
  "ALTER TABLE asks ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE asks ADD COLUMN next_delivery_at INTEGER",
  // `bb captain tell --rule`, in order; CREW.md holds the same text for people.
  `CREATE TABLE crew_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captain_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (captain_id, text)
  )`,
  // The newest crew rule each thread has received; no row means none.
  `CREATE TABLE crew_rule_marks (
    thread_id TEXT PRIMARY KEY CHECK (thread_id GLOB 'thr_*'),
    rule_id INTEGER NOT NULL
  )`,
  // A role's model ladder from Captain settings, as JSON rungs; no row means the default.
  `CREATE TABLE role_ladders (
    role TEXT PRIMARY KEY,
    rungs TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // The ladder rung a crew thread started on, and the base branch it was given.
  "ALTER TABLE crew_roles ADD COLUMN rung INTEGER",
  "ALTER TABLE crew_roles ADD COLUMN base_branch TEXT",
  // A crew thread that failed on a rate limit, and how far its restart got.
  // `to_rung` null: no rung was left, so the Captain is woken as blocked.
  `CREATE TABLE fallbacks (
    failed_thread_id TEXT PRIMARY KEY CHECK (failed_thread_id GLOB 'thr_*'),
    captain_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    role TEXT NOT NULL,
    from_rung INTEGER NOT NULL,
    from_label TEXT NOT NULL,
    to_rung INTEGER,
    to_label TEXT,
    base_branch TEXT,
    skipped TEXT NOT NULL,
    new_thread_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    woke_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  // The fixed plugin instructions a live Captain or crew session was built with,
  // and the inputs that rendered them, so a later file edit can be told to it.
  `CREATE TABLE served_instructions (
    thread_id TEXT PRIMARY KEY CHECK (thread_id GLOB 'thr_*'),
    captain_id TEXT NOT NULL,
    spec TEXT NOT NULL,
    text TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    served_at INTEGER NOT NULL
  )`,
];

/**
 * `notices` keys. Each names one condition once, so a plugin reload neither
 * repeats a once-only send nor restarts a clock.
 */
export const NOTICE = {
  /** A stall under one report-due mark: first seen by a pass, sent when the Captain was woken. */
  stall: (threadId: string, dueSince: number) => `stall:${threadId}:${dueSince}`,
  /** The first pass that saw a crew thread idle with only background commands running. */
  command: (threadId: string, dueSince: number) => `command:${threadId}:${dueSince}`,
  /** A crew thread seen in `error`, for Since you left. */
  failed: (threadId: string) => `failed:${threadId}`,
  /** The Captain's wake line for one fallback, claimed before it is sent. */
  fallbackWake: (threadId: string) => `fallback:${threadId}`,
  /** A crew failure read and judged not to need a fallback, at the thread's last update. */
  noFallback: (threadId: string, updatedAt: number) => `nofallback:${threadId}:${updatedAt}`,
  askPush: (askId: string) => `push:ask:${askId}`,
  answerPush: (askId: string) => `push:answer:${askId}`,
  undeliverablePush: (commentId: string) => `push:undeliverable:${commentId}`,
  /** Later and Skip on a banner row that has no ask: the row's own key. */
  blocked: (interactionId: string) => `blocked:${interactionId}`,
  captainHealth: (captainId: string, since: number) => `health:${captainId}:${since}`,
  reportHealth: (commentId: string) => `health:report:${commentId}`,
  answerHealth: (askId: string) => `health:answer:${askId}`,
} as const;

/** Later and Skip on a banner row. */
export type Defer = { snoozedUntil: number | null; skipOrder: number | null };

export type Repo = { bbProjectId: string; tasksProjectKey: string };

export type CaptainRow = {
  threadId: string;
  name: string;
  homeProjectId: string;
  createdAt: number;
  archivedAt: number | null;
  repos: Repo[];
};

export type CrewRole = {
  threadId: string;
  captainId: string;
  role: Role;
  reportDueSince: number | null;
  contractSent: boolean;
  /** The ladder rung it started on; null for threads brought in or started before ladders. */
  rung: number | null;
  /** The base branch dispatch gave it, so a restart starts from the same one. */
  baseBranch: string | null;
};

/** A crew row as written: rung and base branch default to none. */
export type CrewRoleInput = Omit<CrewRole, "rung" | "baseBranch"> &
  Partial<Pick<CrewRole, "rung" | "baseBranch">>;

/** A rate-limited crew thread's restart, advanced one step per pass until the Captain is woken. */
export type Fallback = {
  failedThreadId: string;
  captainId: string;
  taskId: string;
  taskKey: string;
  role: Role;
  fromRung: number;
  /** The rung as it read when the thread failed, such as `claude-code claude-fable-5-2 high`. */
  fromLabel: string;
  /** Null when no rung was left. */
  toRung: number | null;
  toLabel: string | null;
  baseBranch: string | null;
  /** Rungs passed over, each with why. */
  skipped: string[];
  newThreadId: string | null;
  archived: boolean;
  wokeAt: number | null;
  createdAt: number;
};

/** The fixed instructions a thread's session holds, as `configure` rendered them. */
export type Served = {
  threadId: string;
  captainId: string;
  /** The rendering inputs, JSON; `instructions.ts` owns the shape. */
  spec: string;
  text: string;
  fingerprint: string;
  servedAt: number;
};

/** A rule `bb captain tell --rule` added to CREW.md; ids grow in the order rules were added. */
export type CrewRule = { id: number; text: string };

export { ASK_KINDS, type AskKind };

/** An open decision waiting on the user: the one piece of work-facing state Captain owns. */
export type Ask = {
  id: string;
  captainId: string;
  taskKey: string | null;
  kind: AskKind;
  text: string;
  detail: string;
  /** Rendered as buttons; the first is recommended. */
  options: string[];
  askedAt: number;
  answer: string | null;
  answeredAt: number | null;
  answerDeliveredAt: number | null;
  /** Sends of the answer tried so far; the background check stops at `ANSWER_MAX_ATTEMPTS`. */
  deliveryAttempts: number;
  nextDeliveryAt: number | null;
} & Defer;

type AskRecord = {
  id: string;
  captain_id: string;
  task_key: string | null;
  kind: AskKind;
  text: string;
  detail: string;
  options: string | null;
  asked_at: number;
  answer: string | null;
  answered_at: number | null;
  answer_delivered_at: number | null;
  delivery_attempts: number;
  next_delivery_at: number | null;
  snoozed_until: number | null;
  skip_order: number | null;
};

type CaptainRecord = {
  thread_id: string;
  name: string;
  home_project_id: string;
  created_at: number;
  archived_at: number | null;
};
type RepoRecord = { captain_id: string; bb_project_id: string; tasks_project_key: string };
type CrewRoleRecord = {
  thread_id: string;
  captain_id: string;
  role: string;
  report_due_since: number | null;
  contract_sent: number;
  rung: number | null;
  base_branch: string | null;
};
type FallbackRecord = {
  failed_thread_id: string;
  captain_id: string;
  task_id: string;
  task_key: string;
  role: string;
  from_rung: number;
  from_label: string;
  to_rung: number | null;
  to_label: string | null;
  base_branch: string | null;
  skipped: string;
  new_thread_id: string | null;
  archived: number;
  woke_at: number | null;
  created_at: number;
};

export type Store = ReturnType<typeof openStore>;

export function openStore(bb: Pick<BbPluginApi, "storage">) {
  const db: Database = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);

  const reposOf = db.prepare<[string], RepoRecord>(
    "SELECT * FROM captain_repos WHERE captain_id = ? ORDER BY rowid",
  );
  const toCaptain = (row: CaptainRecord): CaptainRow => ({
    threadId: row.thread_id,
    name: row.name,
    homeProjectId: row.home_project_id,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    repos: reposOf.all(row.thread_id).map((repo) => ({
      bbProjectId: repo.bb_project_id,
      tasksProjectKey: repo.tasks_project_key,
    })),
  });
  const selectCaptain = db.prepare<[string], CaptainRecord>(
    "SELECT * FROM captains WHERE thread_id = ?",
  );
  const selectCrewRole = db.prepare<[string], CrewRoleRecord>(
    "SELECT * FROM crew_roles WHERE thread_id = ?",
  );
  const toCrewRole = (row: CrewRoleRecord): CrewRole | null => {
    const role = parseRole(row.role);
    if (role === null) return null;
    return {
      threadId: row.thread_id,
      captainId: row.captain_id,
      role,
      reportDueSince: row.report_due_since,
      contractSent: row.contract_sent === 1,
      rung: row.rung,
      baseBranch: row.base_branch,
    };
  };
  const toFallback = (row: FallbackRecord): Fallback | null => {
    const role = parseRole(row.role);
    if (role === null) return null;
    return {
      failedThreadId: row.failed_thread_id,
      captainId: row.captain_id,
      taskId: row.task_id,
      taskKey: row.task_key,
      role,
      fromRung: row.from_rung,
      fromLabel: row.from_label,
      toRung: row.to_rung,
      toLabel: row.to_label,
      baseBranch: row.base_branch,
      skipped: JSON.parse(row.skipped) as string[],
      newThreadId: row.new_thread_id,
      archived: row.archived === 1,
      wokeAt: row.woke_at,
      createdAt: row.created_at,
    };
  };
  const selectAsk = db.prepare<[string], AskRecord>("SELECT * FROM asks WHERE id = ?");
  const toAsk = (row: AskRecord): Ask => ({
    id: row.id,
    captainId: row.captain_id,
    taskKey: row.task_key,
    kind: row.kind,
    text: row.text,
    detail: row.detail,
    options: row.options === null ? [] : (JSON.parse(row.options) as string[]),
    askedAt: row.asked_at,
    answer: row.answer,
    answeredAt: row.answered_at,
    answerDeliveredAt: row.answer_delivered_at,
    deliveryAttempts: row.delivery_attempts,
    nextDeliveryAt: row.next_delivery_at,
    snoozedUntil: row.snoozed_until,
    skipOrder: row.skip_order,
  });

  return {
    /** Every Captain not archived, oldest first. */
    liveCaptains(): CaptainRow[] {
      return db
        .prepare<[], CaptainRecord>(
          "SELECT * FROM captains WHERE archived_at IS NULL ORDER BY created_at, thread_id",
        )
        .all()
        .map(toCaptain);
    },
    captain(threadId: string): CaptainRow | null {
      const row = selectCaptain.get(threadId);
      return row === undefined ? null : toCaptain(row);
    },
    /** Insert a Captain and its repos, or converge an existing row to them. */
    putCaptain(captain: Omit<CaptainRow, "archivedAt">): void {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO captains (thread_id, name, home_project_id, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (thread_id) DO UPDATE SET name = excluded.name,
             home_project_id = excluded.home_project_id`,
        ).run(captain.threadId, captain.name, captain.homeProjectId, captain.createdAt);
        for (const repo of captain.repos) putRepo(captain.threadId, repo);
      })();
    },
    archiveCaptain(threadId: string, at: number): void {
      db.prepare(
        "UPDATE captains SET archived_at = ? WHERE thread_id = ? AND archived_at IS NULL",
      ).run(at, threadId);
    },
    putRepo(captainId: string, repo: Repo): void {
      putRepo(captainId, repo);
    },
    removeRepo(captainId: string, bbProjectId: string): void {
      db.prepare("DELETE FROM captain_repos WHERE captain_id = ? AND bb_project_id = ?").run(
        captainId,
        bbProjectId,
      );
    },
    /** A synchronous read: `configure` calls it while bb builds a session. */
    crewRole(threadId: string): CrewRole | null {
      const row = selectCrewRole.get(threadId);
      return row === undefined ? null : toCrewRole(row);
    },
    /** Every crew row this Captain ever recorded, archived crew included. */
    crewRolesOf(captainId: string): CrewRole[] {
      return db
        .prepare<[string], CrewRoleRecord>(
          "SELECT * FROM crew_roles WHERE captain_id = ? ORDER BY rowid",
        )
        .all(captainId)
        .flatMap((row) => toCrewRole(row) ?? []);
    },
    /** Write a row only when the thread has none, as a backfill does. */
    ensureCrewRole(crew: CrewRoleInput): void {
      db.prepare(
        `INSERT INTO crew_roles
           (thread_id, captain_id, role, report_due_since, contract_sent, rung, base_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id) DO NOTHING`,
      ).run(
        crew.threadId,
        crew.captainId,
        crew.role,
        crew.reportDueSince,
        crew.contractSent ? 1 : 0,
        crew.rung ?? null,
        crew.baseBranch ?? null,
      );
    },
    /** Move the report-due mark forward; a notifying comment is compared with it, never clears it. */
    setReportDue(threadId: string, at: number): void {
      db.prepare("UPDATE crew_roles SET report_due_since = ? WHERE thread_id = ?").run(
        at,
        threadId,
      );
    },
    setContractSent(threadId: string): void {
      db.prepare("UPDATE crew_roles SET contract_sent = 1 WHERE thread_id = ?").run(threadId);
    },
    putCrewRole(crew: CrewRoleInput): void {
      db.prepare(
        `INSERT INTO crew_roles
           (thread_id, captain_id, role, report_due_since, contract_sent, rung, base_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET captain_id = excluded.captain_id,
           role = excluded.role, report_due_since = excluded.report_due_since,
           contract_sent = excluded.contract_sent, rung = excluded.rung,
           base_branch = excluded.base_branch`,
      ).run(
        crew.threadId,
        crew.captainId,
        crew.role,
        crew.reportDueSince,
        crew.contractSent ? 1 : 0,
        crew.rung ?? null,
        crew.baseBranch ?? null,
      );
    },
    /** Record a crew rule once: a rerun with the same text returns the first. */
    addRule(captainId: string, text: string, at: number): CrewRule {
      db.prepare(
        `INSERT INTO crew_rules (captain_id, text, created_at) VALUES (?, ?, ?)
         ON CONFLICT (captain_id, text) DO NOTHING`,
      ).run(captainId, text, at);
      return db
        .prepare<[string, string], CrewRule>(
          "SELECT id, text FROM crew_rules WHERE captain_id = ? AND text = ?",
        )
        .get(captainId, text) as CrewRule;
    },
    /** The newest rule's id, or 0 before the first. */
    latestRuleId(captainId: string): number {
      return (
        db
          .prepare<[string], { id: number | null }>(
            "SELECT MAX(id) AS id FROM crew_rules WHERE captain_id = ?",
          )
          .get(captainId)?.id ?? 0
      );
    },
    /** The Captain's rules this thread has not received, oldest first. */
    unseenRules(captainId: string, threadId: string): CrewRule[] {
      return db
        .prepare<[string, string], CrewRule>(
          `SELECT id, text FROM crew_rules WHERE captain_id = ? AND id > COALESCE(
             (SELECT rule_id FROM crew_rule_marks WHERE thread_id = ?), 0) ORDER BY id`,
        )
        .all(captainId, threadId);
    },
    /** Whether the thread has received this rule. */
    ruleSeen(threadId: string, ruleId: number): boolean {
      const row = db
        .prepare<[string], { rule_id: number }>(
          "SELECT rule_id FROM crew_rule_marks WHERE thread_id = ?",
        )
        .get(threadId);
      return row !== undefined && row.rule_id >= ruleId;
    },
    /** Move the thread's mark up to `ruleId`; never back, so a late write loses nothing. */
    markRulesSeen(threadId: string, ruleId: number): void {
      if (ruleId <= 0) return;
      db.prepare(
        `INSERT INTO crew_rule_marks (thread_id, rule_id) VALUES (?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET rule_id = MAX(crew_rule_marks.rule_id, excluded.rule_id)`,
      ).run(threadId, ruleId);
    },
    ask(id: string): Ask | null {
      const row = selectAsk.get(id.trim().toLowerCase());
      return row === undefined ? null : toAsk(row);
    },
    /** This Captain's asks, oldest first; with `open`, only the unanswered ones. */
    asksOf(captainId: string, filter: { open?: boolean } = {}): Ask[] {
      const where = filter.open === true ? " AND answer IS NULL" : "";
      return db
        .prepare<[string], AskRecord>(
          `SELECT * FROM asks WHERE captain_id = ?${where} ORDER BY asked_at, rowid`,
        )
        .all(captainId)
        .map(toAsk);
    },
    /** The open ask with this kind, task and text, so a rerun of `ask` finds the first. */
    findOpenAsk(
      captainId: string,
      kind: AskKind,
      taskKey: string | null,
      text: string,
    ): Ask | null {
      const row = db
        .prepare<[string, AskKind, string | null, string], AskRecord>(
          `SELECT * FROM asks WHERE captain_id = ? AND kind = ? AND task_key IS ? AND text = ?
             AND answer IS NULL ORDER BY rowid LIMIT 1`,
        )
        .get(captainId, kind, taskKey, text);
      return row === undefined ? null : toAsk(row);
    },
    /** Insert an ask under the next short id, `a1`, `a2`, …. */
    openAsk(
      ask: Omit<
        Ask,
        | "id"
        | "answer"
        | "answeredAt"
        | "answerDeliveredAt"
        | "deliveryAttempts"
        | "nextDeliveryAt"
        | keyof Defer
      >,
    ): Ask {
      return db.transaction(() => {
        const { last } = db
          .prepare<[], { last: number | null }>(
            "SELECT MAX(CAST(substr(id, 2) AS INTEGER)) AS last FROM asks",
          )
          .get() ?? { last: null };
        const id = `a${(last ?? 0) + 1}`;
        db.prepare(
          `INSERT INTO asks (id, captain_id, task_key, kind, text, detail, options, asked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          ask.captainId,
          ask.taskKey,
          ask.kind,
          ask.text,
          ask.detail,
          ask.options.length === 0 ? null : JSON.stringify(ask.options),
          ask.askedAt,
        );
        return toAsk(selectAsk.get(id) as AskRecord);
      })();
    },
    /** Record an answer once; a second answer leaves the first. */
    answerAsk(id: string, answer: string, at: number): void {
      db.prepare("UPDATE asks SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL").run(
        answer,
        at,
        id,
      );
    },
    markAnswerDelivered(id: string, at: number): void {
      db.prepare(
        "UPDATE asks SET answer_delivered_at = ? WHERE id = ? AND answer_delivered_at IS NULL",
      ).run(at, id);
    },
    /**
     * Claim the next send of an undelivered answer: true for the one caller
     * whose count still matched, so `ask resolve` and the background check
     * never send the same attempt twice.
     */
    claimAnswerAttempt(id: string, attempts: number, nextAt: number): boolean {
      return (
        db
          .prepare(
            `UPDATE asks SET delivery_attempts = delivery_attempts + 1, next_delivery_at = ?
             WHERE id = ? AND delivery_attempts = ? AND answer IS NOT NULL
               AND answer_delivered_at IS NULL`,
          )
          .run(nextAt, id, attempts).changes === 1
      );
    },
    /** Answered, undelivered asks of live Captains: every one, or only those under `maxAttempts`. */
    undeliveredAnswers(maxAttempts?: number): Ask[] {
      return db
        .prepare<[number], AskRecord>(
          `SELECT asks.* FROM asks JOIN captains ON captains.thread_id = asks.captain_id
           WHERE captains.archived_at IS NULL AND asks.answer IS NOT NULL
             AND asks.answer_delivered_at IS NULL AND asks.delivery_attempts < ?
           ORDER BY asks.answered_at, asks.rowid`,
        )
        .all(maxAttempts ?? Number.MAX_SAFE_INTEGER)
        .map(toAsk);
    },

    /** When a once-only notice was sent, or null when it never was. */
    noticeSentAt(key: string): number | null {
      const row = db
        .prepare<[string], { sent_at: number | null }>("SELECT sent_at FROM notices WHERE key = ?")
        .get(key);
      return row?.sent_at ?? null;
    },
    markNoticeSent(key: string, at: number): void {
      db.prepare(
        `INSERT INTO notices (key, first_seen, sent_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET sent_at = excluded.sent_at`,
      ).run(key, at, at);
    },
    /** When a notice's condition was first seen: recorded once, then only read. */
    noticeFirstSeen(key: string, at: number): number {
      db.prepare(
        "INSERT INTO notices (key, first_seen) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
      ).run(key, at);
      return (
        db
          .prepare<[string], { first_seen: number }>("SELECT first_seen FROM notices WHERE key = ?")
          .get(key)?.first_seen ?? at
      );
    },
    /** A notice's first-seen time without recording one. */
    noticeSeenAt(key: string): number | null {
      return (
        db
          .prepare<[string], { first_seen: number }>("SELECT first_seen FROM notices WHERE key = ?")
          .get(key)?.first_seen ?? null
      );
    },
    /**
     * Claim a once-only notice before sending it: true for the one caller that
     * set `sent_at`. A send that fails gives the claim back with `releaseNotice`.
     */
    claimNotice(key: string, at: number): boolean {
      return (
        db
          .prepare(
            `INSERT INTO notices (key, first_seen, sent_at) VALUES (?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET sent_at = excluded.sent_at
             WHERE notices.sent_at IS NULL`,
          )
          .run(key, at, at).changes === 1
      );
    },
    releaseNotice(key: string, claimedAt: number): void {
      db.prepare("UPDATE notices SET sent_at = NULL WHERE key = ? AND sent_at = ?").run(
        key,
        claimedAt,
      );
    },
    /** Later or Skip on an ask. */
    deferAsk(id: string, defer: Partial<Defer>): void {
      db.prepare(
        `UPDATE asks SET snoozed_until = COALESCE(?, snoozed_until),
           skip_order = COALESCE(?, skip_order) WHERE id = ?`,
      ).run(defer.snoozedUntil ?? null, defer.skipOrder ?? null, id);
    },
    /** Later or Skip on a banner row with no ask, kept in `notices` under the row's key. */
    deferNotice(key: string, at: number, defer: Partial<Defer>): void {
      db.prepare(
        `INSERT INTO notices (key, first_seen, snoozed_until, skip_order) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           snoozed_until = COALESCE(excluded.snoozed_until, notices.snoozed_until),
           skip_order = COALESCE(excluded.skip_order, notices.skip_order)`,
      ).run(key, at, defer.snoozedUntil ?? null, defer.skipOrder ?? null);
    },
    noticeDefer(key: string): Defer {
      const row = db
        .prepare<[string], { snoozed_until: number | null; skip_order: number | null }>(
          "SELECT snoozed_until, skip_order FROM notices WHERE key = ?",
        )
        .get(key);
      return { snoozedUntil: row?.snoozed_until ?? null, skipOrder: row?.skip_order ?? null };
    },
    /** Record that a client last had this Captain open at `at`. */
    setLastSeen(captainId: string, client: string, at: number): void {
      db.prepare(
        `INSERT INTO last_seen (captain_id, client, at) VALUES (?, ?, ?)
         ON CONFLICT (captain_id, client) DO UPDATE SET at = MAX(last_seen.at, excluded.at)`,
      ).run(captainId, client, at);
    },
    /** The newest time any client last had this Captain open, or null before the first. */
    lastSeen(captainId: string): number | null {
      return (
        db
          .prepare<[string], { at: number | null }>(
            "SELECT MAX(at) AS at FROM last_seen WHERE captain_id = ?",
          )
          .get(captainId)?.at ?? null
      );
    },
    /** Forget an unsent notice, so its clock starts again the next time its condition is seen. */
    clearUnsentNotice(key: string): void {
      db.prepare("DELETE FROM notices WHERE key = ? AND sent_at IS NULL").run(key);
    },
    /** A role's saved ladder as stored JSON, or null for the default. */
    ladderJson(role: string): string | null {
      return (
        db
          .prepare<[string], { rungs: string }>("SELECT rungs FROM role_ladders WHERE role = ?")
          .get(role)?.rungs ?? null
      );
    },
    /** Save a role's ladder; null goes back to the default. */
    setLadderJson(role: string, rungs: string | null, at: number): void {
      if (rungs === null) {
        db.prepare("DELETE FROM role_ladders WHERE role = ?").run(role);
        return;
      }
      db.prepare(
        `INSERT INTO role_ladders (role, rungs, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (role) DO UPDATE SET rungs = excluded.rungs, updated_at = excluded.updated_at`,
      ).run(role, rungs, at);
    },
    /** Record a thread's first served instructions; a later call keeps the first. */
    recordServed(served: Served): void {
      db.prepare(
        `INSERT INTO served_instructions
           (thread_id, captain_id, spec, text, fingerprint, served_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id) DO NOTHING`,
      ).run(
        served.threadId,
        served.captainId,
        served.spec,
        served.text,
        served.fingerprint,
        served.servedAt,
      );
    },
    /** The served instructions of these threads; threads with none are left out. */
    servedOf(threadIds: readonly string[]): Served[] {
      if (threadIds.length === 0) return [];
      return db
        .prepare<
          string[],
          {
            thread_id: string;
            captain_id: string;
            spec: string;
            text: string;
            fingerprint: string;
            served_at: number;
          }
        >(
          `SELECT * FROM served_instructions WHERE thread_id IN (${threadIds.map(() => "?").join(", ")})`,
        )
        .all(...threadIds)
        .map((row) => ({
          threadId: row.thread_id,
          captainId: row.captain_id,
          spec: row.spec,
          text: row.text,
          fingerprint: row.fingerprint,
          servedAt: row.served_at,
        }));
    },
    /**
     * Move a thread's served text from `fromFingerprint` to `to`: true for the
     * one caller whose fingerprint still matched, so two passes never send the
     * same change twice. A failed send swaps back.
     */
    swapServed(
      threadId: string,
      fromFingerprint: string,
      to: Pick<Served, "text" | "fingerprint" | "servedAt">,
    ): boolean {
      return (
        db
          .prepare(
            `UPDATE served_instructions SET text = ?, fingerprint = ?, served_at = ?
             WHERE thread_id = ? AND fingerprint = ?`,
          )
          .run(to.text, to.fingerprint, to.servedAt, threadId, fromFingerprint).changes === 1
      );
    },
    fallback(failedThreadId: string): Fallback | null {
      const row = db
        .prepare<[string], FallbackRecord>("SELECT * FROM fallbacks WHERE failed_thread_id = ?")
        .get(failedThreadId);
      return row === undefined ? null : toFallback(row);
    },
    /** Record a fallback once; false when the failed thread already has one. */
    openFallback(fallback: Omit<Fallback, "newThreadId" | "archived" | "wokeAt">): boolean {
      const result = db
        .prepare(
          `INSERT INTO fallbacks (failed_thread_id, captain_id, task_id, task_key, role,
             from_rung, from_label, to_rung, to_label, base_branch, skipped, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (failed_thread_id) DO NOTHING`,
        )
        .run(
          fallback.failedThreadId,
          fallback.captainId,
          fallback.taskId,
          fallback.taskKey,
          fallback.role,
          fallback.fromRung,
          fallback.fromLabel,
          fallback.toRung,
          fallback.toLabel,
          fallback.baseBranch,
          JSON.stringify(fallback.skipped),
          fallback.createdAt,
        );
      return result.changes > 0;
    },
    /** A Captain's fallbacks whose wake has not been sent, oldest first. */
    openFallbacks(captainId: string): Fallback[] {
      return db
        .prepare<[string], FallbackRecord>(
          `SELECT * FROM fallbacks WHERE captain_id = ? AND woke_at IS NULL
           ORDER BY created_at, failed_thread_id`,
        )
        .all(captainId)
        .flatMap((row) => toFallback(row) ?? []);
    },
    setFallbackThread(failedThreadId: string, newThreadId: string): void {
      db.prepare("UPDATE fallbacks SET new_thread_id = ? WHERE failed_thread_id = ?").run(
        newThreadId,
        failedThreadId,
      );
    },
    setFallbackArchived(failedThreadId: string): void {
      db.prepare("UPDATE fallbacks SET archived = 1 WHERE failed_thread_id = ?").run(
        failedThreadId,
      );
    },
    setFallbackWoke(failedThreadId: string, at: number): void {
      db.prepare("UPDATE fallbacks SET woke_at = ? WHERE failed_thread_id = ?").run(
        at,
        failedThreadId,
      );
    },
  };

  function putRepo(captainId: string, repo: Repo): void {
    db.prepare(
      `INSERT INTO captain_repos (captain_id, bb_project_id, tasks_project_key) VALUES (?, ?, ?)
       ON CONFLICT (captain_id, bb_project_id) DO UPDATE SET tasks_project_key = excluded.tasks_project_key`,
    ).run(captainId, repo.bbProjectId, repo.tasksProjectKey);
  }
}
