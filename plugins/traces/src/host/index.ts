import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync, type Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ParsedRecord, TraceAdapter, TraceEvent, TraceSession } from "../shared/model.ts";
import { builtinAdapters, createAdapterRegistry } from "../shared/providers/index.ts";
import {
  configureInputSchema,
  eventInputSchema,
  eventQuerySchema,
  rawInputSchema,
  scanInputSchema,
  sessionQuerySchema,
  type EventDetail,
  type EventPage,
  type RawPage,
  type SessionPage,
  type SourceRoot,
  type SourceStatus,
  type TraceStatus,
} from "../shared/schema.ts";
import {
  discover,
  hash,
  MAX_RECORD_BYTES,
  probes,
  readLines,
  readVerifiedSpan,
  type SourceLine,
} from "./ingest.ts";

type Source = {
  id: string;
  root: string;
  path: string;
  provider: string;
  generation: number;
  offset: number;
  line: number;
  size: number;
  mtime: number;
  ctime: number;
  ino: number;
  dev: number;
  adapterVersion: number;
  probe: string;
  summary: TraceSession;
};
type StoredSource = { data: string; summary: string; visible_generation: number };
type StoredEvent = { summary: string; source_id: string; generation: number };
type Cursor = { revision: number; query: string; key: [number, string] };
type ScanOptions = { verify?: boolean; signal?: AbortSignal };
const SCHEMA_VERSION = 1;
const BODY_LIMIT = 512 * 1024;
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function searchExpression(value: string | undefined): string | null {
  const words = value?.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 24);
  return words?.length
    ? words.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" AND ")
    : null;
}

function diagnostic(message: string, content: string): ParsedRecord {
  return {
    session: {},
    events: [
      {
        kind: "diagnostic",
        role: null,
        title: message,
        preview: content.slice(0, 2048),
        timestamp: null,
        template: "diagnostic",
        nativeId: null,
        parentId: null,
        turnId: null,
        tool: null,
        usage: null,
        evidence: [],
        pointer: "",
        body: { type: "text", text: content, format: "plain" },
      },
    ],
  };
}

/** Owns the host's derived index. Source files are always read-only. */
export class TraceIndex {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly registry;
  private readonly configPath: string;
  private roots: SourceStatus[];
  private scanPromise: Promise<void> | null = null;
  private scanAbort: AbortController | null = null;
  private readonly lifetime = new AbortController();
  private lastScanAt: number | null = null;
  private lastError: string | null = null;
  private counts: { revision: number; sessions: number; events: number } | undefined;
  private closed = false;

