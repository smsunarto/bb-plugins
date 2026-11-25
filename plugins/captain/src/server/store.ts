import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { captainIconSchema, type CaptainIcon, type IconChoice } from "../contract/icon.ts";
import { ASK_KINDS, type AskKind } from "../contract/queue.ts";
import {
  ROUTINE_RUNS_KEPT,
  ROUTINES_PER_CAPTAIN,
  type Routine,
  type RoutineFields,
  type RoutineRun,
  type Schedule,
} from "../contract/routines.ts";
import { Refusal, type Blocker } from "./output.ts";
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
  // A Captain's sidebar icon, set by `bb captain icon` or Captain settings: a
  // bb icon name, or an image as a data URL. No row means the default glyph.
  `CREATE TABLE captain_icons (
    thread_id TEXT PRIMARY KEY CHECK (thread_id GLOB 'thr_*'),
    kind TEXT NOT NULL CHECK (kind IN ('icon', 'image')),
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // A scheduled message to one Captain; bb Automations holds the schedule's
  // state. `seq` never reuses a number, so a deleted routine's id is not given
  // to a new one. `fired_at` is the newest scheduled fire of any outcome, and
  // `delivered_at` the newest scheduled one that reached the Captain: both
  // outlive the trimmed run history.
  `CREATE TABLE routines (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    captain_id TEXT NOT NULL,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    schedule TEXT NOT NULL,
    automation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    fired_at INTEGER,
    delivered_at INTEGER,
    UNIQUE (captain_id, name COLLATE NOCASE)
  )`,
  // Each delivery of a routine; trimmed to ROUTINE_RUNS_KEPT per routine.
  `CREATE TABLE routine_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'test')),
    status TEXT NOT NULL CHECK (status IN ('sent', 'queued', 'skipped', 'failed')),
    reason TEXT,
    at INTEGER NOT NULL
  )`,
  "CREATE INDEX routine_runs_by_routine ON routine_runs (routine_id, id)",
  // Automations runs Captain started as tests, until their fire arrives.
  `CREATE TABLE routine_tests (
    run_id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  // Automations work that failed and is retried each maintenance pass: an
  // automation to delete, or a routine whose automation must be made again.
  `CREATE TABLE routine_cleanup (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('delete', 'repair')),
    project_id TEXT,
    automation_id TEXT,
    routine_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL
  )`,
  // Who answered an ask: `user` (the banner or the user's terminal) or
  // `captain` (its Captain thread, or the plugin superseding a ship ask). Rows
  // answered before this column stay null and prove no answer's source.
  "ALTER TABLE asks ADD COLUMN answered_by TEXT CHECK (answered_by IN ('user', 'captain'))",
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
  /** A Captain's title checked once for the retired " Captain" suffix. */
  titleSuffix: (threadId: string) => `title-suffix:${threadId}`,
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
  /** Who recorded the answer; null when unanswered or answered before this was kept. */
  answeredBy: Answerer | null;
  answerDeliveredAt: number | null;
  /** Sends of the answer tried so far; the background check stops at `ANSWER_MAX_ATTEMPTS`. */
  deliveryAttempts: number;
  nextDeliveryAt: number | null;
} & Defer;

/** Who answered an ask: the user, through the banner or a terminal, or its Captain. */
export type Answerer = "user" | "captain";

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
  answered_by: Answerer | null;
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

type RoutineRecord = {
  seq: number;
  id: string;
  captain_id: string;
  name: string;
  instruction: string;
  schedule: string;
  automation_id: string | null;
  created_at: number;
  updated_at: number;
  fired_at: number | null;
  delivered_at: number | null;
};
type CleanupRecord = {
  key: string;
  kind: "delete" | "repair";
  project_id: string | null;
  automation_id: string | null;
  routine_id: string | null;
  last_error: string | null;
  created_at: number;
};

/** Automations work retried each maintenance pass. */
export type Cleanup =
  | {
      key: string;
      kind: "delete";
      projectId: string;
      automationId: string;
      /** The routine Captain made it for: a retry deletes it only while it still runs Captain's script for this id. */
      routineId: string | null;
      lastError: string | null;
    }
  | { key: string; kind: "repair"; routineId: string; lastError: string | null };
