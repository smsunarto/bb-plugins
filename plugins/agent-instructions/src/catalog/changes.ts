import { createHash, randomBytes } from "node:crypto";
import { stringify } from "yaml";
import type { CatalogChange, ChangeResult } from "./contract.ts";
import { checkSkillTree, editableText, linksInto, pathError } from "./edit-rules.ts";
import { MAX_DESCRIPTION_LENGTH, SKILL_NAME_PATTERN } from "./skill-rules.ts";
import type { Database, Origin } from "./store.ts";
import { treeSha } from "./tree.ts";

/**
 * Applies one editor change in one transaction: check that what the editor
 * saw is still there, apply it, check the skill it leaves, and record a
 * revision. Content edits make an entry authored, so a later import keeps it.
 */
export function applyChange(db: Database, change: CatalogChange, actor: string): ChangeResult {
  return db.transaction(() => run(db, change, actor))();
}

type StoredFile = { path: string; executable: boolean; sha256: string; bytes: Uint8Array };
type SkillRow = { name: string; description: string; enabled: number; origin: string };
type DocRow = {
  id: string;
  name: string;
  body: string;
  enabled: number;
  position: number;
  origin: string;
};
type Failure = Exclude<ChangeResult, { outcome: "saved" }>;

const AUTHORED = JSON.stringify({ kind: "authored" } satisfies Origin);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const invalid = (...errors: string[]): Failure => ({ outcome: "invalid", errors });
const conflict = (message: string): Failure => ({ outcome: "conflict", message });

function revision(db: Database, actor: string, change: CatalogChange): number {
  const summary = JSON.stringify({ kind: "edit", op: change.op, target: target(change) });
  return Number(
    db
      .prepare("INSERT INTO catalog_revisions (at, actor, summary) VALUES (?, ?, ?)")
      .run(Date.now(), actor, summary).lastInsertRowid,
  );
}

function target(change: CatalogChange): string {
  if ("skill" in change) return `${change.skill}/${change.path}`;
  if ("name" in change && !("id" in change)) return change.name;
  if ("id" in change) return change.id;
  return `${change.kind}:${change.key}`;
}

function skillRow(db: Database, name: string): SkillRow | undefined {
  return db
    .prepare("SELECT name, description, enabled, origin FROM skills WHERE name = ?")
    .get(name) as SkillRow | undefined;
}

function skillFiles(db: Database, name: string): StoredFile[] {
  return (
    db
      .prepare(
        "SELECT path, executable, sha256, bytes FROM skill_files WHERE skill = ? ORDER BY path",
      )
      .all(name) as { path: string; executable: number; sha256: string; bytes: Uint8Array }[]
  ).map((f) => ({
    path: f.path,
    executable: f.executable === 1,
    sha256: f.sha256,
    bytes: f.bytes,
  }));
}

function docRow(db: Database, id: string): DocRow | undefined {
  return db
    .prepare("SELECT id, name, body, enabled, position, origin FROM instruction_docs WHERE id = ?")
    .get(id) as DocRow | undefined;
}

function enabledSkills(db: Database): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM skills WHERE enabled = 1").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
}

function isDeleted(db: Database, kind: "skill" | "doc", key: string): boolean {
  return (
    db.prepare("SELECT 1 FROM catalog_deleted WHERE kind = ? AND key = ?").get(kind, key) !==
    undefined
  );
}

/** Replaces a skill's files and row; returns the new tree hash. */
function writeSkill(
  db: Database,
  row: { name: string; description: string; enabled: boolean; origin: string },
  files: readonly StoredFile[],
  rev: number,
): string {
  const tree = treeSha(files);
  db.prepare(
    `INSERT INTO skills (name, description, enabled, origin, tree_sha, rev) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET description = excluded.description, enabled = excluded.enabled,
       origin = excluded.origin, tree_sha = excluded.tree_sha, rev = excluded.rev`,
  ).run(row.name, row.description, row.enabled ? 1 : 0, row.origin, tree, rev);
  db.prepare("DELETE FROM skill_files WHERE skill = ?").run(row.name);
  const insert = db.prepare(
    "INSERT INTO skill_files (skill, path, executable, sha256, bytes) VALUES (?, ?, ?, ?, ?)",
  );
  for (const f of files) insert.run(row.name, f.path, f.executable ? 1 : 0, f.sha256, f.bytes);
  return tree;
}