  constructor(options: {
    dataDir: string;
    adapters?: readonly TraceAdapter[];
    home?: string;
    env?: Readonly<Record<string, string | undefined>>;
    roots?: SourceRoot[];
  }) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.registry = createAdapterRegistry(options.adapters ?? builtinAdapters);
    this.configPath = join(options.dataDir, "sources.json");
    let roots = options.roots;
    if (!roots) {
      try {
        roots = configureInputSchema.parse(JSON.parse(readFileSync(this.configPath, "utf8"))).roots;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          this.lastError = "Could not read saved source configuration.";
      }
    }
    roots ??= this.registry
      .list()
      .flatMap((adapter) =>
        adapter
          .roots(options.home ?? homedir(), options.env ?? process.env)
          .map((path) => ({ provider: adapter.id, path, enabled: true })),
      );
    this.roots = this.sourceStatuses(roots);
    this.db = new DatabaseSync(join(options.dataDir, "traces.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('version', ${SCHEMA_VERSION}), ('revision', 0);
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, path TEXT NOT NULL, root TEXT NOT NULL,
        data TEXT NOT NULL, summary TEXT NOT NULL, visible_generation INTEGER NOT NULL,
        native_id TEXT, updated_at REAL NOT NULL, state TEXT NOT NULL,
        UNIQUE(provider, path)
      );
      CREATE INDEX IF NOT EXISTS sources_recent ON sources(updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sources_provider_recent ON sources(provider, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sources_native ON sources(native_id);
      CREATE TABLE IF NOT EXISTS spans (
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL, line INTEGER NOT NULL, offset INTEGER NOT NULL,
        length INTEGER NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY(source_id, generation, line)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL, sequence INTEGER NOT NULL, part INTEGER NOT NULL,
        kind TEXT NOT NULL, call_id TEXT, topics TEXT NOT NULL, summary TEXT NOT NULL,
        PRIMARY KEY(id, generation)
      );
      CREATE INDEX IF NOT EXISTS events_timeline ON events(source_id, generation, sequence, part, id);
      CREATE INDEX IF NOT EXISTS events_kind ON events(source_id, generation, kind, sequence, part);
      CREATE INDEX IF NOT EXISTS events_call ON events(source_id, generation, call_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(event_id UNINDEXED, generation UNINDEXED, search);
      CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(source_id UNINDEXED, search);
      CREATE TABLE IF NOT EXISTS event_topics (
        event_id TEXT NOT NULL, source_id TEXT NOT NULL, generation INTEGER NOT NULL,
        topic TEXT NOT NULL, sequence INTEGER NOT NULL, part INTEGER NOT NULL,
        PRIMARY KEY(event_id,generation,topic)
      );
      CREATE INDEX IF NOT EXISTS event_topics_filter ON event_topics(source_id,generation,topic,sequence,part,event_id);
      -- A moved session leaves a cached source at its old path. Keep that cache
      -- addressable by event ID, but list only its available continuation.
      -- Native IDs alone are not enough: distinct traces can reuse them.
      CREATE VIEW IF NOT EXISTS session_sources AS
        SELECT original.* FROM sources original
        WHERE original.state != 'missing' OR NOT EXISTS (
          SELECT 1 FROM sources replacement
          WHERE replacement.provider = original.provider
            AND replacement.native_id = original.native_id
            AND replacement.state = 'ready'
            AND EXISTS (
              SELECT 1 FROM spans old
              WHERE old.source_id = original.id AND old.generation = original.visible_generation
            )
            AND NOT EXISTS (
              SELECT 1 FROM spans old
              LEFT JOIN spans current
                ON current.source_id = replacement.id
                AND current.generation = replacement.visible_generation
                AND current.line = old.line
              WHERE old.source_id = original.id AND old.generation = original.visible_generation
                AND (current.hash IS NULL OR current.hash != old.hash OR current.length != old.length)
            )
        );
    `);
    const version = this.prepare("SELECT value FROM meta WHERE key = 'version'").get() as {
      value: number;
    };
    if (version.value !== SCHEMA_VERSION) throw new Error("Unsupported trace index version.");
    const lastScan = this.prepare("SELECT value FROM meta WHERE key = 'last_scan'").get() as
      | { value: number }
      | undefined;
    this.lastScanAt = lastScan?.value ?? null;
  }

  private prepare(sql: string): StatementSync {
    const existing = this.statements.get(sql);
    if (existing) return existing;
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  private transaction(action: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private sourceStatuses(roots: SourceRoot[]): SourceStatus[] {
    const unique = new Map<string, SourceStatus>();
    for (const root of roots) {
      if (!isAbsolute(root.path)) throw new Error("Source roots must be absolute paths.");
      if (!this.registry.lookup(root.provider))
        throw new Error(`Unsupported trace provider: ${root.provider}`);
      const path = resolve(root.path);
      unique.set(`${root.provider}:${path}`, {
        ...root,
        path,
        state: root.enabled ? "ready" : "disabled",
        message: null,
        fileCount: 0,
      });
    }
    return [...unique.values()];
  }

  private get revision(): number {
    return (
      this.prepare("SELECT value FROM meta WHERE key = 'revision'").get() as { value: number }
    ).value;
  }

  private bump(): void {
    this.prepare("UPDATE meta SET value = value + 1 WHERE key = 'revision'").run();
  }

  status(): TraceStatus {
    const revision = this.revision;
    if (this.counts?.revision !== revision) {
      const counts = this.prepare(
        "SELECT count(*) AS sessions, coalesce(sum(json_extract(summary, '$.eventCount')), 0) AS events FROM session_sources",
      ).get() as { sessions: number; events: number };
      this.counts = { revision, ...counts };
    }
    return {
      schemaVersion: 1,
      providers: this.registry.list().map(({ id, label, version }) => ({ id, label, version })),
      roots: this.roots.map((root) => ({ ...root })),
      sessions: this.counts.sessions,
      events: this.counts.events,
      scanning: this.scanPromise !== null,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      revision,
    };
  }

  async configureSources(input: unknown): Promise<TraceStatus> {
    const roots = this.sourceStatuses(configureInputSchema.parse(input).roots);
    this.scanAbort?.abort();
    if (this.scanPromise) await this.scanPromise.catch(() => undefined);
    const temporary = `${this.configPath}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({
        roots: roots.map(({ provider, path, enabled }) => ({ provider, path, enabled })),
      }),
      { mode: 0o600 },
    );
    renameSync(temporary, this.configPath);
    this.roots = roots;
    this.transaction(() => {
      const configured = new Set(roots.map((root) => `${root.provider}\0${root.path}`));
      const cached = this.prepare("SELECT id,provider,root FROM sources").all() as {
        id: string;
        provider: string;
        root: string;
      }[];
      for (const source of cached) {
        if (configured.has(`${source.provider}\0${source.root}`)) continue;
        this.prepare(
          "DELETE FROM events_fts WHERE rowid IN (SELECT rowid FROM events WHERE source_id=?)",
        ).run(source.id);
        this.prepare("DELETE FROM sources_fts WHERE source_id=?").run(source.id);
        this.prepare("DELETE FROM event_topics WHERE source_id=?").run(source.id);
        this.prepare("DELETE FROM sources WHERE id=?").run(source.id);
      }
      this.bump();
    });
    return this.status();
  }

  scan(options: ScanOptions = {}): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Trace index is closed."));
    if (this.scanPromise) return this.scanPromise;
    const { verify } = scanInputSchema.parse({ verify: options.verify });
    this.scanAbort = new AbortController();
    const signals = [this.lifetime.signal, this.scanAbort.signal];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    this.scanPromise = this.scanSources(verify, signal).finally(() => {
      this.scanPromise = null;
      this.scanAbort = null;
    });
    return this.scanPromise;
  }

  private async scanSources(verify: boolean, signal: AbortSignal): Promise<void> {
    this.lastError = null;
    for (const root of this.roots) {
      if (!root.enabled) continue;
      await this.scanRoot(root, verify, signal);
      if (root.state === "error") this.lastError = root.message;
    }
    this.lastScanAt = Date.now();
    this.prepare("INSERT OR REPLACE INTO meta VALUES ('last_scan', ?)").run(this.lastScanAt);
  }

  private async scanRoot(root: SourceStatus, verify: boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    root.state = "scanning";
    root.message = null;
    const seen = new Set<string>();
    try {
      const adapter = this.registry.lookup(root.provider);
      if (!adapter) throw new Error(`Unsupported provider: ${root.provider}`);
      for await (const path of discover(root.path, signal, (path) => adapter.accepts(path))) {
        const id = hash(`${adapter.id}\0${path}`);
        seen.add(id);
        try {
          await this.indexFile(path, root.path, adapter, verify, signal);
        } catch (error) {
          signal.throwIfAborted();
          this.setSourceState(id, "error");
          root.message = `Some source files could not be indexed: ${errorMessage(error)}`;
        }
      }
      const existing = this.prepare("SELECT id FROM sources WHERE provider=? AND root=?").all(
        root.provider,
        root.path,
      ) as { id: string }[];
      for (const item of existing) if (!seen.has(item.id)) this.setSourceState(item.id, "missing");
      root.state = root.message ? "error" : "ready";
    } catch (error) {
      signal.throwIfAborted();
      root.state = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
      root.message = errorMessage(error);
      // Cached rows survive an unreadable or missing root. Absence was not established.
    }
    root.fileCount = seen.size;
  }

  private setSourceState(id: string, state: TraceSession["state"]): void {
    const row = this.prepare("SELECT summary FROM sources WHERE id=?").get(id) as
      | { summary: string }
      | undefined;
    if (!row) return;
    const summary = JSON.parse(row.summary) as TraceSession;
    if (summary.state === state) return;
    summary.state = state;
    this.prepare("UPDATE sources SET summary=?, state=? WHERE id=?").run(
      JSON.stringify(summary),
      state,
      id,
    );
    this.bump();
  }

  private saveSource(
    source: Source,
    visibleGeneration: number,
    visibleSummary: TraceSession,
  ): void {
    this.prepare(`INSERT INTO sources(id,provider,path,root,data,summary,visible_generation,native_id,updated_at,state)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      root=excluded.root,data=excluded.data,summary=excluded.summary,visible_generation=excluded.visible_generation,
      native_id=excluded.native_id,updated_at=excluded.updated_at,state=excluded.state`).run(
      source.id,
      source.provider,
      source.path,
      source.root,
      JSON.stringify(source),
      JSON.stringify(visibleSummary),
      visibleGeneration,
      visibleSummary.nativeId,
      visibleSummary.updatedAt,
      visibleSummary.state,
    );
    this.prepare("DELETE FROM sources_fts WHERE source_id=?").run(source.id);
    this.prepare("INSERT INTO sources_fts(source_id,search) VALUES (?,?)").run(
      source.id,
      [
        visibleSummary.title,
        visibleSummary.cwd,
        visibleSummary.model,
        visibleSummary.nativeId,
        visibleSummary.path,
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 8192),
    );
  }

  private async indexFile(
    path: string,
    root: string,
    adapter: TraceAdapter,
    verify: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return;
    const id = hash(`${adapter.id}\0${path}`);
    const row = this.prepare("SELECT data,summary,visible_generation FROM sources WHERE id=?").get(
      id,
    ) as StoredSource | undefined;
    let previous = row ? (JSON.parse(row.data) as Source) : undefined;
    const rebuild = await this.needsRebuild(previous, info, adapter, verify, signal);
    if (
      previous &&
      !rebuild &&
      previous.offset === info.size &&
      row?.visible_generation === previous.generation
    ) {
      this.setSourceState(id, "ready");
      return;
    }
    const oldSummary = row ? (JSON.parse(row.summary) as TraceSession) : undefined;
    let source = this.prepareSource({ id, path, root, adapter, previous, info, rebuild });
    const { generation, summary } = source;
    const visibleGeneration = row?.visible_generation ?? generation;
    const visibleSummary = visibleGeneration === generation ? summary : oldSummary!;
    try {
      await this.indexSource(source, visibleGeneration, visibleSummary, adapter, info, signal);
    } catch (error) {
      if (row && !rebuild) this.rollbackAppend(row);
      throw error;
    }
  }

  private rollbackAppend(row: StoredSource): void {
    const previous = JSON.parse(row.data) as Source;
    this.transaction(() => {
      this.prepare(
        "DELETE FROM events_fts WHERE rowid IN (SELECT rowid FROM events WHERE source_id=? AND generation=? AND sequence>?)",
      ).run(previous.id, previous.generation, previous.line);
      this.prepare(
        "DELETE FROM event_topics WHERE source_id=? AND generation=? AND sequence>?",
      ).run(previous.id, previous.generation, previous.line);
      this.prepare("DELETE FROM events WHERE source_id=? AND generation=? AND sequence>?").run(
        previous.id,
        previous.generation,
        previous.line,
      );
      this.prepare("DELETE FROM spans WHERE source_id=? AND generation=? AND line>?").run(
        previous.id,
        previous.generation,
        previous.line,
      );
      this.saveSource(previous, row.visible_generation, JSON.parse(row.summary) as TraceSession);
      this.bump();
    });
  }

  private async indexSource(
    source: Source,
    visibleGeneration: number,
    visibleSummary: TraceSession,
    adapter: TraceAdapter,
    info: Stats,
    signal: AbortSignal,
  ): Promise<void> {
    const { id, path, generation } = source;
    const originalProbe = await probes(source.path, info.size);
    this.saveSource(source, visibleGeneration, visibleSummary);
    let batch: SourceLine[] = [];
    let batchBytes = 0;
    let batchStarted = performance.now();
    const flush = async () => {
      if (!batch.length) return;
      const last = batch.at(-1)!;
      const checkpoint = last.offset + last.length;
      const probe = await probes(path, checkpoint);
      signal.throwIfAborted();
      this.transaction(() => {
        for (const line of batch) this.indexLine(source, line, adapter);
        source.offset = checkpoint;
        source.line = last.line;
        source.probe = probe;
        this.saveSource(source, visibleGeneration, visibleSummary);
        this.bump();
      });
      batch = [];
      batchBytes = 0;
      batchStarted = performance.now();
      await setImmediate();
    };
    for await (const line of readLines(path, source.offset, source.line, info.size, signal)) {
      batch.push(line);
      batchBytes += line.length;
      if (
        batch.length >= 500 ||
        batchBytes >= 4 * 1024 * 1024 ||
        performance.now() - batchStarted >= 20
      )
        await flush();
    }
    await flush();
    await this.assertSourceUnchanged(path, info, originalProbe);
    source = { ...source, probe: await probes(path, source.offset) };
    source.summary.state = "ready";
    this.transaction(() => {
      this.saveSource(source, generation, source.summary);
      this.prepare(
        "DELETE FROM events_fts WHERE rowid IN (SELECT rowid FROM events WHERE source_id=? AND generation!=?)",
      ).run(id, generation);
      this.prepare("DELETE FROM events WHERE source_id=? AND generation!=?").run(id, generation);
      this.prepare("DELETE FROM spans WHERE source_id=? AND generation!=?").run(id, generation);
      this.prepare("DELETE FROM event_topics WHERE source_id=? AND generation!=?").run(
        id,
        generation,
      );
      this.bump();
    });
  }

  private async needsRebuild(
    previous: Source | undefined,
    info: Stats,
    adapter: TraceAdapter,
    verify: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!previous) return true;
    if (
      previous.adapterVersion !== adapter.version ||
      previous.ino !== info.ino ||
      previous.dev !== info.dev ||
      info.size < previous.offset ||
      info.size < previous.size
    )
      return true;
    if ((await probes(previous.path, previous.offset)) !== previous.probe) return true;
    // Same-size metadata changes are a rewrite signal. Append probes do not prove a stable prefix.
    if (
      info.size === previous.size &&
      (info.mtimeMs !== previous.mtime || info.ctimeMs !== previous.ctime)
    )
      return true;
    if (!verify) return false;
    const spans = this.prepare(
      "SELECT offset,length,hash FROM spans WHERE source_id=? AND generation=? ORDER BY line",
    ).iterate(previous.id, previous.generation);
    for (const span of spans) {
      const result = await readVerifiedSpan(
        previous.path,
        span as { offset: number; length: number; hash: string },
        0,
        0,
        signal,
      );
      if (result.state !== "available") return true;
    }
    return false;
  }

