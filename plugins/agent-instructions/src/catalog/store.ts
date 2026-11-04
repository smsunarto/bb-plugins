import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** bb numbers migrations by index: append new statements, never edit or reorder these. */
const MIGRATIONS = [
  `CREATE TABLE catalog_revisions (
    rev INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    summary TEXT NOT NULL
  )`,
  `CREATE TABLE instruction_docs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    position INTEGER NOT NULL,
    origin TEXT NOT NULL,
    rev INTEGER NOT NULL
  )`,
  `CREATE TABLE skills (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    origin TEXT NOT NULL,
    tree_sha TEXT NOT NULL,
    rev INTEGER NOT NULL
  )`,
  `CREATE TABLE skill_files (
    skill TEXT NOT NULL,
    path TEXT NOT NULL,
    executable INTEGER NOT NULL CHECK (executable IN (0, 1)),
    sha256 TEXT NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY (skill, path)
  )`,
];

/** Where a catalog entry came from. Imported entries are replaced by the next import. */
export type Origin = { kind: "authored" } | { kind: "imported"; from: string };

export type CatalogSkill = {
  name: string;
  description: string;
  origin: Origin;
  files: { path: string; executable: boolean; sha256: string; bytes: Uint8Array }[];
  treeSha: string;
};
export type CatalogDoc = { id: string; name: string; body: string; origin: Origin };

export type ImportChanges = {
  revision: number | null;
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
  docsChanged: string[];
};

export type SkillSummary = {
  name: string;
  description: string;
  enabled: boolean;
  origin: Origin;
  files: number;
  bytes: number;
  rev: number;
};

export type CatalogStore = ReturnType<typeof openCatalog>;

