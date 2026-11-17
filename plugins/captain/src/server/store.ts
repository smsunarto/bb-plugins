import type { BbPluginApi } from "@get-bb/plugin-sdk";
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
];

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

export const ASK_KINDS = ["decision", "ship", "access", "improve"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

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
};

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
    openAsk(ask: Omit<Ask, "id" | "answer" | "answeredAt" | "answerDeliveredAt">): Ask {
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
  };

  function putRepo(captainId: string, repo: Repo): void {
    db.prepare(
      `INSERT INTO captain_repos (captain_id, bb_project_id, tasks_project_key) VALUES (?, ?, ?)
       ON CONFLICT (captain_id, bb_project_id) DO UPDATE SET tasks_project_key = excluded.tasks_project_key`,
    ).run(captainId, repo.bbProjectId, repo.tasksProjectKey);
  }
}