  private prepareSource({
    id,
    path,
    root,
    adapter,
    previous,
    info,
    rebuild,
  }: {
    id: string;
    path: string;
    root: string;
    adapter: TraceAdapter;
    previous?: Source;
    info: Stats;
    rebuild: boolean;
  }): Source {
    const generation = rebuild ? (previous?.generation ?? 0) + 1 : previous!.generation;
    const summary: TraceSession = rebuild
      ? {
          id,
          nativeId: null,
          provider: adapter.id,
          title: basename(path, ".jsonl"),
          path,
          cwd: null,
          model: null,
          parentNativeId: null,
          startedAt: null,
          updatedAt: info.mtimeMs,
          eventCount: 0,
          toolCount: 0,
          errorCount: 0,
          topics: [],
          state: "indexing",
        }
      : previous!.summary;
    return {
      id,
      root,
      path,
      provider: adapter.id,
      generation,
      offset: rebuild ? 0 : previous!.offset,
      line: rebuild ? 0 : previous!.line,
      size: info.size,
      mtime: info.mtimeMs,
      ctime: info.ctimeMs,
      ino: info.ino,
      dev: info.dev,
      adapterVersion: adapter.version,
      probe: rebuild ? hash(Buffer.alloc(0)) : previous!.probe,
      summary,
    };
  }

