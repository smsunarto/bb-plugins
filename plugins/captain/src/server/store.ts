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
      const role = row === undefined ? null : parseRole(row.role);
      if (row === undefined || role === null) return null;
      return {
        threadId: row.thread_id,
        captainId: row.captain_id,
        role,
        reportDueSince: row.report_due_since,
        contractSent: row.contract_sent === 1,
      };
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
  };

  function putRepo(captainId: string, repo: Repo): void {
    db.prepare(
      `INSERT INTO captain_repos (captain_id, bb_project_id, tasks_project_key) VALUES (?, ?, ?)
       ON CONFLICT (captain_id, bb_project_id) DO UPDATE SET tasks_project_key = excluded.tasks_project_key`,
    ).run(captainId, repo.bbProjectId, repo.tasksProjectKey);
  }
}
