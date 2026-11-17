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
    ensureCrewRole(crew: CrewRole): void {
      db.prepare(
        `INSERT INTO crew_roles (thread_id, captain_id, role, report_due_since, contract_sent)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (thread_id) DO NOTHING`,
      ).run(
        crew.threadId,
        crew.captainId,
        crew.role,
        crew.reportDueSince,
        crew.contractSent ? 1 : 0,
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
    putCrewRole(crew: CrewRole): void {
      db.prepare(
        `INSERT INTO crew_roles (thread_id, captain_id, role, report_due_since, contract_sent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET captain_id = excluded.captain_id,
           role = excluded.role, report_due_since = excluded.report_due_since,
           contract_sent = excluded.contract_sent`,
      ).run(
        crew.threadId,
        crew.captainId,
        crew.role,
        crew.reportDueSince,
        crew.contractSent ? 1 : 0,
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
  };

  function putRepo(captainId: string, repo: Repo): void {
    db.prepare(
      `INSERT INTO captain_repos (captain_id, bb_project_id, tasks_project_key) VALUES (?, ?, ?)
       ON CONFLICT (captain_id, bb_project_id) DO UPDATE SET tasks_project_key = excluded.tasks_project_key`,
    ).run(captainId, repo.bbProjectId, repo.tasksProjectKey);
  }
}
