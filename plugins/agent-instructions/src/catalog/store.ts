import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import { applyChange } from "./changes.ts";
export { treeSha } from "./tree.ts";
import type { CatalogChange, CatalogListing } from "./contract.ts";

export type Database = ReturnType<BbPluginApi["storage"]["database"]>;

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
  // Deleted skills and docs: kept to restore, and skipped by the importer until restored or forgotten.
  `CREATE TABLE catalog_deleted (
    kind TEXT NOT NULL CHECK (kind IN ('skill', 'doc')),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    rev INTEGER NOT NULL,
    at INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (kind, key)
  )`,
  // The text each imported provider rule last received, to tell a Rules-tab edit from an import.
  `CREATE TABLE imported_rules (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL
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
  /** Entries the import left alone: edited or deleted in bb since they were imported. */
  skipped: string[];
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

/** `kind:key` for every skill and doc deleted in bb. */
function deletedIds(db: Database): Set<string> {
  const rows = db.prepare("SELECT kind || ':' || key AS id FROM catalog_deleted").all() as {
    id: string;
  }[];
  return new Set(rows.map((r) => r.id));
}

function writeImportedSkills(
  db: Database,
  removed: readonly string[],
  toWrite: readonly CatalogSkill[],
  rev: number,
) {
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
}

function writeImportedDocs(
  db: Database,
  docs: readonly CatalogDoc[],
  plan: { removed: readonly string[]; changed: readonly string[]; kept: readonly CatalogDoc[] },
  rev: number,
) {
  const upsertDoc = db.prepare(
    `INSERT INTO instruction_docs (id, name, body, enabled, position, origin, rev) VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, body = excluded.body, origin = excluded.origin,
       rev = excluded.rev`,
  );
  const deleteDoc = db.prepare("DELETE FROM instruction_docs WHERE id = ?");
  for (const id of plan.removed) deleteDoc.run(id);
  docs.forEach((doc, position) => {
    if (plan.changed.includes(doc.id) && plan.kept.includes(doc))
      upsertDoc.run(doc.id, doc.name, doc.body, position, JSON.stringify(doc.origin), rev);
  });
}

/** Whether a doc was edited (made authored) or deleted in bb, so an import leaves it. */
function keptInBb(id: string, origin: string | undefined, deleted: ReadonlySet<string>): boolean {
  if (deleted.has(`doc:${id}`)) return true;
  return origin !== undefined && (JSON.parse(origin) as Origin).kind === "authored";
}

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

    /** Everything the editor's sidebar shows, without file contents. */
    listing(): Omit<CatalogListing, "published"> {
      const db = database();
      const docs = (
        db
          .prepare(
            "SELECT id, name, body, enabled, origin FROM instruction_docs ORDER BY position, id",
          )
          .all() as { id: string; name: string; body: string; enabled: number; origin: string }[]
      ).map((d) => ({
        id: d.id,
        name: d.name,
        enabled: d.enabled === 1,
        origin: JSON.parse(d.origin) as Origin,
        characters: d.body.length,
        sha256: createHash("sha256").update(d.body).digest("hex"),
      }));
      // A NUL byte marks a file the editor will not open as text; the full check runs on open.
      const files = db
        .prepare(
          `SELECT skill, path, executable, LENGTH(bytes) AS size, instr(bytes, X'00') = 0 AS text
           FROM skill_files ORDER BY skill, path = 'SKILL.md' DESC, path`,
        )
        .all() as { skill: string; path: string; executable: number; size: number; text: number }[];
      const bySkill = new Map<string, typeof files>();
      for (const f of files) {
        const list = bySkill.get(f.skill);
        if (list) list.push(f);
        else bySkill.set(f.skill, [f]);
      }
      const skills = (
        db
          .prepare("SELECT name, description, enabled, origin, tree_sha FROM skills ORDER BY name")
          .all() as {
          name: string;
          description: string;
          enabled: number;
          origin: string;
          tree_sha: string;
        }[]
      ).map((s) => ({
        name: s.name,
        description: s.description,
        enabled: s.enabled === 1,
        origin: JSON.parse(s.origin) as Origin,
        treeSha: s.tree_sha,
        files: (bySkill.get(s.name) ?? []).map((f) => ({
          path: f.path,
          executable: f.executable === 1,
          size: f.size,
          text: f.text === 1,
        })),
      }));
      const deleted = db
        .prepare("SELECT kind, key, name, at FROM catalog_deleted ORDER BY at DESC")
        .all() as { kind: "skill" | "doc"; key: string; name: string; at: number }[];
      return { revision: revision(), docs, skills, deleted };
    },

    /** One file's bytes and mode, or one doc's body; null when it does not exist. */
    file(target: { doc: string } | { skill: string; path: string }) {
      const db = database();
      if ("doc" in target) {
        const row = db.prepare("SELECT body FROM instruction_docs WHERE id = ?").get(target.doc) as
          | { body: string }
          | undefined;
        return row ? { bytes: Buffer.from(row.body, "utf8"), executable: false } : null;
      }
      const row = db
        .prepare("SELECT bytes, executable FROM skill_files WHERE skill = ? AND path = ?")
        .get(target.skill, target.path) as { bytes: Uint8Array; executable: number } | undefined;
      return row ? { bytes: row.bytes, executable: row.executable === 1 } : null;
    },

    /** Applies one editor change; see `applyChange`. */
    change: (change: CatalogChange, actor: string) => applyChange(database(), change, actor),

    /** Skills and docs deleted in bb, which an import must not bring back. */
    deletedKeys(): { skills: Set<string>; docs: Set<string> } {
      const rows = database().prepare("SELECT kind, key FROM catalog_deleted").all() as {
        kind: string;
        key: string;
      }[];
      return {
        skills: new Set(rows.filter((r) => r.kind === "skill").map((r) => r.key)),
        docs: new Set(rows.filter((r) => r.kind === "doc").map((r) => r.key)),
      };
    },

    /** The text hash each imported rule last received from an import. */
    importedRuleHashes(): Map<string, string> {
      const rows = database().prepare("SELECT id, sha256 FROM imported_rules").all() as {
        id: string;
        sha256: string;
      }[];
      return new Map(rows.map((r) => [r.id, r.sha256]));
    },

    setImportedRuleHashes(hashes: ReadonlyMap<string, string>) {
      const db = database();
      db.transaction(() => {
        db.prepare("DELETE FROM imported_rules").run();
        const insert = db.prepare("INSERT INTO imported_rules (id, sha256) VALUES (?, ?)");
        for (const [id, sha] of hashes) insert.run(id, sha);
      })();
    },

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

    /** Enabled skills and the tree each should publish; no file bytes. */
    publishable(): { name: string; treeSha: string }[] {
      return database()
        .prepare("SELECT name, tree_sha AS treeSha FROM skills WHERE enabled = 1 ORDER BY name")
        .all() as { name: string; treeSha: string }[];
    },

    skillFiles(name: string): { path: string; executable: boolean; bytes: Uint8Array }[] {
      return (
        database()
          .prepare("SELECT path, executable, bytes FROM skill_files WHERE skill = ? ORDER BY path")
          .all(name) as { path: string; executable: number; bytes: Uint8Array }[]
      ).map((row) => ({ path: row.path, executable: row.executable === 1, bytes: row.bytes }));
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
        const skipped: string[] = [];
        let unchanged = 0;
        // Checked here, inside the transaction, so an edit made after the plan still wins.
        const deleted = deletedIds(db);
        const removed = [...existing]
          .filter(([name, row]) => row.origin.kind === "imported" && !wanted.has(name))
          .map(([name]) => name);
        const toWrite = skills.filter((skill) => {
          const row = existing.get(skill.name);
          if (row?.origin.kind === "authored" || deleted.has(`skill:${skill.name}`)) {
            skipped.push(`skill ${skill.name}`);
            return false;
          }
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
        const keptDocs = docs.filter((d) => {
          const kept = keptInBb(d.id, currentDocs.get(d.id)?.origin, deleted);
          if (kept) skipped.push(`doc ${d.id}`);
          return !kept;
        });
        const docsChanged = keptDocs
          .filter(
            (d) => currentDocs.get(d.id)?.body !== d.body || currentDocs.get(d.id)?.name !== d.name,
          )
          .map((d) => d.id)
          .concat(docsRemoved);
        if (added.length + updated.length + removed.length + docsChanged.length === 0)
          return { revision: null, added, updated, removed, unchanged, docsChanged, skipped };

        const rev = Number(
          db
            .prepare("INSERT INTO catalog_revisions (at, actor, summary) VALUES (?, ?, ?)")
            .run(
              Date.now(),
              actor,
              JSON.stringify({ kind: "import", added, updated, removed, docsChanged }),
            ).lastInsertRowid,
        );
        writeImportedSkills(db, removed, toWrite, rev);
        writeImportedDocs(
          db,
          docs,
          { removed: docsRemoved, changed: docsChanged, kept: keptDocs },
          rev,
        );
        return { revision: rev, added, updated, removed, unchanged, docsChanged, skipped };
      })();
    },
  };
}