  private async assertSourceUnchanged(
    path: string,
    before: Stats,
    originalProbe: string,
  ): Promise<void> {
    const after = await lstat(path);
    if (
      (await probes(path, before.size)) !== originalProbe ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size < before.size ||
      (after.size === before.size &&
        (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs))
    ) {
      throw new Error("Source changed during indexing. Refresh to retry.");
    }
  }

  private indexLine(source: Source, line: SourceLine, adapter: TraceAdapter): void {
    this.prepare("INSERT OR REPLACE INTO spans VALUES (?,?,?,?,?,?)").run(
      source.id,
      source.generation,
      line.line,
      line.offset,
      line.length,
      line.hash,
    );
    let parsed: ParsedRecord;
    if (!line.bytes)
      parsed = diagnostic(
        "Oversized source record",
        `This record exceeds ${MAX_RECORD_BYTES / 1024 / 1024} MiB. Read its exact bytes in Raw.`,
      );
    else if (!line.bytes.toString("utf8").trim()) return;
    else {
      try {
        parsed = adapter.parse(JSON.parse(line.bytes.toString("utf8")), {
          path: source.path,
          line: line.line,
        });
      } catch (error) {
        parsed = diagnostic(
          "Malformed source record",
          `${errorMessage(error)}\n${line.bytes.toString("utf8").slice(0, 2048)}`,
        );
      }
    }
    const patch = parsed.session;
    if (patch.nativeId) source.summary.nativeId = patch.nativeId;
    if (patch.title && source.summary.title === basename(source.path, ".jsonl"))
      source.summary.title = patch.title;
    if (patch.cwd) source.summary.cwd = patch.cwd;
    if (patch.model) source.summary.model = patch.model;
    if (patch.parentNativeId) source.summary.parentNativeId = patch.parentNativeId;
    if (patch.startedAt !== undefined)
      source.summary.startedAt =
        source.summary.startedAt === null
          ? patch.startedAt
          : Math.min(source.summary.startedAt, patch.startedAt);
    parsed.events.forEach(({ body: _body, pointer, ...fields }, part) => {
      const id = hash(`${source.id}\0${line.line}\0${part}\0${line.hash}\0${adapter.version}`);
      const event: TraceEvent = {
        ...fields,
        id,
        sessionId: source.id,
        provider: adapter.id,
        sequence: line.line,
        part,
        provenance: {
          path: source.path,
          line: line.line,
          pointer,
          byteOffset: line.offset,
          byteLength: line.length,
          recordHash: line.hash,
          adapterVersion: adapter.version,
        },
      };
      const inserted = this.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)").run(
        id,
        source.id,
        source.generation,
        event.sequence,
        part,
        event.kind,
        event.tool?.callId ?? null,
        JSON.stringify([...new Set(event.evidence.map(({ topic }) => topic))]),
        JSON.stringify(event),
      );
      this.prepare("INSERT INTO events_fts(rowid,event_id,generation,search) VALUES (?,?,?,?)").run(
        inserted.lastInsertRowid,
        id,
        source.generation,
        [event.title, event.preview, event.tool?.name, ...event.evidence.map(({ label }) => label)]
          .filter(Boolean)
          .join(" ")
          .slice(0, 4096),
      );
      this.prepare("DELETE FROM event_topics WHERE event_id=? AND generation=?").run(
        id,
        source.generation,
      );
      for (const topic of new Set(event.evidence.map((fact) => fact.topic))) {
        this.prepare("INSERT INTO event_topics VALUES (?,?,?,?,?,?)").run(
          id,
          source.id,
          source.generation,
          topic,
          event.sequence,
          part,
        );
      }
      source.summary.eventCount += 1;
      if (event.kind === "tool_call") source.summary.toolCount += 1;
      if (event.kind === "diagnostic" || event.tool?.status === "error")
        source.summary.errorCount += 1;
      if (event.timestamp !== null)
        source.summary.updatedAt = Math.max(source.summary.updatedAt, event.timestamp);
      source.summary.topics = [
        ...new Set([...source.summary.topics, ...event.evidence.map(({ topic }) => topic)]),
      ];
    });
  }

  private readCursor(encoded: string | undefined, query: string): Cursor | null {
    if (!encoded) return null;
    try {
      const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Cursor;
      if (
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        value.revision > this.revision ||
        value.query !== query ||
        !Array.isArray(value.key) ||
        value.key.length !== 2 ||
        !Number.isFinite(value.key[0]) ||
        value.key[0] < 0 ||
        value.key[0] > Number.MAX_SAFE_INTEGER ||
        typeof value.key[1] !== "string" ||
        value.key[1].length > 512
      )
        throw new Error();
      return value;
    } catch {
      throw new Error("Invalid or stale trace cursor. Reload the first page.");
    }
  }

  private cursor(query: string, key: [number, string]): string {
    return Buffer.from(JSON.stringify({ revision: this.revision, query, key })).toString(
      "base64url",
    );
  }

  sessions(input: unknown): SessionPage {
    const args = sessionQuerySchema.parse(input);
    const queryKey = hash(JSON.stringify(["sessions", args.provider, args.query, args.nativeId]));
    const cursor = this.readCursor(args.cursor, queryKey);
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (args.provider) {
      where.push("s.provider=?");
      values.push(args.provider);
    }
    if (args.nativeId) {
      where.push("s.native_id=?");
      values.push(args.nativeId);
    }
    const search = searchExpression(args.query);
    if (search) {
      where.push(
        "s.id IN (SELECT source_id FROM sources_fts WHERE sources_fts MATCH ? UNION SELECT e.source_id FROM events_fts JOIN events e ON e.rowid=events_fts.rowid JOIN sources current ON current.id=e.source_id AND current.visible_generation=e.generation WHERE events_fts MATCH ?)",
      );
      values.push(search, search);
    }
    if (cursor) {
      where.push("(s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))");
      values.push(cursor.key[0], cursor.key[0], cursor.key[1]);
    }
    const rows = this.prepare(
      `SELECT s.summary FROM session_sources s ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.updated_at DESC,s.id DESC LIMIT ?`,
    ).all(...values, args.limit + 1) as { summary: string }[];
    const items = rows.slice(0, args.limit).map((row) => JSON.parse(row.summary) as TraceSession);
    const last = items.at(-1);
    return {
      schemaVersion: 1,
      items,
      nextCursor:
        rows.length > args.limit && last ? this.cursor(queryKey, [last.updatedAt, last.id]) : null,
      revision: this.revision,
    };
  }

  events(input: unknown): EventPage {
    const args = eventQuerySchema.parse(input);
    const source = this.prepare("SELECT visible_generation FROM sources WHERE id=?").get(
      args.sessionId,
    ) as { visible_generation: number } | undefined;
    const queryKey = hash(
      JSON.stringify([
        "events",
        args.sessionId,
        args.kind,
        args.topic,
        args.query,
        args.includeUsage,
        source?.visible_generation,
      ]),
    );
    const cursor = this.readCursor(args.cursor, queryKey);
    const where = ["e.source_id=?", "e.generation=s.visible_generation"];
    const values: (string | number)[] = [args.sessionId];
    if (args.kind) {
      where.push("e.kind=?");
      values.push(args.kind);
    } else if (!args.includeUsage) {
      where.push("e.kind!='usage'");
    }
    if (args.topic) {
      where.push(
        "EXISTS (SELECT 1 FROM event_topics t WHERE t.event_id=e.id AND t.generation=e.generation AND t.topic=?)",
      );
      values.push(args.topic);
    }
    const search = searchExpression(args.query);
    if (search) {
      where.push("e.rowid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)");
      values.push(search);
    }
    if (cursor) {
      if (!/^\d{8}:[a-f0-9]{64}$/.test(cursor.key[1])) throw new Error("Invalid trace cursor.");
      where.push("(e.sequence,e.part,e.id) > (?,?,?)");
      values.push(cursor.key[0], Number(cursor.key[1].slice(0, 8)), cursor.key[1].slice(9));
    }
    const rows = this.prepare(
      `SELECT e.summary FROM events e INDEXED BY ${args.kind ? "events_kind" : "events_timeline"} JOIN sources s ON s.id=e.source_id WHERE ${where.join(" AND ")} ORDER BY e.sequence,e.part,e.id LIMIT ?`,
    ).all(...values, args.limit + 1) as { summary: string }[];
    const items = rows.slice(0, args.limit).map((row) => JSON.parse(row.summary) as TraceEvent);
    const last = items.at(-1);
    return {
      schemaVersion: 1,
      items,
      nextCursor:
        rows.length > args.limit && last
          ? this.cursor(queryKey, [
              last.sequence,
              `${String(last.part).padStart(8, "0")}:${last.id}`,
            ])
          : null,
      revision: this.revision,
    };
  }

  private findEvent(id: string): TraceEvent | null {
    const row = this.prepare(
      "SELECT e.summary FROM events e JOIN sources s ON s.id=e.source_id AND s.visible_generation=e.generation WHERE e.id=?",
    ).get(id) as StoredEvent | undefined;
    return row ? (JSON.parse(row.summary) as TraceEvent) : null;
  }

  async event(input: unknown, signal?: AbortSignal): Promise<EventDetail> {
    const { eventId } = eventInputSchema.parse(input);
    const event = this.findEvent(eventId);
    if (!event)
      return {
        schemaVersion: 1,
        event: null,
        body: null,
        bodyTruncated: false,
        sourceState: "missing",
        message: "The indexed event no longer exists.",
        related: [],
      };
    const span = event.provenance;
    const result = await readVerifiedSpan(
      span.path,
      { offset: span.byteOffset, length: span.byteLength, hash: span.recordHash },
      0,
      Math.min(span.byteLength, MAX_RECORD_BYTES),
      signal,
    );
    const related = event.tool?.callId
      ? (
          this.db
            .prepare(
              "SELECT e.summary FROM events e INDEXED BY events_call JOIN sources s ON s.id=e.source_id AND s.visible_generation=e.generation WHERE e.source_id=? AND e.call_id=? AND e.id!=? ORDER BY e.sequence,e.part LIMIT 20",
            )
            .all(event.sessionId, event.tool.callId, event.id) as { summary: string }[]
        ).map((row) => JSON.parse(row.summary) as TraceEvent)
      : [];
    if (result.state !== "available")
      return {
        schemaVersion: 1,
        event,
        body: null,
        bodyTruncated: false,
        sourceState: result.state,
        message: result.message,
        related,
      };
    if (span.byteLength > MAX_RECORD_BYTES)
      return {
        schemaVersion: 1,
        event,
        body: { type: "text", text: event.preview, format: "plain" },
        bodyTruncated: true,
        sourceState: "available",
        message: "The record is too large for structured display. Use paged Raw access.",
        related,
      };
    let body: EventDetail["body"] = null;
    try {
      const adapter = this.registry.lookup(event.provider);
      body =
        adapter?.parse(JSON.parse(result.bytes.toString("utf8")), {
          path: span.path,
          line: span.line,
        }).events[event.part]?.body ?? null;
    } catch {
      body = { type: "text", text: result.bytes.toString("utf8"), format: "plain" };
    }
    const encoded = JSON.stringify(body);
    const bodyTruncated = Buffer.byteLength(encoded) > BODY_LIMIT;
    if (bodyTruncated)
      body = {
        type: "text",
        text: Buffer.from(encoded).subarray(0, BODY_LIMIT).toString("utf8"),
        format: "plain",
      };
    return {
      schemaVersion: 1,
      event,
      body,
      bodyTruncated,
      sourceState: "available",
      message: bodyTruncated
        ? "Structured display was shortened. Raw contains the complete record."
        : null,
      related,
    };
  }

  async raw(input: unknown, signal?: AbortSignal): Promise<RawPage> {
    const args = rawInputSchema.parse(input);
    const event = this.findEvent(args.eventId);
    if (!event)
      return {
        schemaVersion: 1,
        state: "missing",
        base64: "",
        offset: args.offset,
        totalBytes: 0,
        nextOffset: null,
        message: "The indexed event no longer exists.",
      };
    const span = event.provenance;
    if (args.offset > span.byteLength)
      throw new Error("Raw offset exceeds the source record length.");
    const result = await readVerifiedSpan(
      span.path,
      { offset: span.byteOffset, length: span.byteLength, hash: span.recordHash },
      args.offset,
      args.limit,
      signal,
    );
    const next = args.offset + result.bytes.length;
    return {
      schemaVersion: 1,
      state: result.state,
      base64: result.bytes.toString("base64"),
      offset: args.offset,
      totalBytes: span.byteLength,
      nextOffset: result.state === "available" && next < span.byteLength ? next : null,
      message: result.message,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    await this.scanPromise?.catch(() => undefined);
    this.db.close();
  }
}
