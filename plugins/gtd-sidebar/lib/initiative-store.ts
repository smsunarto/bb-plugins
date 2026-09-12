// Plugin-owned initiative persistence: the registry row, its bound bb
// repository projects, and the server-authoritative context documents shared
// by the coordinator and every descendant agent.
//
// Deliberately absent: any thread roster or status table. Membership is bb's
// native parentThreadId ancestry and status is whatever core reports —
// persisting either here would fork the truth.
import type { Database } from "better-sqlite3";
import type { Initiative, InitiativeContextDoc } from "./initiative-types.ts";

// server.ts appends these after the plugin's existing migrations (migration
// ids are positional, so arrays must concatenate, never interleave).
export const INITIATIVE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS initiative (
     id                     TEXT PRIMARY KEY,
     name                   TEXT NOT NULL,
     icon                   TEXT NOT NULL DEFAULT '',
     description            TEXT NOT NULL DEFAULT '',
     coordinator_thread_id  TEXT NOT NULL,
     primary_environment_id TEXT,
     provider_id            TEXT,
     model                  TEXT,
     reasoning_level        TEXT,
     created_at             INTEGER NOT NULL,
     updated_at             INTEGER NOT NULL,
     archived_at            INTEGER
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS initiative_coordinator
     ON initiative (coordinator_thread_id)`,
  `CREATE TABLE IF NOT EXISTS initiative_workspace (
     initiative_id TEXT NOT NULL,
     project_id    TEXT NOT NULL,
     position      INTEGER NOT NULL,
     PRIMARY KEY (initiative_id, project_id)
   )`,
  `CREATE INDEX IF NOT EXISTS initiative_workspace_project
     ON initiative_workspace (project_id)`,
  `CREATE TABLE IF NOT EXISTS initiative_context_doc (
     initiative_id TEXT NOT NULL,
     path          TEXT NOT NULL,
     content       TEXT NOT NULL,
     revision      INTEGER NOT NULL,
     size_bytes    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL,
     updated_by    TEXT,
     PRIMARY KEY (initiative_id, path)
   )`,
];

interface InitiativeRow {
  id: string;
  name: string;
  icon: string;
  description: string;
  coordinator_thread_id: string;
  primary_environment_id: string | null;
  provider_id: string | null;
  model: string | null;
  reasoning_level: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface WorkspaceRow {
  initiative_id: string;
  project_id: string;
  position: number;
}

interface ContextDocRow {
  initiative_id: string;
  path: string;
  content: string;
  revision: number;
  size_bytes: number;
  updated_at: number;
  updated_by: string | null;
}

/** Context doc metadata (no content) — what listings and the tree need. */
export interface ContextDocMeta {
  path: string;
  revision: number;
  sizeBytes: number;
  updatedAt: number;
}

export interface StoredContextDoc extends ContextDocMeta {
  content: string;
  updatedBy: string | null;
}

export type WriteDocResult =
  | { outcome: "written"; revision: number }
  | { outcome: "conflict"; revision: number };

export interface CreateInitiativeInput {
  id: string;
  name: string;
  icon: string;
  description: string;
  coordinatorThreadId: string;
  workspaceProjectIds: string[];
  primaryEnvironmentId: string | null;
  providerId: string | null;
  model: string | null;
  reasoningLevel: string | null;
}

export interface UpdateInitiativeInput {
  name?: string;
  icon?: string;
  description?: string;
  workspaceProjectIds?: string[];
  providerId?: string | null;
  model?: string | null;
  reasoningLevel?: string | null;
}

export interface InitiativeStore {
  create(input: CreateInitiativeInput): Initiative;
  get(initiativeId: string): Initiative | null;
  getByCoordinator(threadId: string): Initiative | null;
  list(filter?: { workspaceProjectId?: string }): Initiative[];
  /** Coordinator ids — the synchronous membership check configure() needs. */
  coordinatorThreadIds(): string[];
  update(initiativeId: string, patch: UpdateInitiativeInput): Initiative;
  setArchived(initiativeId: string, archived: boolean): Initiative;
  /** Deletes registry + workspace bindings + context docs. Caller removes subscriptions. */
  remove(initiativeId: string): void;

  /** File rows only; directories are derived by {@link buildContextTree}. */
  listDocs(initiativeId: string): ContextDocMeta[];
  getDoc(initiativeId: string, path: string): StoredContextDoc | null;
  /**
   * `expectedRevision` omitted = unconditional upsert; `0` = create-only;
   * `n` = overwrite only if the live row is at revision `n`.
   *
   * Throws when the write would collide with the tree: a file row cannot gain
   * descendants (a file is not a directory), and a new file cannot shadow an
   * existing directory (its children would become unreachable).
   */
  writeDoc(input: {
    initiativeId: string;
    path: string;
    content: string;
    expectedRevision?: number;
    updatedBy?: string;
  }): WriteDocResult;
  /** Deletes the file at `path`, or the subtree when `path` is a directory prefix. */
  deleteDoc(initiativeId: string, path: string): number;
}

/**
 * Logical context paths are relative POSIX paths: no leading or trailing
 * slash, no empty or dot segments, no backslashes, no control characters.
 * Rejected outright rather than normalized so callers learn the policy
 * instead of silently writing somewhere other than they asked.
 */
export function normalizeContextPath(path: string): string {
  if (path.length === 0) {
    throw new Error("context doc path must not be empty");
  }
  if (path.startsWith("/")) {
    throw new Error(`context doc path ${JSON.stringify(path)} must be relative, not absolute`);
  }
  if (path.includes("\\")) {
    throw new Error(`context doc path ${JSON.stringify(path)} must use "/" separators`);
  }
  for (const char of path) {
    if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) {
      throw new Error(`context doc path ${JSON.stringify(path)} contains control characters`);
    }
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`context doc path ${JSON.stringify(path)} has an empty segment`);
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`context doc path ${JSON.stringify(path)} contains a dot segment`);
  }
  return path;
}

/** Fold flat file rows into the directory tree the UI and agents present. */
export function buildContextTree(metas: readonly ContextDocMeta[]): InitiativeContextDoc[] {
  interface DirNode {
    doc: InitiativeContextDoc;
    children: Map<string, DirNode | FileNode>;
  }
  interface FileNode {
    doc: InitiativeContextDoc;
  }
  const root: DirNode = {
    doc: { path: "", kind: "directory", sizeBytes: 0, revision: 0, updatedAt: 0 },
    children: new Map(),
  };
  const dirAt = (segments: string[]): DirNode => {
    let node = root;
    for (const [depth, name] of segments.entries()) {
      const path = segments.slice(0, depth + 1).join("/");
      const existing = node.children.get(name);
      if (existing !== undefined && "children" in existing) {
        node = existing;
        continue;
      }
      const created: DirNode = {
        doc: { path, kind: "directory", sizeBytes: 0, revision: 0, updatedAt: 0 },
        children: new Map(),
      };
      node.children.set(name, created);
      node = created;
    }
    return node;
  };

  for (const meta of metas) {
    const segments = meta.path.split("/");
    const parent = dirAt(segments.slice(0, -1));
    const name = segments[segments.length - 1] ?? meta.path;
    parent.children.set(name, {
      doc: {
        path: meta.path,
        kind: "file",
        sizeBytes: meta.sizeBytes,
        revision: meta.revision,
        updatedAt: meta.updatedAt,
      },
    });
  }

  const freeze = (node: DirNode): InitiativeContextDoc[] =>
    [...node.children.values()]
      .sort((a, b) => {
        const aName = a.doc.path.split("/").pop() ?? a.doc.path;
        const bName = b.doc.path.split("/").pop() ?? b.doc.path;
        // Directories first, then files, each alphabetical.
        if ((a.doc.kind === "directory") !== (b.doc.kind === "directory")) {
          return a.doc.kind === "directory" ? -1 : 1;
        }
        return aName.localeCompare(bName);
      })
      .map((entry) => {
        if (!("children" in entry)) return entry.doc;
        const doc: InitiativeContextDoc = {
          path: entry.doc.path,
          kind: "directory",
          sizeBytes: 0,
          revision: 0,
          updatedAt: 0,
          children: freeze(entry),
        };
        return doc;
      });
  return freeze(root);
}

export function createInitiativeStore(db: Database): InitiativeStore {
  const insertInitiative = db.prepare(
    `INSERT INTO initiative
       (id, name, icon, description, coordinator_thread_id, primary_environment_id,
        provider_id, model, reasoning_level, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const insertWorkspace = db.prepare(
    `INSERT INTO initiative_workspace (initiative_id, project_id, position)
     VALUES (?, ?, ?)`,
  );
  const deleteWorkspaces = db.prepare(`DELETE FROM initiative_workspace WHERE initiative_id = ?`);
  const selectById = db.prepare(`SELECT * FROM initiative WHERE id = ?`);
  const selectByCoordinator = db.prepare(
    `SELECT * FROM initiative WHERE coordinator_thread_id = ?`,
  );
  const selectAll = db.prepare(`SELECT * FROM initiative ORDER BY created_at`);
  const selectByProject = db.prepare(
    `SELECT i.* FROM initiative i
       JOIN initiative_workspace w ON w.initiative_id = i.id
      WHERE w.project_id = ?
      ORDER BY i.created_at`,
  );
  const selectCoordinators = db.prepare(`SELECT coordinator_thread_id FROM initiative`);
  const selectWorkspaces = db.prepare(
    `SELECT * FROM initiative_workspace ORDER BY initiative_id, position`,
  );

  const toInitiative = (row: InitiativeRow, workspaces: Map<string, string[]>): Initiative => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    description: row.description,
    coordinatorThreadId: row.coordinator_thread_id,
    workspaceProjectIds: workspaces.get(row.id) ?? [],
    primaryEnvironmentId: row.primary_environment_id,
    providerId: row.provider_id,
    model: row.model,
    reasoningLevel: row.reasoning_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  });

  const workspaceMap = (): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const row of selectWorkspaces.all() as WorkspaceRow[]) {
      const ids = map.get(row.initiative_id);
      if (ids === undefined) map.set(row.initiative_id, [row.project_id]);
      else ids.push(row.project_id);
    }
    return map;
  };

  const replaceWorkspaces = (initiativeId: string, projectIds: string[]): void => {
    deleteWorkspaces.run(initiativeId);
    projectIds.forEach((projectId, position) => {
      insertWorkspace.run(initiativeId, projectId, position);
    });
  };

  const selectDocMeta = db.prepare(
    `SELECT path, revision, size_bytes, updated_at
       FROM initiative_context_doc WHERE initiative_id = ? ORDER BY path`,
  );
  const selectDoc = db.prepare(
    `SELECT * FROM initiative_context_doc WHERE initiative_id = ? AND path = ?`,
  );
  const selectDocDescendants = db.prepare(
    `SELECT path FROM initiative_context_doc
      WHERE initiative_id = ? AND instr(path, ?) = 1 LIMIT 1`,
  );
  const selectDocCollidingAncestors = db.prepare(
    `SELECT path FROM initiative_context_doc
      WHERE initiative_id = ? AND path IN (SELECT value FROM json_each(?)) LIMIT 1`,
  );
  const insertDoc = db.prepare(
    `INSERT INTO initiative_context_doc
       (initiative_id, path, content, revision, size_bytes, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateDoc = db.prepare(
    `UPDATE initiative_context_doc
        SET content = ?, revision = ?, size_bytes = ?, updated_at = ?, updated_by = ?
      WHERE initiative_id = ? AND path = ?`,
  );
  const deleteDocSubtree = db.prepare(
    `DELETE FROM initiative_context_doc
      WHERE initiative_id = ? AND (path = ? OR instr(path, ?) = 1)`,
  );

  /** Every strict ancestor prefix of `path`: "a/b/c.md" -> ["a", "a/b"]. */
  const ancestorPaths = (path: string): string[] => {
    const segments = path.split("/");
    const ancestors: string[] = [];
    for (let depth = 1; depth < segments.length; depth++) {
      ancestors.push(segments.slice(0, depth).join("/"));
    }
    return ancestors;
  };

  const assertNoTreeCollision = (initiativeId: string, path: string): void => {
    // A file row under `path` means `path` is a live directory; a file write
    // here would shadow it and strand the children.
    const descendant = selectDocDescendants.get(initiativeId, `${path}/`) as
      | { path: string }
      | undefined;
    if (descendant !== undefined) {
      throw new Error(
        `context doc ${JSON.stringify(path)} is a directory containing ${JSON.stringify(descendant.path)}`,
      );
    }
    // A file row at any ancestor prefix means `path` lives inside a file,
    // which the tree cannot represent.
    const ancestors = ancestorPaths(path);
    if (ancestors.length > 0) {
      const collision = selectDocCollidingAncestors.get(initiativeId, JSON.stringify(ancestors)) as
        | { path: string }
        | undefined;
      if (collision !== undefined) {
        throw new Error(
          `context doc ${JSON.stringify(path)} is inside the file ${JSON.stringify(collision.path)}`,
        );
      }
    }
  };

  return {
    create(input) {
      const now = Date.now();
      db.transaction(() => {
        insertInitiative.run(
          input.id,
          input.name,
          input.icon,
          input.description,
          input.coordinatorThreadId,
          input.primaryEnvironmentId,
          input.providerId,
          input.model,
          input.reasoningLevel,
          now,
          now,
        );
        replaceWorkspaces(input.id, input.workspaceProjectIds);
      })();
      const created = this.get(input.id);
      if (created === null) throw new Error(`initiative ${input.id} failed to persist`);
      return created;
    },

    get(initiativeId) {
      const row = selectById.get(initiativeId) as InitiativeRow | undefined;
      return row === undefined ? null : toInitiative(row, workspaceMap());
    },

    getByCoordinator(threadId) {
      const row = selectByCoordinator.get(threadId) as InitiativeRow | undefined;
      return row === undefined ? null : toInitiative(row, workspaceMap());
    },

    list(filter) {
      const workspaces = workspaceMap();
      const rows =
        filter?.workspaceProjectId === undefined
          ? (selectAll.all() as InitiativeRow[])
          : (selectByProject.all(filter.workspaceProjectId) as InitiativeRow[]);
      return rows.map((row) => toInitiative(row, workspaces));
    },

    coordinatorThreadIds() {
      return (selectCoordinators.all() as { coordinator_thread_id: string }[]).map(
        (row) => row.coordinator_thread_id,
      );
    },

    update(initiativeId, patch) {
      const existing = this.get(initiativeId);
      if (existing === null) throw new Error(`initiative ${initiativeId} not found`);
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          `UPDATE initiative SET
             name = ?, icon = ?, description = ?, provider_id = ?, model = ?,
             reasoning_level = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          patch.name ?? existing.name,
          patch.icon ?? existing.icon,
          patch.description ?? existing.description,
          patch.providerId === undefined ? existing.providerId : patch.providerId,
          patch.model === undefined ? existing.model : patch.model,
          patch.reasoningLevel === undefined ? existing.reasoningLevel : patch.reasoningLevel,
          now,
          initiativeId,
        );
        if (patch.workspaceProjectIds !== undefined) {
          replaceWorkspaces(initiativeId, patch.workspaceProjectIds);
        }
      })();
      const updated = this.get(initiativeId);
      if (updated === null) throw new Error(`initiative ${initiativeId} failed to persist`);
      return updated;
    },

    setArchived(initiativeId, archived) {
      const existing = this.get(initiativeId);
      if (existing === null) throw new Error(`initiative ${initiativeId} not found`);
      db.prepare(`UPDATE initiative SET archived_at = ?, updated_at = ? WHERE id = ?`).run(
        archived ? Date.now() : null,
        Date.now(),
        initiativeId,
      );
      const updated = this.get(initiativeId);
      if (updated === null) throw new Error(`initiative ${initiativeId} failed to persist`);
      return updated;
    },

    remove(initiativeId) {
      db.transaction(() => {
        deleteWorkspaces.run(initiativeId);
        db.prepare(`DELETE FROM initiative_context_doc WHERE initiative_id = ?`).run(initiativeId);
        db.prepare(`DELETE FROM initiative WHERE id = ?`).run(initiativeId);
      })();
    },

    listDocs(initiativeId) {
      return (
        selectDocMeta.all(initiativeId) as {
          path: string;
          revision: number;
          size_bytes: number;
          updated_at: number;
        }[]
      ).map((row) => ({
        path: row.path,
        revision: row.revision,
        sizeBytes: row.size_bytes,
        updatedAt: row.updated_at,
      }));
    },

    getDoc(initiativeId, path) {
      const row = selectDoc.get(initiativeId, normalizeContextPath(path)) as
        | ContextDocRow
        | undefined;
      if (row === undefined) return null;
      return {
        path: row.path,
        content: row.content,
        revision: row.revision,
        sizeBytes: row.size_bytes,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
    },

    writeDoc({ initiativeId, path, content, expectedRevision, updatedBy }) {
      const normalized = normalizeContextPath(path);
      const sizeBytes = new TextEncoder().encode(content).length;
      const now = Date.now();
      return db.transaction((): WriteDocResult => {
        // No SQL FK — enforce ownership before any tree checks so a stray id
        // cannot mint documents.
        if (selectById.get(initiativeId) === undefined) {
          throw new Error(`initiative ${initiativeId} not found`);
        }
        assertNoTreeCollision(initiativeId, normalized);
        const row = selectDoc.get(initiativeId, normalized) as ContextDocRow | undefined;
        if (expectedRevision === undefined) {
          // Unconditional upsert: still monotonic, just not guarded.
          if (row === undefined) {
            insertDoc.run(initiativeId, normalized, content, 1, sizeBytes, now, updatedBy ?? null);
            return { outcome: "written", revision: 1 };
          }
          updateDoc.run(
            content,
            row.revision + 1,
            sizeBytes,
            now,
            updatedBy ?? null,
            initiativeId,
            normalized,
          );
          return { outcome: "written", revision: row.revision + 1 };
        }
        if (row === undefined) {
          if (expectedRevision === 0) {
            insertDoc.run(initiativeId, normalized, content, 1, sizeBytes, now, updatedBy ?? null);
            return { outcome: "written", revision: 1 };
          }
          return { outcome: "conflict", revision: 0 };
        }
        if (row.revision !== expectedRevision) {
          return { outcome: "conflict", revision: row.revision };
        }
        updateDoc.run(
          content,
          row.revision + 1,
          sizeBytes,
          now,
          updatedBy ?? null,
          initiativeId,
          normalized,
        );
        return { outcome: "written", revision: row.revision + 1 };
      })();
    },

    deleteDoc(initiativeId, path) {
      const normalized = normalizeContextPath(path);
      if (selectById.get(initiativeId) === undefined) {
        throw new Error(`initiative ${initiativeId} not found`);
      }
      return deleteDocSubtree.run(initiativeId, normalized, `${normalized}/`).changes;
    },
  };
}