type RoutineRunRecord = {
  id: number;
  routine_id: string;
  trigger: RoutineRun["trigger"];
  status: RoutineRun["status"];
  reason: string | null;
  at: number;
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
  const selectIcon = db.prepare<[string], { kind: "icon" | "image"; value: string }>(
    "SELECT kind, value FROM captain_icons WHERE thread_id = ?",
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
  const selectRoutine = db.prepare<[string], RoutineRecord>("SELECT * FROM routines WHERE id = ?");
  const toRoutine = (row: RoutineRecord): Routine => ({
    id: row.id,
    captainId: row.captain_id,
    name: row.name,
    instruction: row.instruction,
    schedule: JSON.parse(row.schedule) as Schedule,
    automationId: row.automation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firedAt: row.fired_at,
    deliveredAt: row.delivered_at,
  });
  const toCleanup = (row: CleanupRecord): Cleanup =>
    row.kind === "delete"
      ? {
          key: row.key,
          kind: "delete",
          projectId: row.project_id ?? "",
          automationId: row.automation_id ?? "",
          routineId: row.routine_id,
          lastError: row.last_error,
        }
      : {
          key: row.key,
          kind: "repair",
          routineId: row.routine_id ?? "",
          lastError: row.last_error,
        };
  const toRoutineRun = (row: RoutineRunRecord): RoutineRun => ({
    id: row.id,
    routineId: row.routine_id,
    trigger: row.trigger,
    status: row.status,
    reason: row.reason,
    at: row.at,
  });
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
    answeredBy: row.answered_by,
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
    /** Archive a Captain; its icon goes with it, since only live Captains draw one. */
    archiveCaptain(threadId: string, at: number): void {
      db.transaction(() => {
        db.prepare(
          "UPDATE captains SET archived_at = ? WHERE thread_id = ? AND archived_at IS NULL",
        ).run(at, threadId);
        db.prepare("DELETE FROM captain_icons WHERE thread_id = ?").run(threadId);
      })();
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
    /** Whether the thread has a crew row, even one whose role no longer parses (a retired role). */
    hasCrewRow(threadId: string): boolean {
      return selectCrewRole.get(threadId) !== undefined;
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
    /** Every Captain's open asks on one task, oldest first. */
    openAsksOnTask(taskKey: string): Ask[] {
      return db
        .prepare<[string], AskRecord>(
          "SELECT * FROM asks WHERE task_key = ? AND answer IS NULL ORDER BY asked_at, rowid",
        )
        .all(taskKey)
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
        | "answeredBy"
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
    /** Record an answer and who gave it once; a second answer leaves the first. */
    answerAsk(id: string, answer: string, by: Answerer, at: number): void {
      db.prepare(
        "UPDATE asks SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND answer IS NULL",
      ).run(answer, by, at, id);
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

    routine(id: string): Routine | null {
      const row = selectRoutine.get(id.trim().toLowerCase());
      return row === undefined ? null : toRoutine(row);
    },
    /** A Captain's routine by id or by name, case-insensitive. */
    findRoutine(captainId: string, address: string): Routine | null {
      const wanted = address.trim();
      const row =
        db
          .prepare<[string, string], RoutineRecord>(
            "SELECT * FROM routines WHERE captain_id = ? AND id = ?",
          )
          .get(captainId, wanted.toLowerCase()) ??
        db
          .prepare<[string, string], RoutineRecord>(
            "SELECT * FROM routines WHERE captain_id = ? AND name = ? COLLATE NOCASE",
          )
          .get(captainId, wanted);
      return row === undefined ? null : toRoutine(row);
    },
    /** A Captain's routines in the order they were made. */
    routinesOf(captainId: string): Routine[] {
      return db
        .prepare<[string], RoutineRecord>(
          "SELECT * FROM routines WHERE captain_id = ? ORDER BY seq",
        )
        .all(captainId)
        .map(toRoutine);
    },
    allRoutines(): Routine[] {
      return db
        .prepare<[], RoutineRecord>("SELECT * FROM routines ORDER BY seq")
        .all()
        .map(toRoutine);
    },
    /**
     * Insert a routine under the next id, `r1`, `r2`, …, with no automation
     * yet. Refuses past `ROUTINES_PER_CAPTAIN` or on a name the Captain uses.
     */
    createRoutine(fields: RoutineFields & { captainId: string; at: number }): Routine {
      return db.transaction(() => {
        const blockers: Blocker[] = [];
        const { count } = db
          .prepare<[string], { count: number }>(
            "SELECT COUNT(*) AS count FROM routines WHERE captain_id = ?",
          )
          .get(fields.captainId) ?? { count: 0 };
        if (count >= ROUTINES_PER_CAPTAIN) {
          blockers.push({
            reason: `a Captain has at most ${ROUTINES_PER_CAPTAIN} routines`,
            fix: "bb captain routine remove <id> first",
          });
        }
        nameBlocker(fields.captainId, fields.name, null, blockers);
        if (blockers.length > 0) throw new Refusal(blockers);
        const { seq } = db
          .prepare<[], { seq: number | null }>(
            "SELECT seq FROM sqlite_sequence WHERE name = 'routines'",
          )
          .get() ?? { seq: null };
        const next = (seq ?? 0) + 1;
        const id = `r${next}`;
        db.prepare(
          `INSERT INTO routines
             (seq, id, captain_id, name, instruction, schedule, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          next,
          id,
          fields.captainId,
          fields.name,
          fields.instruction,
          JSON.stringify(fields.schedule),
          fields.at,
          fields.at,
        );
        return toRoutine(selectRoutine.get(id) as RoutineRecord);
      })();
    },
    /** Change a routine's fields or automation; refuses a name another routine uses. */
    updateRoutine(
      id: string,
      patch: Partial<RoutineFields> & { automationId?: string | null },
      at: number,
    ): Routine {
      return db.transaction(() => {
        const row = selectRoutine.get(id);
        if (row === undefined)
          throw new Refusal([{ reason: `no routine ${id}`, fix: "bb captain routine list" }]);
        const current = toRoutine(row);
        if (patch.name !== undefined) {
          const blockers: Blocker[] = [];
          nameBlocker(current.captainId, patch.name, id, blockers);
          if (blockers.length > 0) throw new Refusal(blockers);
        }
        const next = { ...current, ...patch };
        db.prepare(
          `UPDATE routines SET name = ?, instruction = ?, schedule = ?, automation_id = ?,
             updated_at = ? WHERE id = ?`,
        ).run(
          next.name,
          next.instruction,
          JSON.stringify(next.schedule),
          next.automationId,
          at,
          id,
        );
        return toRoutine(selectRoutine.get(id) as RoutineRecord);
      })();
    },
    /** Delete a routine and its runs. */
    deleteRoutine(id: string): void {
      db.transaction(() => {
        db.prepare("DELETE FROM routine_runs WHERE routine_id = ?").run(id);
        db.prepare("DELETE FROM routine_tests WHERE routine_id = ?").run(id);
        db.prepare("DELETE FROM routine_cleanup WHERE kind = 'repair' AND routine_id = ?").run(id);
        db.prepare("DELETE FROM routines WHERE id = ?").run(id);
      })();
    },
    /** Record one delivery, keeping the newest `ROUTINE_RUNS_KEPT` per routine. */
    recordRoutineRun(run: Omit<RoutineRun, "id">): RoutineRun {
      return db.transaction(() => {
        const { lastInsertRowid } = db
          .prepare(
            "INSERT INTO routine_runs (routine_id, trigger, status, reason, at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(run.routineId, run.trigger, run.status, run.reason, run.at);
        if (run.trigger === "schedule") {
          const delivered = run.status === "sent" || run.status === "queued";
          db.prepare(
            `UPDATE routines SET fired_at = MAX(COALESCE(fired_at, 0), ?),
               delivered_at = CASE WHEN ? THEN MAX(COALESCE(delivered_at, 0), ?) ELSE delivered_at END
             WHERE id = ?`,
          ).run(run.at, delivered ? 1 : 0, run.at, run.routineId);
        }
        db.prepare(
          `DELETE FROM routine_runs WHERE routine_id = ? AND id NOT IN (
             SELECT id FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?)`,
        ).run(run.routineId, run.routineId, ROUTINE_RUNS_KEPT);
        return { ...run, id: Number(lastInsertRowid) };
      })();
    },
    /** A routine's runs, newest first. */
    routineRuns(routineId: string, limit: number = ROUTINE_RUNS_KEPT): RoutineRun[] {
      return db
        .prepare<[string, number], RoutineRunRecord>(
          "SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?",
        )
        .all(routineId, limit)
        .map(toRoutineRun);
    },

    /** A test run Captain started, so its fire is told apart from a scheduled one. */
    addTestRun(runId: string, routineId: string, at: number): void {
      db.prepare(
        "INSERT INTO routine_tests (run_id, routine_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      ).run(runId, routineId, at);
    },
    /** Claim a test run once; also drops claims older than `staleBefore`. */
    takeTestRun(runId: string, staleBefore: number): boolean {
      return db.transaction(() => {
        const taken = db.prepare("DELETE FROM routine_tests WHERE run_id = ?").run(runId).changes;
        db.prepare("DELETE FROM routine_tests WHERE at < ?").run(staleBefore);
        return taken === 1;
      })();
    },

    /** Queue Automations work to retry; a second add of the same key keeps one row. */
    addCleanup(
      cleanup:
        | { kind: "delete"; projectId: string; automationId: string; routineId: string }
        | { kind: "repair"; routineId: string },
      error: string,
      at: number,
    ): string {
      const key =
        cleanup.kind === "delete"
          ? `delete:${cleanup.automationId}`
          : `repair:${cleanup.routineId}`;
      db.prepare(
        `INSERT INTO routine_cleanup (key, kind, project_id, automation_id, routine_id, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET last_error = excluded.last_error`,
      ).run(
        key,
        cleanup.kind,
        cleanup.kind === "delete" ? cleanup.projectId : null,
        cleanup.kind === "delete" ? cleanup.automationId : null,
        cleanup.routineId,
        error,
        at,
      );
      return key;
    },
    /**
     * Retire a routine: record the intent to delete its automation and delete
     * the routine in one transaction, so an interruption leaves either both
     * or neither. Returns the cleanup key, or null with no automation.
     */
    retireRoutine(
      routineId: string,
      deletion: { projectId: string; automationId: string } | null,
      at: number,
    ): string | null {
      return db.transaction(() => {
        const key =
          deletion === null
            ? null
            : this.addCleanup({ kind: "delete", ...deletion, routineId }, "pending", at);
        this.deleteRoutine(routineId);
        return key;
      })();
    },
    /** Whether a delete of this routine's automation is pending: no repair may remake it. */
    /** Whether a delete of this routine's automation is still queued; repair must not undo it. */
    deletePending(routineId: string, automationId: string): boolean {
      return (
        db
          .prepare<[string, string], { n: number }>(
            "SELECT COUNT(*) AS n FROM routine_cleanup WHERE kind = 'delete' AND routine_id = ? AND automation_id = ?",
          )
          .get(routineId, automationId)?.n !== 0
      );
    },
    cleanups(): Cleanup[] {
      return db
        .prepare<[], CleanupRecord>("SELECT * FROM routine_cleanup ORDER BY created_at, key")
        .all()
        .map(toCleanup);
    },
    removeCleanup(key: string): void {
      db.prepare("DELETE FROM routine_cleanup WHERE key = ?").run(key);
    },
    setCleanupError(key: string, error: string): void {
      db.prepare("UPDATE routine_cleanup SET last_error = ? WHERE key = ?").run(error, key);
    },
    /** The Captain's own icon; the default glyph when it has none. */
    captainIcon(threadId: string): CaptainIcon {
      const row = selectIcon.get(threadId);
      if (row === undefined) return { kind: "default" };
      const icon =
        row.kind === "icon" ? { kind: "icon", name: row.value } : { kind: "image", src: row.value };
      // A row an earlier build stored, such as an SVG, reads as no icon: never a failed read.
      const parsed = captainIconSchema.safeParse(icon);
      return parsed.success ? parsed.data : { kind: "default" };
    },
    /** Set the Captain's icon; null goes back to the default glyph. */
    setCaptainIcon(threadId: string, icon: IconChoice, at: number): void {
      if (icon === null) {
        db.prepare("DELETE FROM captain_icons WHERE thread_id = ?").run(threadId);
        return;
      }
      db.prepare(
        `INSERT INTO captain_icons (thread_id, kind, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET kind = excluded.kind, value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(threadId, icon.kind, icon.kind === "icon" ? icon.name : icon.src, at);
    },
  };

  function nameBlocker(
    captainId: string,
    name: string,
    exceptId: string | null,
    blockers: Blocker[],
  ): void {
    const taken = db
      .prepare<[string, string], { id: string }>(
        "SELECT id FROM routines WHERE captain_id = ? AND name = ? COLLATE NOCASE",
      )
      .get(captainId, name);
    if (taken !== undefined && taken.id !== exceptId) {
      blockers.push({
        reason: `routine ${taken.id} is already named ${JSON.stringify(name)}`,
        fix: "pick another --name, or update that routine",
      });
    }
  }

  function putRepo(captainId: string, repo: Repo): void {
    db.prepare(
      `INSERT INTO captain_repos (captain_id, bb_project_id, tasks_project_key) VALUES (?, ?, ?)
       ON CONFLICT (captain_id, bb_project_id) DO UPDATE SET tasks_project_key = excluded.tasks_project_key`,
    ).run(captainId, repo.bbProjectId, repo.tasksProjectKey);
  }
}