/** Checks a skill's new files, then stores them as authored. */
function storeSkillFiles(
  db: Database,
  change: CatalogChange,
  actor: string,
  row: SkillRow,
  files: StoredFile[],
  changed: string[],
  extra: { sha256?: string } = {},
): ChangeResult {
  const siblings = enabledSkills(db);
  const check = checkSkillTree(row.name, files, new Set(changed), siblings);
  if (check.errors.length > 0) return invalid(...check.errors);
  const rev = revision(db, actor, change);
  const tree = writeSkill(
    db,
    {
      name: row.name,
      description: check.description,
      enabled: row.enabled === 1,
      origin: AUTHORED,
    },
    files,
    rev,
  );
  return { outcome: "saved", revision: rev, treeSha: tree, warnings: check.warnings, ...extra };
}

function saveFile(
  db: Database,
  change: Extract<CatalogChange, { op: "saveFile" }>,
  actor: string,
): ChangeResult {
  const row = skillRow(db, change.skill);
  if (!row) return conflict(`${change.skill} no longer exists`);
  const error = pathError(change.path);
  if (error) return invalid(error);
  const files = skillFiles(db, change.skill);
  const current = files.find((f) => f.path === change.path);
  if ((current?.sha256 ?? null) !== change.expectedSha256)
    return conflict(
      current ? `${change.path} changed since you opened it` : `${change.path} was deleted`,
    );
  if (current && editableText(current.bytes) === null)
    return invalid(`${change.path} is not a text file, so it cannot be edited here`);
  const bytes = Buffer.from(change.content, "utf8");
  const file: StoredFile = {
    path: change.path,
    // A script starting with #! should run when an agent calls it; saving never clears the bit.
    executable: (current?.executable ?? false) || change.content.startsWith("#!"),
    sha256: sha256(bytes),
    bytes,
  };
  const next = current ? files.map((f) => (f.path === change.path ? file : f)) : [...files, file];
  return storeSkillFiles(db, change, actor, row, next, [change.path], { sha256: file.sha256 });
}

function deleteFile(
  db: Database,
  change: Extract<CatalogChange, { op: "deleteFile" }>,
  actor: string,
): ChangeResult {
  if (change.path === "SKILL.md") return invalid("SKILL.md cannot be deleted; delete the skill");
  const row = skillRow(db, change.skill);
  if (!row) return conflict(`${change.skill} no longer exists`);
  const files = skillFiles(db, change.skill);
  const current = files.find((f) => f.path === change.path);
  if (!current) return conflict(`${change.path} was already deleted`);
  if (current.sha256 !== change.expectedSha256)
    return conflict(`${change.path} changed since you opened it`);
  return storeSkillFiles(
    db,
    change,
    actor,
    row,
    files.filter((f) => f !== current),
    [],
  );
}

function createSkill(
  db: Database,
  change: Extract<CatalogChange, { op: "createSkill" }>,
  actor: string,
): ChangeResult {
  const name = change.name.trim();
  const description = change.description.trim();
  if (!SKILL_NAME_PATTERN.test(name))
    return invalid(
      `${JSON.stringify(name)} is not a valid skill name: lowercase letters, digits and single hyphens, up to 64`,
    );
  if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH)
    return invalid(`The description must be 1-${MAX_DESCRIPTION_LENGTH} characters`);
  if (skillRow(db, name)) return invalid(`A skill named ${name} already exists`);
  if (isDeleted(db, "skill", name))
    return invalid(`${name} is in Recently deleted; restore it there, or remove it first`);
  const text = `---\n${stringify({ name, description }, { lineWidth: 0 })}---\n\n# ${name}\n`;
  const bytes = Buffer.from(text, "utf8");
  const row: SkillRow = { name, description, enabled: 1, origin: AUTHORED };
  const file: StoredFile = { path: "SKILL.md", executable: false, sha256: sha256(bytes), bytes };
  // The SKILL.md hash lets the first edit name what it replaces without reading it back.
  return storeSkillFiles(db, change, actor, row, [file], ["SKILL.md"], { sha256: file.sha256 });
}