export function openCatalog(bb: BbPluginApi) {
  let db: Database | null = null;
  const database = () => {
    if (db === null) {
      db = bb.storage.database();
      bb.storage.migrate(db, MIGRATIONS);
    }
    return db;
  };
  const revision = () =>
    (
      database().prepare("SELECT MAX(rev) AS rev FROM catalog_revisions").get() as {
        rev: number | null;
      }
    ).rev ?? 0;

  return {
    revision,

    skills(): SkillSummary[] {
      const rows = database()
        .prepare(
          `SELECT s.name, s.description, s.enabled, s.origin, s.rev,
             COUNT(f.path) AS files, COALESCE(SUM(LENGTH(f.bytes)), 0) AS bytes
           FROM skills s LEFT JOIN skill_files f ON f.skill = s.name
           GROUP BY s.name ORDER BY s.name`,
        )
        .all() as {
        name: string;
        description: string;
        enabled: number;
        origin: string;
        rev: number;
        files: number;
        bytes: number;
      }[];
      return rows.map((row) => ({
        name: row.name,
        description: row.description,
        enabled: row.enabled === 1,
        origin: JSON.parse(row.origin) as Origin,
        files: row.files,
        bytes: row.bytes,
        rev: row.rev,
      }));
    },

    docs() {
      return (
        database()
          .prepare(
            "SELECT id, name, body, enabled, origin, rev FROM instruction_docs ORDER BY position, id",
          )
          .all() as {
          id: string;
          name: string;
          body: string;
          enabled: number;
          origin: string;
          rev: number;
        }[]
      ).map((row) => ({
        id: row.id,
        name: row.name,
        body: row.body,
        enabled: row.enabled === 1,
        origin: JSON.parse(row.origin) as Origin,
        rev: row.rev,
      }));
    },

    /** Names of catalog skills that a new import may not overwrite. */
    authoredNames(): Set<string> {
      const rows = database().prepare("SELECT name, origin FROM skills").all() as {
        name: string;
        origin: string;
      }[];
      return new Set(
        rows.filter((r) => (JSON.parse(r.origin) as Origin).kind === "authored").map((r) => r.name),
      );
    },

    /**
     * Makes the imported part of the catalog equal `skills` and `docs` in one
     * transaction, removing imported entries they no longer list (`docsChanged`
     * includes removed docs). Authored entries are untouched; an enabled flag survives a
     * re-import. Writes no revision when nothing changed.
     */
    applyImport(
      skills: readonly CatalogSkill[],
      docs: readonly CatalogDoc[],
      actor: string,
    ): ImportChanges {
      const db = database();
      return db.transaction((): ImportChanges => {
        const existing = new Map(
          (
            db.prepare("SELECT name, origin, tree_sha FROM skills").all() as {
              name: string;
              origin: string;
              tree_sha: string;
            }[]
          ).map((r) => [r.name, { origin: JSON.parse(r.origin) as Origin, treeSha: r.tree_sha }]),
        );
        const wanted = new Set(skills.map((s) => s.name));
        const added: string[] = [];
        const updated: string[] = [];
        let unchanged = 0;
        const removed = [...existing]
          .filter(([name, row]) => row.origin.kind === "imported" && !wanted.has(name))
          .map(([name]) => name);
        const toWrite = skills.filter((skill) => {
          const row = existing.get(skill.name);
          if (row?.origin.kind === "authored")
            throw new Error(`An authored catalog skill is already named ${skill.name}.`);
          if (row === undefined) added.push(skill.name);
          else if (
            row.treeSha !== skill.treeSha ||
            JSON.stringify(row.origin) !== JSON.stringify(skill.origin)
          )
            updated.push(skill.name);
          else {
            unchanged++;
            return false;
          }
          return true;
        });
        const currentDocs = new Map(
          (
            db.prepare("SELECT id, name, body, origin FROM instruction_docs").all() as {
              id: string;
              name: string;
              body: string;
              origin: string;
            }[]
          ).map((r) => [r.id, r]),
        );
        const wantedDocs = new Set(docs.map((d) => d.id));
        const docsRemoved = [...currentDocs.values()]
          .filter(
            (d) => (JSON.parse(d.origin) as Origin).kind === "imported" && !wantedDocs.has(d.id),
          )
          .map((d) => d.id);
        const docsChanged = docs
          .filter(
            (d) => currentDocs.get(d.id)?.body !== d.body || currentDocs.get(d.id)?.name !== d.name,
          )
          .map((d) => d.id)
          .concat(docsRemoved);
        if (added.length + updated.length + removed.length + docsChanged.length === 0)
          return { revision: null, added, updated, removed, unchanged, docsChanged };

        const rev = Number(
          db
            .prepare("INSERT INTO catalog_revisions (at, actor, summary) VALUES (?, ?, ?)")
            .run(
              Date.now(),
              actor,
              JSON.stringify({ kind: "import", added, updated, removed, docsChanged }),
            ).lastInsertRowid,
        );
        const deleteFiles = db.prepare("DELETE FROM skill_files WHERE skill = ?");
        const deleteSkill = db.prepare("DELETE FROM skills WHERE name = ?");
        for (const name of removed) {
          deleteFiles.run(name);
          deleteSkill.run(name);
        }
        const upsertSkill = db.prepare(
          `INSERT INTO skills (name, description, enabled, origin, tree_sha, rev) VALUES (?, ?, 1, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET description = excluded.description, origin = excluded.origin,
             tree_sha = excluded.tree_sha, rev = excluded.rev`,
        );
        const insertFile = db.prepare(
          "INSERT INTO skill_files (skill, path, executable, sha256, bytes) VALUES (?, ?, ?, ?, ?)",
        );
        for (const skill of toWrite) {
          upsertSkill.run(
            skill.name,
            skill.description,
            JSON.stringify(skill.origin),
            skill.treeSha,
            rev,
          );
          deleteFiles.run(skill.name);
          for (const file of skill.files)
            insertFile.run(skill.name, file.path, file.executable ? 1 : 0, file.sha256, file.bytes);
        }
        const upsertDoc = db.prepare(
          `INSERT INTO instruction_docs (id, name, body, enabled, position, origin, rev) VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, body = excluded.body, origin = excluded.origin,
             rev = excluded.rev`,
        );
        const deleteDoc = db.prepare("DELETE FROM instruction_docs WHERE id = ?");
        for (const id of docsRemoved) deleteDoc.run(id);
        docs.forEach((doc, position) => {
          if (docsChanged.includes(doc.id))
            upsertDoc.run(doc.id, doc.name, doc.body, position, JSON.stringify(doc.origin), rev);
        });
        return { revision: rev, added, updated, removed, unchanged, docsChanged };
      })();
    },
  };
}