/** Warnings for skills whose links point into `name`, once it stops being published. */
function incomingLinks(db: Database, name: string): string[] {
  const others = [...enabledSkills(db)].map((other) => ({
    name: other,
    files: skillFiles(db, other),
  }));
  return linksInto(name, others).map(
    (file) => `${file} links into ${name}, which agents will no longer find`,
  );
}

function deleteSkill(
  db: Database,
  change: Extract<CatalogChange, { op: "deleteSkill" }>,
  actor: string,
): ChangeResult {
  const row = db
    .prepare("SELECT name, description, enabled, origin, tree_sha FROM skills WHERE name = ?")
    .get(change.name) as (SkillRow & { tree_sha: string }) | undefined;
  if (!row) return conflict(`${change.name} was already deleted`);
  if (row.tree_sha !== change.expectedTreeSha)
    return conflict(`${change.name} changed since you opened it; review it before deleting`);
  const files = skillFiles(db, change.name);
  const warnings = incomingLinks(db, change.name);
  const rev = revision(db, actor, change);
  const payload = {
    description: row.description,
    enabled: row.enabled === 1,
    origin: JSON.parse(row.origin) as Origin,
    files: files.map((f) => ({
      path: f.path,
      executable: f.executable,
      base64: Buffer.from(f.bytes).toString("base64"),
    })),
  };
  db.prepare(
    "INSERT OR REPLACE INTO catalog_deleted (kind, key, name, rev, at, payload) VALUES ('skill', ?, ?, ?, ?, ?)",
  ).run(change.name, change.name, rev, Date.now(), JSON.stringify(payload));
  db.prepare("DELETE FROM skill_files WHERE skill = ?").run(change.name);
  db.prepare("DELETE FROM skills WHERE name = ?").run(change.name);
  return { outcome: "saved", revision: rev, warnings };
}

function setSkillEnabled(
  db: Database,
  change: Extract<CatalogChange, { op: "setSkillEnabled" }>,
  actor: string,
): ChangeResult {
  if (!skillRow(db, change.name)) return conflict(`${change.name} no longer exists`);
  const warnings = change.enabled ? [] : incomingLinks(db, change.name);
  const rev = revision(db, actor, change);
  // Not a content edit: an import still refreshes the skill, and keeps the flag.
  db.prepare("UPDATE skills SET enabled = ?, rev = ? WHERE name = ?").run(
    change.enabled ? 1 : 0,
    rev,
    change.name,
  );
  return { outcome: "saved", revision: rev, warnings };
}

function docChange(
  db: Database,
  change: Extract<CatalogChange, { op: "saveDoc" | "renameDoc" | "setDocEnabled" | "deleteDoc" }>,
  actor: string,
): ChangeResult {
  const row = docRow(db, change.id);
  if (!row) return conflict("This document no longer exists");
  if ("expectedSha256" in change && sha256(row.body) !== change.expectedSha256)
    return conflict(`${row.name} changed since you opened it`);
  const rev = revision(db, actor, change);
  if (change.op === "saveDoc") {
    db.prepare("UPDATE instruction_docs SET body = ?, origin = ?, rev = ? WHERE id = ?").run(
      change.body,
      AUTHORED,
      rev,
      change.id,
    );
    return { outcome: "saved", revision: rev, sha256: sha256(change.body), warnings: [] };
  }
  if (change.op === "renameDoc")
    db.prepare("UPDATE instruction_docs SET name = ?, origin = ?, rev = ? WHERE id = ?").run(
      change.name,
      AUTHORED,
      rev,
      change.id,
    );
  else if (change.op === "setDocEnabled")
    db.prepare("UPDATE instruction_docs SET enabled = ?, rev = ? WHERE id = ?").run(
      change.enabled ? 1 : 0,
      rev,
      change.id,
    );
  else {
    db.prepare(
      "INSERT OR REPLACE INTO catalog_deleted (kind, key, name, rev, at, payload) VALUES ('doc', ?, ?, ?, ?, ?)",
    ).run(row.id, row.name, rev, Date.now(), JSON.stringify(row));
    db.prepare("DELETE FROM instruction_docs WHERE id = ?").run(row.id);
  }
  return { outcome: "saved", revision: rev, warnings: [] };
}

function createDoc(
  db: Database,
  change: Extract<CatalogChange, { op: "createDoc" }>,
  actor: string,
): ChangeResult {
  const id = `doc_${randomBytes(6).toString("hex")}`;
  const rev = revision(db, actor, change);
  const { position } = db
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM instruction_docs")
    .get() as { position: number };
  db.prepare(
    "INSERT INTO instruction_docs (id, name, body, enabled, position, origin, rev) VALUES (?, ?, '', 1, ?, ?, ?)",
  ).run(id, change.name, position, AUTHORED, rev);
  return { outcome: "saved", revision: rev, id, sha256: sha256(""), warnings: [] };
}

function restore(
  db: Database,
  change: Extract<CatalogChange, { op: "restore" | "forget" }>,
  actor: string,
): ChangeResult {
  const row = db
    .prepare("SELECT payload FROM catalog_deleted WHERE kind = ? AND key = ?")
    .get(change.kind, change.key) as { payload: string } | undefined;
  if (!row) return conflict("It is no longer in Recently deleted");
  if (change.op === "restore") {
    const taken = change.kind === "skill" ? skillRow(db, change.key) : docRow(db, change.key);
    if (taken)
      return invalid(`Something named ${change.key} exists now; rename or delete it first`);
  }
  const rev = revision(db, actor, change);
  db.prepare("DELETE FROM catalog_deleted WHERE kind = ? AND key = ?").run(change.kind, change.key);
  if (change.op === "forget") return { outcome: "saved", revision: rev, warnings: [] };
  if (change.kind === "doc") {
    const doc = JSON.parse(row.payload) as DocRow;
    db.prepare(
      "INSERT INTO instruction_docs (id, name, body, enabled, position, origin, rev) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(doc.id, doc.name, doc.body, doc.enabled, doc.position, doc.origin, rev);
    return { outcome: "saved", revision: rev, warnings: [] };
  }
  const skill = JSON.parse(row.payload) as {
    description: string;
    enabled: boolean;
    origin: Origin;
    files: { path: string; executable: boolean; base64: string }[];
  };
  const files = skill.files.map((f) => {
    const bytes = Buffer.from(f.base64, "base64");
    return { path: f.path, executable: f.executable, sha256: sha256(bytes), bytes };
  });
  const tree = writeSkill(
    db,
    {
      name: change.key,
      description: skill.description,
      enabled: skill.enabled,
      origin: JSON.stringify(skill.origin),
    },
    files,
    rev,
  );
  return { outcome: "saved", revision: rev, treeSha: tree, warnings: [] };
}

function run(db: Database, change: CatalogChange, actor: string): ChangeResult {
  switch (change.op) {
    case "saveFile":
      return saveFile(db, change, actor);
    case "deleteFile":
      return deleteFile(db, change, actor);
    case "createSkill":
      return createSkill(db, change, actor);
    case "deleteSkill":
      return deleteSkill(db, change, actor);
    case "setSkillEnabled":
      return setSkillEnabled(db, change, actor);
    case "createDoc":
      return createDoc(db, change, actor);
    case "restore":
    case "forget":
      return restore(db, change, actor);
    default:
      return docChange(db, change, actor);
  }
}
