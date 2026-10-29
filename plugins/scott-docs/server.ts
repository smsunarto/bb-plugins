import { proposalSchema, type Proposal } from "./proposals.js";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { isRecord, parseMarkdownDocument } from "./markdown-document.js";
import { DOCS_PATH_LIST_LIMIT, docsHostContract, docsHostSignals } from "./host-contract.js";
import { isExcludedDocsPath } from "./path-policy.js";
import {
  experimental_PluginRpcRefusal,
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  VAULTS_TAG,
  docsRpcContract,
  documentTag,
  errorMessage,
  openedFileTag,
  pathTags,
  requireString,
  syncScopeSchema,
  syncSnapshotEntrySchema,
  syncStateEntrySchema,
  treeTag,
  vaultPathSchema,
  vaultTag,
  type OpenerSource,
  type Vault,
} from "./contract.js";

const DEFAULT_DIR = "~/Notes";
const PREVIEW_LENGTH = 100;
const MAX_TREE_ENTRIES = DOCS_PATH_LIST_LIMIT;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const SYNC_STATE_FILE = ".bb-docs-state.json";
const SYNC_STATE_VERSION = 1;
const MENTION_SUMMARY_TTL_MS = 10_000;
const PREVIEW_RENEW_BEFORE_MS = 2 * 60_000;
// bb drops a mention provider after 2 s; answer with the vaults ready by then.
const MENTION_VAULT_WAIT_MS = 1_500;
const SUMMARY_READ_CONCURRENCY = 8;
const MARKDOWN_PATH = /\.(md|markdown)$/i;
// The tree lists MDX beside Docs documents; bb's file opener handles them.
const TREE_FILE_PATH = /\.(mdx?|markdown|html?)$/i;

class CliUsageError extends PluginCliError {
  constructor(message: string) {
    super(message, { code: "usage_error", exitCode: 2 });
  }
}

const DOCS_DESCRIPTION = [
  "Vaults hold the documents; every path is relative to its vault.",
  "Pull a scope into a workspace directory, edit the files with normal tools, then run status and push.",
].join("\n");

const DOCS_STATUS_DESCRIPTION = [
  "Exit 0: no changes.",
  "Exit 1: the status operation failed.",
  "Exit 2: the command usage is not valid.",
  "Exit 3: local and remote changes conflict.",
  "Exit 4: changes present.",
  "",
  "Exit 4 is a successful status result. Review the output, then run bb docs push separately.",
].join("\n");

const DEPRECATED_MUTATION_WARNING =
  "Deprecated: direct Docs mutations will be removed; use bb docs pull, edit local files, then bb docs push.";

const DEPRECATED_DELETION_WARNING =
  "Deprecated: direct Docs mutations will be removed; use bb docs pull, edit local files, then bb docs push --delete.";

const VAULT_OPTION = {
  type: "string",
  placeholder: "id",
  aliases: ["vault-id", "vaultId"],
  description: "Vault ID from `bb docs vaults`; defaults to the first configured vault",
} as const;

const WORKSPACE_HOST_OPTION = {
  type: "string",
  placeholder: "id",
  aliases: ["host", "host-id"],
  description:
    "Host holding the workspace directory; defaults to the thread environment's host, else the one machine that has the working directory",
} as const;

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const DIFF_OPTION = {
  type: "boolean",
  description: "Include a unified diff for every changed file",
} as const;

const DELETE_OPTION = {
  type: "boolean",
  description: "Also apply local file and empty-directory deletions to the vault",
} as const;

interface SyncCliArgs {
  positionals: string[];
  vaultId: string | undefined;
  into: string | undefined;
  workspaceHostId: string | undefined;
  all: boolean;
  folder: boolean;
  delete: boolean;
  dryRun: boolean;
  diff: boolean;
}

type VaultEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; modifiedAtMs: number; sizeBytes: number };

interface NoteSummary {
  path: string;
  title: string;
  preview: string;
  modifiedAtMs: number;
}

interface ResolvedOpenerFile {
  path: string;
  rootPath: string;
  hostId: string;
}

const syncStateSchema = z
  .object({
    schemaVersion: z.literal(SYNC_STATE_VERSION),
    vault: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
    scope: syncScopeSchema,
    pulledAt: z.iso.datetime(),
    entries: z.array(syncStateEntrySchema).max(MAX_TREE_ENTRIES),
    directories: z.array(vaultPathSchema).max(MAX_TREE_ENTRIES),
  })
  .strict();
type SyncScope = z.infer<typeof syncScopeSchema>;
type SyncStateEntry = z.infer<typeof syncStateEntrySchema>;
type SyncState = z.infer<typeof syncStateSchema>;
type SyncFile = z.infer<typeof syncSnapshotEntrySchema>;

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/")) return path.join(os.homedir(), rawPath.slice(2));
  return rawPath;
}

function requireVaultPath(value: unknown): string {
  const raw = requireString(value, "path").replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw) || raw.includes("\0")) {
    throw new Error(`Invalid vault path: ${raw}`);
  }
  const segments = raw.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    isExcludedDocsPath(raw)
  ) {
    throw new Error(`Invalid vault path: ${raw}`);
  }
  return path.posix.normalize(raw);
}

function requireMarkdownPath(value: unknown): string {
  const normalized = requireVaultPath(value);
  if (!MARKDOWN_PATH.test(normalized)) {
    throw new Error(`Path must end with .md or .markdown: ${normalized}`);
  }
  return normalized;
}

function requireOptionalDirectory(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return requireVaultPath(value);
}

function requireThreadStoragePath(value: unknown): string {
  const raw = requireString(value, "path").replace(/\\/g, "/");
  if (
    path.posix.isAbsolute(raw) ||
    path.win32.isAbsolute(raw) ||
    raw.includes("\0") ||
    raw.split("/").includes("..")
  ) {
    throw new Error(`Invalid thread-storage path: ${raw}`);
  }
  return path.posix.normalize(raw);
}

function absolutePath(vault: Vault, relativePath: string): string {
  const parts = relativePath.split("/");
  return /^[a-zA-Z]:[\\/]/.test(vault.rootPath) || vault.rootPath.startsWith("\\\\")
    ? path.win32.join(vault.rootPath, ...parts)
    : path.posix.join(vault.rootPath, ...parts);
}

function isAbsoluteHostPath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizeHostRoot(value: string): string {
  return path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)
    ? path.win32.normalize(value)
    : path.posix.normalize(value);
}

function syncEntryFromFile(
  relativePath: string,
  file: Awaited<ReturnType<BbPluginApi["sdk"]["files"]["read"]>>,
): SyncStateEntry {
  return {
    remotePath: relativePath,
    localPath: relativePath,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    contentEncoding: file.contentEncoding,
    mimeType: file.mimeType ?? null,
    modifiedAtMs: file.modifiedAtMs ?? null,
  };
}

function cleanLine(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .trim();
}

function markdownHeadingLevel(line: string): number | null {
  const match = line.match(/^\s{0,3}(#{1,6})(?:[\t ]+|$)/);
  return match ? match[1]!.length : null;
}

function summarizeMarkdown(content: string, fallback: string): { title: string; preview: string } {
  const document = parseMarkdownDocument(content);
  const lines = document.body.split("\n");
  const cleanedLines = lines.map(cleanLine);
  const firstContentIndex = cleanedLines.findIndex((line) => line && !line.startsWith("::html{"));
  const documentHeadingIndex = document.frontmatter
    ? lines.findIndex((line) => markdownHeadingLevel(line) === 1)
    : -1;
  const titleLineIndex = document.title
    ? -1
    : documentHeadingIndex >= 0
      ? documentHeadingIndex
      : firstContentIndex;
  const title = (
    document.title ??
    (titleLineIndex >= 0 ? cleanedLines[titleLineIndex] : null) ??
    fallback
  ).slice(0, 120);
  const firstHeadingIndex = lines.findIndex((line) => markdownHeadingLevel(line) !== null);
  const previewHeadingIndex =
    titleLineIndex >= 0
      ? titleLineIndex
      : firstHeadingIndex >= 0 && cleanedLines[firstHeadingIndex] === title
        ? firstHeadingIndex
        : -1;
  const preview = cleanedLines
    .filter(
      (line, index) =>
        index !== previewHeadingIndex && line && line !== title && !line.startsWith("::html{"),
    )
    .join(" ")
    .slice(0, PREVIEW_LENGTH);
  return { title, preview };
}

function deriveTitle(content: string, fallback: string): string {
  return summarizeMarkdown(content, fallback).title;
}

function kebabCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function sanitizeName(raw: string): string {
  return raw
    .replace(/\.(md|markdown|html?)$/i, "")
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function parseVaultRow(value: unknown): Vault {
  const row = requireRecord(value);
  return {
    id: requireString(row.id, "id"),
    name: requireString(row.name, "name"),
    hostId: typeof row.host_id === "string" && row.host_id ? row.host_id : null,
    rootPath: requireString(row.root_path, "root_path"),
  };
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** How long a host keeps watching an opened file without a renewal. */
const OPENED_FILE_LEASE_MS = 180_000;

/** How long after a save the host watcher's report of it counts as its echo. */
const OWN_WRITE_ECHO_MS = 10_000;

export default async function plugin(bb: BbPluginApi) {
  const hostFiles = bb.hosts.experimental_client({
    contract: docsHostContract,
    experimental_signals: docsHostSignals,
  });

  // Opened files outside every vault, by watch id, with the host watching
  // each. A page renews its watch while it shows the file; a change, or the
  // loss of every watch on a restarted worker, reaches it as a realtime event.
  type OpenedFileReader = {
    tag: string;
    sha256: string | null | undefined;
    revision: number;
    wake(): void;
  };
  const openedFileReaders = new Map<string, Set<OpenedFileReader>>();
  const openedFileWatches = new Map<string, string>();
  const offFileSignal = hostFiles.experimental_onSignal("fileChanged", ({ hostId, payload }) => {
    if (openedFileWatches.get(payload.watchId) !== hostId) return;
    bb.realtime.publish("opened-file-changed", payload);
    const tags: string[] = [];
    for (const reader of openedFileReaders.get(payload.watchId) ?? []) {
      if (payload.sha256 === null || reader.sha256 !== payload.sha256) tags.push(reader.tag);
      reader.sha256 = payload.sha256;
      reader.revision += 1;
    }
    invalidate(tags);
  });
  const offFileExit = hostFiles.experimental_onWorkerExit(({ hostId }) => {
    for (const [watchId, watchHostId] of openedFileWatches) {
      if (watchHostId !== hostId) continue;
      openedFileWatches.delete(watchId);
      for (const reader of openedFileReaders.get(watchId) ?? []) {
        reader.sha256 = undefined;
        reader.revision += 1;
        reader.wake();
      }
      // Wake live readers so the restarted host re-arms immediately.
      bb.realtime.publish("opened-file-changed", { watchId });
      invalidate([...(openedFileReaders.get(watchId) ?? [])].map((reader) => reader.tag));
    }
  });
  bb.onDispose(() => {
    offFileSignal();
    offFileExit();
  });

  // The hash of each vault file this server just wrote. The host watcher
  // reports the same write about 250 ms later; announcing it again would make
  // every open document in the vault re-read itself.
  const ownWrites = new Map<string, { sha256: string; at: number }>();
  const rememberWrite = (vaultId: string, relativePath: string, sha256: string) => {
    const now = Date.now();
    for (const [key, write] of ownWrites)
      if (now - write.at > OWN_WRITE_ECHO_MS) ownWrites.delete(key);
    ownWrites.set(`${vaultId}\0${relativePath}`, { sha256, at: now });
  };
  const isOwnEcho = (vaultId: string, change: { path: string; sha256: string | null }) => {
    const key = `${vaultId}\0${change.path}`;
    const write = ownWrites.get(key);
    if (write === undefined || Date.now() - write.at > OWN_WRITE_ECHO_MS) return false;
    if (write.sha256 === change.sha256) return true;
    // Someone else wrote it since, so the same content again is theirs too.
    ownWrites.delete(key);
    return false;
  };
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host_id TEXT,
      root_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS entry_order (
      vault_id TEXT NOT NULL,
      parent_path TEXT NOT NULL,
      child_path TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (vault_id, parent_path, child_path)
    )`,
    `CREATE TABLE IF NOT EXISTS proposals (
      vault_id TEXT NOT NULL,
      path TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (vault_id, path)
    )`,
  ]);

  function hasVaults(): boolean {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM vaults").pluck().get()) !== 0;
  }

  // ~/Notes is the server's home folder, so the vault belongs to the
  // server's own host. Handlers and the watch-vaults service create it, not
  // the factory: bb.sdk can be unbound there on a cold start, and a vault
  // saved without a host would follow a later server move. The folder comes
  // first, so a failure saves nothing and the next call tries again.
  async function ensureDefaultVault(): Promise<void> {
    if (hasVaults()) return;
    const { primaryHostId } = await bb.sdk.system.config();
    if (!primaryHostId) throw new Error("bb has no server machine yet");
    const rootPath = path.resolve(expandHome(DEFAULT_DIR));
    await bb.sdk.files.mkdir({ hostId: primaryHostId, path: rootPath, recursive: true });
    if (hasVaults()) return;
    db.prepare(
      "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("personal", "Personal", primaryHostId, rootPath, Date.now());
    bb.realtime.publish("vault-changed", { vaultId: "personal" });
    invalidate([VAULTS_TAG, vaultTag("personal")]);
  }

  function listVaults(): Vault[] {
    return db
      .prepare("SELECT id, name, host_id, root_path FROM vaults ORDER BY created_at, name")
      .all()
      .map(parseVaultRow);
  }

  function getVault(vaultId?: string): Vault {
    const vaults = listVaults();
    const vault = vaultId ? vaults.find((candidate) => candidate.id === vaultId) : vaults[0];
    if (!vault) throw new Error(vaultId ? `Unknown vault: ${vaultId}` : "No vault configured");
    return vault;
  }

  function listEntryOrder(vaultId: string): string[] {
    return db
      .prepare(
        "SELECT child_path FROM entry_order WHERE vault_id = ? ORDER BY parent_path, position",
      )
      .all(vaultId)
      .map((row) => requireString(requireRecord(row).child_path, "child_path"));
  }

  // Null when bb cannot say; createVault then asks for a machine.
  async function loadPrimaryHostId(): Promise<string | null> {
    try {
      return (await bb.sdk.system.config()).primaryHostId;
    } catch {
      return null;
    }
  }

  // Host names that hold an unbound vault's folder, from the last probe.
  const unboundCandidates = new Map<string, string[]>();

  // Vaults saved before Docs stored a host have NULL, which meant "the
  // server's machine" at the time. After a server move that is another
  // machine, so an unbound vault fails loudly until it is bound.
  function vaultHostId(vault: Vault): string {
    if (vault.hostId) return vault.hostId;
    const candidates = unboundCandidates.get(vault.id) ?? [];
    throw new Error(
      `Choose the machine that holds ${vault.rootPath} for the ${vault.name} vault${
        candidates.length > 0 ? ` (found on ${candidates.join(", ")})` : ""
      }, or run bb docs vault-host ${vault.id} <host-id>.`,
    );
  }

  function hostArgs(vault: Vault): { hostId: string } {
    return { hostId: vaultHostId(vault) };
  }

  type HostRecord = Awaited<ReturnType<typeof bb.sdk.hosts.list>>[number];

  // Probe every connected host for a path. `complete` is false when a host
  // is away or did not answer: it may hold the path too.
  async function hostsHoldingPath(
    hostPath: string,
  ): Promise<{ holders: HostRecord[]; complete: boolean }> {
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.filter((host) => host.status === "connected");
    const probes = await Promise.allSettled(
      connected.map((host) =>
        bb.sdk.hosts.pathsExist({
          hostId: host.id,
          paths: [hostPath],
          signal: AbortSignal.timeout(5_000),
        }),
      ),
    );
    return {
      holders: connected.filter((_, index) => {
        const probe = probes[index]!;
        return probe.status === "fulfilled" && probe.value.existence[hostPath] === true;
      }),
      complete:
        connected.length === hosts.length && probes.every((probe) => probe.status === "fulfilled"),
    };
  }

  function vaultHostChanged(vaultId: string): void {
    unboundCandidates.delete(vaultId);
    mentionSummaries.delete(vaultId);
    bb.realtime.publish("vault-changed", { vaultId });
    invalidate([VAULTS_TAG, vaultTag(vaultId), treeTag(vaultId)]);
  }

  // A NULL-host vault was saved when NULL meant "the server's machine". bb
  // keeps only the last server move, so after several moves no history
  // names that machine. Bind only when the folder is on exactly one machine
  // and every machine answered. Otherwise the user chooses: a guess would
  // read and write another machine's files, and a bound vault is not
  // revisited.
  async function bindLegacyVaults(): Promise<void> {
    const vaults = listVaults().filter((vault) => !vault.hostId);
    await Promise.all(
      vaults.map(async (vault) => {
        const { holders, complete } = await hostsHoldingPath(vault.rootPath);
        const [holder] = holders;
        if (!holder || holders.length !== 1 || !complete) {
          unboundCandidates.set(
            vault.id,
            holders.map((host) => host.name),
          );
          return;
        }
        const bound = db
          .prepare("UPDATE vaults SET host_id = ? WHERE id = ? AND host_id IS NULL")
          .run(holder.id, vault.id);
        if (bound.changes === 0) return;
        vaultHostChanged(vault.id);
        bb.log.info(`bound vault ${vault.id} to host ${holder.id}`);
      }),
    );
  }

  // Docs walks vaults through its own host entry: SDK listings either hide
  // every dot folder or cannot exclude nested tool state such as
  // .claude/worktrees, which path-policy.ts skips without descending.
  function listHostPaths(args: { hostId: string; path: string; signal?: AbortSignal }) {
    return hostFiles.call(
      "listPaths",
      { path: args.path, includeFiles: true, includeDirectories: true, limit: MAX_TREE_ENTRIES },
      { hostId: args.hostId, ...(args.signal ? { signal: args.signal } : {}) },
    );
  }

  function listVaultPaths(vault: Vault, signal?: AbortSignal) {
    return listHostPaths({ hostId: vaultHostId(vault), path: vault.rootPath, signal });
  }

  async function listEntries(
    vault: Vault,
    signal?: AbortSignal,
  ): Promise<{ entries: VaultEntry[]; truncated: boolean }> {
    const result = await listVaultPaths(vault, signal);
    return {
      entries: result.paths
        .filter((entry) => entry.kind === "directory" || TREE_FILE_PATH.test(entry.path))
        .map((entry) => Object.assign(entry, { path: entry.path.replace(/\\/g, "/") })),
      truncated: result.truncated,
    };
  }

  // Summaries survive between listings and are re-read only when a note's
  // modification time or size changes. The key includes the host and root,
  // so a rebound or moved vault starts over.
  const summaryCache = new Map<
    string,
    Map<string, { modifiedAtMs: number; sizeBytes: number; note: NoteSummary }>
  >();

  async function listNoteSummaries(
    vault: Vault,
    knownEntries?: VaultEntry[],
    signal?: AbortSignal,
  ): Promise<NoteSummary[]> {
    const entries = knownEntries ?? (await listEntries(vault, signal)).entries;
    const cacheKey = JSON.stringify([vault.id, vault.hostId, vault.rootPath]);
    const previous = summaryCache.get(cacheKey);
    const next = new Map<string, { modifiedAtMs: number; sizeBytes: number; note: NoteSummary }>();
    const stale: Array<Extract<VaultEntry, { kind: "file" }>> = [];
    for (const entry of entries) {
      if (entry.kind !== "file" || !MARKDOWN_PATH.test(entry.path)) continue;
      const cached = previous?.get(entry.path);
      if (cached?.modifiedAtMs === entry.modifiedAtMs && cached.sizeBytes === entry.sizeBytes) {
        next.set(entry.path, cached);
      } else {
        stale.push(entry);
      }
    }
    let nextIndex = 0;
    // Commit even when aborted: `next` holds only verified notes, so an
    // interrupted pass still saves the reads it finished.
    try {
      await Promise.all(
        Array.from({ length: Math.min(SUMMARY_READ_CONCURRENCY, stale.length) }, async () => {
          while (nextIndex < stale.length) {
            signal?.throwIfAborted();
            const entry = stale[nextIndex++]!;
            try {
              const file = await bb.sdk.files.read({
                ...hostArgs(vault),
                path: absolutePath(vault, entry.path),
                rootPath: vault.rootPath,
                ...(signal ? { signal } : {}),
              });
              const fallback = path.posix.basename(entry.path).replace(MARKDOWN_PATH, "");
              const summary = summarizeMarkdown(file.content, fallback);
              next.set(entry.path, {
                modifiedAtMs: entry.modifiedAtMs,
                sizeBytes: entry.sizeBytes,
                note: {
                  path: entry.path,
                  title: summary.title,
                  preview: summary.preview,
                  modifiedAtMs: entry.modifiedAtMs,
                },
              });
            } catch {}
          }
        }),
      );
    } finally {
      summaryCache.set(cacheKey, next);
    }
    signal?.throwIfAborted();
    return entries
      .flatMap((entry) => {
        const cached = next.get(entry.path);
        return entry.kind === "file" && cached ? [cached.note] : [];
      })
      .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  }

  const mentionSummaries = new Map<
    string,
    {
      rootPath: string;
      hostId: string | null;
      expiresAt: number;
      notes: Promise<NoteSummary[]>;
    }
  >();
  const mentionLifetime = new AbortController();
  const treeSummaries = new Map<string, Map<string, string>>();
  bb.onDispose(() => {
    mentionLifetime.abort();
    mentionSummaries.clear();
  });

  function mentionNoteSummaries(vault: Vault): Promise<NoteSummary[]> {
    const cached = mentionSummaries.get(vault.id);
    if (
      cached &&
      cached.rootPath === vault.rootPath &&
      cached.hostId === vault.hostId &&
      cached.expiresAt > Date.now()
    ) {
      return cached.notes;
    }
    const entry = {
      rootPath: vault.rootPath,
      hostId: vault.hostId,
      expiresAt: Infinity,
      notes: listNoteSummaries(
        vault,
        undefined,
        AbortSignal.any([mentionLifetime.signal, AbortSignal.timeout(MENTION_SUMMARY_TTL_MS)]),
      ),
    };
    entry.notes = entry.notes.then(
      (notes) => {
        entry.expiresAt = Date.now() + MENTION_SUMMARY_TTL_MS;
        return notes;
      },
      (error: unknown) => {
        if (mentionSummaries.get(vault.id) === entry) {
          mentionSummaries.delete(vault.id);
        }
        throw error;
      },
    );
    mentionSummaries.set(vault.id, entry);
    return entry.notes;
  }

  async function notebookData(vaultId?: string) {
    await ensureDefaultVault();
    const vault = getVault(vaultId);
    try {
      const [{ entries, truncated }, hosts] = await Promise.all([
        listEntries(vault),
        bb.sdk.hosts.list(),
      ]);
      const notes = await listNoteSummaries(vault, entries);
      treeSummaries.set(vault.id, new Map(notes.map((note) => [note.path, note.title])));
      return {
        vaults: listVaults(),
        vault,
        hosts,
        entries: entries.map(({ kind, path: entryPath }) => ({ kind, path: entryPath })),
        entryOrder: listEntryOrder(vault.id),
        notes,
        truncated,
        error: null,
      };
    } catch (error) {
      return {
        vaults: listVaults(),
        vault,
        hosts: await bb.sdk.hosts.list().catch(() => []),
        entries: [],
        entryOrder: listEntryOrder(vault.id),
        notes: [],
        truncated: false,
        error: errorMessage(error),
      };
    }
  }

  async function readFile(vaultId: string | undefined, rawPath: unknown) {
    const vault = getVault(vaultId);
    const relativePath = requireVaultPath(rawPath);
    const file = await bb.sdk.files.read({
      ...hostArgs(vault),
      path: absolutePath(vault, relativePath),
      rootPath: vault.rootPath,
    });
    return { ...file, path: relativePath };
  }

  async function writeFile(args: {
    vaultId?: string;
    rawPath: unknown;
    content: unknown;
    contentEncoding?: "utf8" | "base64";
    expectedSha256?: unknown;
    createOnly?: boolean;
  }) {
    const vault = getVault(args.vaultId);
    const relativePath = requireVaultPath(args.rawPath);
    if (typeof args.content !== "string") throw new Error('"content" must be a string');
    const result = await bb.sdk.files.write({
      ...hostArgs(vault),
      path: absolutePath(vault, relativePath),
      rootPath: vault.rootPath,
      content: args.content,
      contentEncoding: args.contentEncoding ?? "utf8",
      createParents: true,
      ...(args.createOnly
        ? { expectedSha256: null }
        : args.expectedSha256 === null || typeof args.expectedSha256 === "string"
          ? { expectedSha256: args.expectedSha256 }
          : {}),
    });
    if (result.outcome === "written") {
      mentionSummaries.delete(vault.id);
      rememberWrite(vault.id, relativePath, result.sha256);
      invalidate([
        ...pathTags(vault.id, relativePath),
        ...(treeChangedBy(vault.id, relativePath, args.content, args.contentEncoding)
          ? [treeTag(vault.id)]
          : []),
      ]);
      // The hash lets the session that saved skip re-reading its own write.
      bb.realtime.publish("vault-changed", {
        vaultId: vault.id,
        path: relativePath,
        sha256: result.sha256,
      });
    }
    return result;
  }

  function invalidate(tags: string[]): void {
    if (tags.length > 0) bb.rpc.experimental_invalidate([...new Set(tags)]);
  }

  function treeChangedBy(
    vaultId: string,
    relativePath: string,
    content: string,
    contentEncoding: "utf8" | "base64" | undefined,
  ): boolean {
    if (!MARKDOWN_PATH.test(relativePath) || contentEncoding === "base64") return false;
    const summaries = treeSummaries.get(vaultId);
    if (!summaries) return true;
    const next = deriveTitle(
      content,
      path.posix.basename(relativePath).replace(/\.(md|markdown)$/i, ""),
    );
    if (summaries.get(relativePath) === next) return false;
    summaries.set(relativePath, next);
    return true;
  }

  const vaultOperations = new Map<string, Promise<unknown>>();

  async function serializeVault<T>(vaultId: string, work: () => Promise<T>): Promise<T> {
    const key = vaultId;
    const previous = vaultOperations.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => {
        getVault(vaultId);
        return work();
      });
    vaultOperations.set(key, current);
    try {
      return await current;
    } finally {
      if (vaultOperations.get(key) === current) vaultOperations.delete(key);
    }
  }

  function readProposal(vaultId: string, relativePath: string): Proposal | null {
    const row = db
      .prepare("SELECT data FROM proposals WHERE vault_id = ? AND path = ?")
      .get(vaultId, relativePath);
    if (!row) return null;
    const data = z.object({ data: z.string() }).parse(row);
    return proposalSchema.parse(JSON.parse(data.data));
  }

  function saveProposal(proposal: Proposal): Proposal {
    db.prepare(
      "INSERT INTO proposals (vault_id, path, data) VALUES (?, ?, ?) ON CONFLICT(vault_id, path) DO UPDATE SET data = excluded.data",
    ).run(proposal.vaultId, proposal.path, JSON.stringify(proposal));
    invalidate([documentTag(proposal.vaultId, proposal.path)]);
    return proposal;
  }

  function requireProposal(
    vaultId: string,
    relativePath: string,
    expectedVersion: number,
  ): Proposal {
    const proposal = readProposal(vaultId, relativePath);
    if (!proposal || proposal.version !== expectedVersion) {
      throw new Error("The proposal changed. Read it again before continuing.");
    }
    return proposal;
  }

  // bb names a thread's host file by its environment (or thread), not by
  // host id: the path is absolute on that thread's machine. The primary host
  // is the server's, which is a different disk when the thread runs elsewhere.
  async function openerHostId(source: OpenerSource): Promise<string> {
    if (source.experimental_hostId) return source.experimental_hostId;
    const environmentId =
      source.environmentId ??
      (source.threadId
        ? (await bb.sdk.threads.get({ threadId: source.threadId })).environmentId
        : null);
    if (!environmentId) throw new Error("Cannot resolve the machine that holds this file");
    return (await bb.sdk.environments.get({ environmentId })).hostId;
  }

  async function resolveOpenerFile(
    source: OpenerSource,
    pathValue: unknown,
  ): Promise<ResolvedOpenerFile> {
    const filePath = requireString(pathValue, "path");
    if (source.kind === "host") {
      if (!isAbsoluteHostPath(filePath)) {
        throw new Error("Host file paths must be absolute");
      }
      const normalized = normalizeHostRoot(filePath);
      const pathApi = path.win32.isAbsolute(normalized) ? path.win32 : path.posix;
      return {
        path: normalized,
        rootPath: pathApi.dirname(normalized),
        hostId: await openerHostId(source),
      };
    }
    if (source.kind === "workspace" && source.environmentId) {
      const environment = await bb.sdk.environments.get({
        environmentId: source.environmentId,
      });
      if (!environment.path) {
        throw new Error("This environment has no workspace path");
      }
      return {
        path: path.join(environment.path, filePath),
        rootPath: environment.path,
        hostId: environment.hostId,
      };
    }
    if (source.kind === "workspace" && source.projectId) {
      const hostId = source.experimental_hostId ?? (await bb.sdk.system.config()).primaryHostId;
      if (!hostId) {
        throw new Error("This bb has no server machine yet");
      }
      const project = await bb.sdk.projects.get({
        projectId: source.projectId,
      });
      const matchingSources = project.sources.filter(
        (projectSource) => projectSource.hostId === hostId,
      );
      const [projectSource] = matchingSources;
      if (!projectSource) {
        throw new Error(
          source.experimental_hostId
            ? "This project has no workspace on the selected host"
            : "This project has no workspace on the server machine",
        );
      }
      if (matchingSources.length > 1) {
        throw new Error("This project has multiple workspaces on that host");
      }
      const rootPath = normalizeHostRoot(projectSource.path);
      if (!isAbsoluteHostPath(rootPath)) {
        throw new Error("This project has no absolute workspace path");
      }
      return {
        path: hostPathApi(rootPath).join(rootPath, ...filePath.split("/")),
        rootPath,
        hostId,
      };
    }
    if (source.kind === "thread-storage") {
      if (!source.threadId) {
        throw new Error("Thread-storage files require a thread ID");
      }
      const relativePath = requireThreadStoragePath(filePath);
      const storage = await bb.sdk.threads.storageLocation({
        threadId: source.threadId,
      });
      if (!isAbsoluteHostPath(storage.storageRootPath)) {
        throw new Error("This thread has no absolute storage path");
      }
      const rootPath = normalizeHostRoot(storage.storageRootPath);
      return {
        path: hostPathApi(rootPath).join(rootPath, ...relativePath.split("/")),
        rootPath,
        hostId: storage.hostId,
      };
    }
    throw new Error("Docs can open workspace, host, and thread-storage files only");
  }

  async function createNote(vaultId: string | undefined, input: Record<string, unknown>) {
    const vault = getVault(vaultId);
    const parent = requireOptionalDirectory(input.parent);
    const base = sanitizeName(typeof input.name === "string" ? input.name : "") || "Untitled";
    const { entries } = await listEntries(vault);
    const existing = new Set(entries.map((entry) => entry.path.toLowerCase()));
    let relativePath = parent ? `${parent}/${base}.md` : `${base}.md`;
    let counter = 2;
    while (existing.has(relativePath.toLowerCase())) {
      relativePath = parent ? `${parent}/${base} ${counter}.md` : `${base} ${counter}.md`;
      counter += 1;
    }
    await writeFile({
      vaultId: vault.id,
      rawPath: relativePath,
      content: typeof input.content === "string" ? input.content : "",
      createOnly: true,
    });
    return { path: relativePath };
  }

  async function movePath(vaultId: string | undefined, fromValue: unknown, toValue: unknown) {
    const vault = getVault(vaultId);
    const from = requireVaultPath(fromValue);
    const to = requireVaultPath(toValue);
    return serializeVault(vault.id, () => moveWithinVault(vault, from, to));
  }

  async function moveWithinVault(vault: Vault, from: string, to: string) {
    await bb.sdk.files.move({
      ...hostArgs(vault),
      sourcePath: absolutePath(vault, from),
      destinationPath: absolutePath(vault, to),
      rootPath: vault.rootPath,
    });
    db.transaction(() => {
      const rows = db
        .prepare(
          "SELECT data FROM proposals WHERE vault_id = ? AND (path = ? OR substr(path, 1, length(?)) = ?)",
        )
        .all(vault.id, from, `${from}/`, `${from}/`);
      deleteProposals(vault.id, from);
      deleteProposals(vault.id, to);
      const insert = db.prepare("INSERT INTO proposals (vault_id, path, data) VALUES (?, ?, ?)");
      for (const row of rows) {
        const { data } = z.object({ data: z.string() }).parse(row);
        const proposal = proposalSchema.parse(JSON.parse(data));
        proposal.path = to + proposal.path.slice(from.length);
        insert.run(vault.id, proposal.path, JSON.stringify(proposal));
      }
    })();
    mentionSummaries.delete(vault.id);
    treeSummaries.delete(vault.id);
    invalidate([treeTag(vault.id), ...pathTags(vault.id, from), ...pathTags(vault.id, to)]);
    return { path: to };
  }

  function deleteProposals(vaultId: string, relativePath: string) {
    db.prepare(
      "DELETE FROM proposals WHERE vault_id = ? AND (path = ? OR substr(path, 1, length(?)) = ?)",
    ).run(vaultId, relativePath, `${relativePath}/`, `${relativePath}/`);
  }

  async function removePath(
    vaultId: string | undefined,
    rawPath: unknown,
    recursive = false,
  ): Promise<{ ok: true }> {
    const vault = getVault(vaultId);
    const relativePath = requireVaultPath(rawPath);
    return serializeVault(vault.id, async () => {
      await bb.sdk.files.remove({
        ...hostArgs(vault),
        path: absolutePath(vault, relativePath),
        rootPath: vault.rootPath,
        recursive,
      });
      deleteProposals(vault.id, relativePath);
      mentionSummaries.delete(vault.id);
      treeSummaries.get(vault.id)?.delete(relativePath);
      invalidate([treeTag(vault.id), ...pathTags(vault.id, relativePath)]);
      return { ok: true };
    });
  }

  function scopeContains(scope: SyncScope, relativePath: string): boolean {
    if (scope.kind === "all") return true;
    if (scope.kind === "file") return relativePath === scope.path;
    return relativePath === scope.path || relativePath.startsWith(`${scope.path}/`);
  }

  function isMissingFileError(error: unknown): boolean {
    const message = errorMessage(error);
    return /\bENOENT\b|path does not exist|not found/i.test(message);
  }

  async function readExistingFile(
    vault: Vault,
    relativePath: string,
  ): Promise<Awaited<ReturnType<typeof bb.sdk.files.read>> | null> {
    try {
      return await bb.sdk.files.read({
        ...hostArgs(vault),
        path: absolutePath(vault, relativePath),
        rootPath: vault.rootPath,
      });
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async function syncSnapshot(vaultId: string | undefined, scope: SyncScope) {
    const vault = getVault(vaultId);
    const normalizedScope: SyncScope =
      scope.kind === "all" ? scope : { kind: scope.kind, path: requireVaultPath(scope.path) };
    const files: SyncFile[] = [];
    const directories: string[] = [];
    if (normalizedScope.kind === "file") {
      const file = await readFile(vault.id, normalizedScope.path);
      files.push({
        ...syncEntryFromFile(normalizedScope.path, file),
        content: file.content,
      });
    } else {
      const result = await listVaultPaths(vault);
      if (result.truncated) {
        throw new Error(`Sync scope exceeds ${MAX_TREE_ENTRIES} entries; narrow the folder scope`);
      }
      const accessible = result.paths
        .map((entry) => ({
          kind: entry.kind,
          path: entry.path.replace(/\\/g, "/"),
        }))
        .filter((entry) => {
          try {
            requireVaultPath(entry.path);
            return scopeContains(normalizedScope, entry.path);
          } catch {
            return false;
          }
        })
        .sort((left, right) => left.path.localeCompare(right.path));
      if (
        normalizedScope.kind === "folder" &&
        !accessible.some(
          (entry) =>
            entry.path === normalizedScope.path ||
            entry.path.startsWith(`${normalizedScope.path}/`),
        )
      ) {
        throw new Error(`Folder does not exist: ${normalizedScope.path}`);
      }
      for (const entry of accessible) {
        if (entry.kind === "directory") {
          directories.push(entry.path);
          continue;
        }
        const file = await readFile(vault.id, entry.path);
        files.push({
          ...syncEntryFromFile(entry.path, file),
          content: file.content,
        });
      }
    }
    const folded = new Map<string, string>();
    for (const entry of [...directories, ...files.map((file) => file.localPath)]) {
      const collision = folded.get(entry.toLowerCase());
      if (collision && collision !== entry) {
        throw new Error(
          `Vault paths ${JSON.stringify(collision)} and ${JSON.stringify(entry)} collide on case-insensitive filesystems`,
        );
      }
      folded.set(entry.toLowerCase(), entry);
    }
    return { vault, scope: normalizedScope, files, directories };
  }

  async function syncApply(input: {
    vaultId?: string;
    writes: Array<{
      path: string;
      content: string;
      contentEncoding: "base64" | "utf8";
      expectedSha256: string | null;
    }>;
    deletes: Array<{ path: string; expectedSha256: string }>;
    directories: string[];
    deleteDirectories: string[];
    dryRun: boolean;
  }) {
    const vault = getVault(input.vaultId);
    const writes = input.writes.map((write) => ({
      ...write,
      path: requireVaultPath(write.path),
    }));
    const deletes = input.deletes.map((deletion) => ({
      ...deletion,
      path: requireVaultPath(deletion.path),
    }));
    const directories = input.directories.map((directory) => requireVaultPath(directory));
    const deleteDirectories = input.deleteDirectories.map((directory) =>
      requireVaultPath(directory),
    );
    type SyncTreeEntry = {
      path: string;
      kind: "directory" | "file";
      operation: string;
    };
    const assertValidTree = (entries: SyncTreeEntry[], label: string): void => {
      const folded = new Map<string, SyncTreeEntry>();
      const files = new Set<string>();
      for (const entry of entries) {
        const key = entry.path.toLowerCase();
        const existing = folded.get(key);
        if (existing) {
          throw new Error(
            `${label} paths ${JSON.stringify(existing.path)} (${existing.operation}) and ${JSON.stringify(entry.path)} (${entry.operation}) collide`,
          );
        }
        folded.set(key, entry);
        if (entry.kind === "file") files.add(key);
      }
      for (const entry of entries) {
        const parts = entry.path.toLowerCase().split("/");
        for (let index = 1; index < parts.length; index += 1) {
          const ancestor = parts.slice(0, index).join("/");
          if (files.has(ancestor)) {
            throw new Error(`${label} path ${JSON.stringify(entry.path)} is nested beneath a file`);
          }
        }
      }
    };
    assertValidTree(
      [
        ...writes.map((write) => ({
          path: write.path,
          kind: "file" as const,
          operation: "write",
        })),
        ...deletes.map((deletion) => ({
          path: deletion.path,
          kind: "file" as const,
          operation: "delete",
        })),
        ...directories.map((directory) => ({
          path: directory,
          kind: "directory" as const,
          operation: "create directory",
        })),
        ...deleteDirectories.map((directory) => ({
          path: directory,
          kind: "directory" as const,
          operation: "delete directory",
        })),
      ],
      "Sync request",
    );
    const currentListing = await listVaultPaths(vault);
    if (currentListing.truncated) {
      throw new Error(`Vault exceeds ${MAX_TREE_ENTRIES} entries; narrow the sync scope`);
    }
    const currentEntries: SyncTreeEntry[] = currentListing.paths.map((entry) => ({
      path: requireVaultPath(entry.path.replace(/\\/g, "/")),
      kind: entry.kind,
      operation: "existing vault entry",
    }));
    assertValidTree(currentEntries, "Vault");
    const currentByPath = new Map(currentEntries.map((entry) => [entry.path, entry]));
    const fileDeletes = new Set(deletes.map((deletion) => deletion.path));
    const directoryDeletes = new Set(deleteDirectories);
    const writePaths = new Set(writes.map((write) => write.path));
    for (const directory of deleteDirectories) {
      if (
        writes.some((write) => write.path.startsWith(`${directory}/`)) ||
        directories.some(
          (candidate) => candidate === directory || candidate.startsWith(`${directory}/`),
        )
      ) {
        throw new Error(
          `Sync request both deletes ${JSON.stringify(directory)} and creates content beneath it`,
        );
      }
      const remainingChild = currentEntries.find(
        (entry) =>
          entry.path.startsWith(`${directory}/`) &&
          !fileDeletes.has(entry.path) &&
          !directoryDeletes.has(entry.path),
      );
      if (remainingChild) {
        throw new Error(
          `Directory ${JSON.stringify(directory)} is not empty; ${JSON.stringify(remainingChild.path)} is not scheduled for deletion`,
        );
      }
    }
    const futureEntries = currentEntries.filter((entry) => {
      if (entry.kind === "file") {
        return !fileDeletes.has(entry.path) && !writePaths.has(entry.path);
      }
      return !directoryDeletes.has(entry.path);
    });
    for (const directory of directories) {
      if (currentByPath.get(directory)?.kind !== "directory") {
        futureEntries.push({
          path: directory,
          kind: "directory",
          operation: "create directory",
        });
      }
    }
    for (const write of writes) {
      futureEntries.push({
        path: write.path,
        kind: "file",
        operation: "write",
      });
    }
    assertValidTree(futureEntries, "Resulting vault");
    const conflicts: Array<{
      path: string;
      expectedSha256: string | null;
      currentSha256: string | null;
    }> = [];
    for (const mutation of [...writes, ...deletes]) {
      const current = await readExistingFile(vault, mutation.path);
      if ((current?.sha256 ?? null) !== mutation.expectedSha256) {
        conflicts.push({
          path: mutation.path,
          expectedSha256: mutation.expectedSha256,
          currentSha256: current?.sha256 ?? null,
        });
      }
    }
    if (conflicts.length > 0) {
      return {
        outcome: "conflict" as const,
        written: [],
        deleted: [],
        createdDirectories: [],
        deletedDirectories: [],
        conflicts,
        errors: [],
      };
    }
    if (input.dryRun) {
      return {
        outcome: "applied" as const,
        written: [],
        deleted: [],
        createdDirectories: [],
        deletedDirectories: [],
        conflicts: [],
        errors: [],
      };
    }
    const written: SyncStateEntry[] = [];
    const deleted: string[] = [];
    const createdDirectories: string[] = [];
    const deletedDirectories: string[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    for (const directory of [...directories].sort()) {
      if (currentByPath.get(directory)?.kind === "directory") continue;
      try {
        await bb.sdk.files.mkdir({
          ...hostArgs(vault),
          path: absolutePath(vault, directory),
          rootPath: vault.rootPath,
          recursive: true,
        });
        createdDirectories.push(directory);
      } catch (error) {
        errors.push({
          path: directory,
          message: errorMessage(error),
        });
      }
    }
    for (const write of writes) {
      try {
        const result = await writeFile({
          vaultId: vault.id,
          rawPath: write.path,
          content: write.content,
          contentEncoding: write.contentEncoding,
          expectedSha256: write.expectedSha256,
          createOnly: write.expectedSha256 === null,
        });
        if (result.outcome === "conflict") {
          conflicts.push({
            path: write.path,
            expectedSha256: write.expectedSha256,
            currentSha256: result.currentSha256,
          });
          continue;
        }
        const refreshed = await readFile(vault.id, write.path);
        written.push(syncEntryFromFile(write.path, refreshed));
      } catch (error) {
        errors.push({
          path: write.path,
          message: errorMessage(error),
        });
      }
    }
    for (const deletion of deletes) {
      try {
        const current = await readExistingFile(vault, deletion.path);
        if (current?.sha256 !== deletion.expectedSha256) {
          conflicts.push({
            path: deletion.path,
            expectedSha256: deletion.expectedSha256,
            currentSha256: current?.sha256 ?? null,
          });
          continue;
        }
        await removePath(vault.id, deletion.path, false);
        deleted.push(deletion.path);
      } catch (error) {
        errors.push({
          path: deletion.path,
          message: errorMessage(error),
        });
      }
    }
    for (const directory of [...deleteDirectories].sort(
      (left, right) =>
        right.split("/").length - left.split("/").length || right.localeCompare(left),
    )) {
      try {
        await removePath(vault.id, directory, false);
        deletedDirectories.push(directory);
      } catch (error) {
        if (isMissingFileError(error)) continue;
        errors.push({
          path: directory,
          message: errorMessage(error),
        });
      }
    }
    const appliedCount =
      written.length + deleted.length + createdDirectories.length + deletedDirectories.length;
    if (createdDirectories.length > 0) invalidate([treeTag(vault.id)]);
    return {
      outcome:
        errors.length > 0 || (conflicts.length > 0 && appliedCount > 0)
          ? ("partial" as const)
          : conflicts.length > 0
            ? ("conflict" as const)
            : ("applied" as const),
      written,
      deleted,
      createdDirectories,
      deletedDirectories,
      conflicts,
      errors,
    };
  }

  const previewLeases = new Map<string, Promise<{ baseUrl: string; expiresAtMs: number }>>();

  function previewLease(vault: Vault) {
    return targetPreviewLease({ hostId: vaultHostId(vault), rootPath: vault.rootPath });
  }

  async function targetPreviewLease(target: {
    hostId: string;
    rootPath: string;
  }): Promise<{ baseUrl: string; expiresAtMs: number }> {
    const key = JSON.stringify([target.hostId, target.rootPath]);
    const cached = previewLeases.get(key);
    if (cached) {
      const lease = await cached.catch(() => null);
      if (lease && lease.expiresAtMs - Date.now() > PREVIEW_RENEW_BEFORE_MS) return lease;
      if (previewLeases.get(key) !== cached) return targetPreviewLease(target);
    }
    const next = bb.sdk.files.createPreview(target);
    previewLeases.set(key, next);
    next.catch(() => {
      if (previewLeases.get(key) === next) previewLeases.delete(key);
    });
    return next;
  }

  function openedWatchId(target: { hostId: string; path: string }) {
    return createHash("sha256")
      .update(`${target.hostId}\0${target.path}`)
      .digest("hex")
      .slice(0, 32);
  }

  async function watchOpenedTarget(target: { hostId: string; path: string }, signal?: AbortSignal) {
    const watchId = openedWatchId(target);
    openedFileWatches.set(watchId, target.hostId);
    const { sha256 } = await hostFiles.call(
      "watchFile",
      {
        watchId,
        path: target.path,
        leaseMs: OPENED_FILE_LEASE_MS,
      },
      { hostId: target.hostId, ...(signal ? { signal } : {}) },
    );
    return { watchId, sha256, renewWithinMs: OPENED_FILE_LEASE_MS / 3 };
  }

  async function titleRenameTarget(
    vault: Vault,
    currentPath: string,
    content: string,
  ): Promise<string | null> {
    if (!/^untitled(?: \d+)?\.(md|markdown)$/i.test(path.posix.basename(currentPath))) return null;
    if (parseMarkdownDocument(content).title) return null;
    const base = kebabCase(deriveTitle(content, ""));
    if (!base) return null;
    const parent = path.posix.dirname(currentPath);
    const extension = path.posix.extname(currentPath);
    const desired = parent === "." ? `${base}${extension}` : `${parent}/${base}${extension}`;
    if (desired.toLowerCase() === currentPath.toLowerCase()) return null;
    return (await readExistingFile(vault, desired)) === null ? desired : null;
  }

  const handlers: PluginRpcHandlers<typeof docsRpcContract> = {
    async readProposal(input) {
      return readProposal(getVault(input.vaultId).id, input.path);
    },
    async proposeNote(input) {
      const vaultId = getVault(input.vaultId).id;
      return serializeVault(vaultId, async () => {
        const previous = readProposal(vaultId, input.path);
        if ((previous?.version ?? null) !== input.expectedVersion) {
          throw new Error("The proposal changed. Read it again before proposing changes.");
        }
        const file = await readFile(vaultId, input.path);
        if (file.contentEncoding !== "utf8" || file.sha256 !== input.expectedSha256) {
          throw new Error("The document changed. Read it again before proposing changes.");
        }
        return saveProposal({
          vaultId,
          path: input.path,
          version: (previous?.version ?? 0) + 1,
          baseContent: file.content,
          baseSha256: file.sha256,
          content: input.content,
          status: "pending",
          resolvedSha256: null,
        });
      });
    },
    async updateProposal(input) {
      const vaultId = getVault(input.vaultId).id;
      return serializeVault(vaultId, async () => {
        const proposal = requireProposal(vaultId, input.path, input.expectedVersion);
        if (proposal.status !== "pending") throw new Error("This proposal is no longer pending.");
        return saveProposal({
          ...proposal,
          content: input.content,
          version: proposal.version + 1,
        });
      });
    },
    async resolveProposal(input) {
      const vaultId = getVault(input.vaultId).id;
      return serializeVault(vaultId, async () => {
        const proposal = requireProposal(vaultId, input.path, input.expectedVersion);
        const status = (
          {
            accept: proposal.status === "pending" ? "accepted" : null,
            reject: proposal.status === "pending" ? "rejected" : null,
            undo:
              proposal.status === "accepted"
                ? "undone"
                : proposal.status === "rejected"
                  ? "pending"
                  : null,
            redo: proposal.status === "undone" ? "pending" : null,
          } as const
        )[input.action];
        if (!status)
          throw new Error(
            input.action === "undo"
              ? "Nothing to undo."
              : input.action === "redo"
                ? "Nothing to redo."
                : "This proposal is no longer pending.",
          );
        const next = { ...proposal, status, version: proposal.version + 1 };
        const restoring = status === "undone";
        const conflictMessage = restoring
          ? "The document changed. Undo would overwrite newer edits."
          : "The document changed. Ask for an updated proposal.";
        if (status === "accepted" || restoring) {
          const expectedSha256 = restoring ? proposal.resolvedSha256 : proposal.baseSha256;
          if (!expectedSha256) throw new Error("Nothing to undo.");
          const result = await writeFile({
            vaultId,
            rawPath: input.path,
            content: restoring ? proposal.baseContent : proposal.content,
            expectedSha256,
          });
          if (result.outcome === "conflict") throw new Error(conflictMessage);
          next.resolvedSha256 = result.sha256;
        } else if (status === "pending") {
          const file = await readFile(vaultId, input.path);
          if (file.sha256 !== proposal.baseSha256) throw new Error(conflictMessage);
        }
        return saveProposal(next);
      });
    },
    async syncSnapshot(input) {
      return syncSnapshot(input.vaultId, input.scope);
    },
    async syncApply(input) {
      return syncApply(input);
    },
    async listNotes(input) {
      return notebookData(input.vaultId);
    },
    async readNote(input) {
      return readFile(input.vaultId, input.path);
    },
    async readDocument(input) {
      const vault = getVault(input.vaultId);
      return serializeVault(vault.id, async () => {
        const [file, preview] = await Promise.all([
          readFile(vault.id, input.path).catch((error: unknown) => {
            if (!isMissingFileError(error)) throw error;
            throw new experimental_PluginRpcRefusal({
              code: "not_found",
              message: `Path does not exist: ${input.path}`,
            });
          }),
          previewLease(vault),
        ]);
        return {
          vaultId: vault.id,
          path: input.path,
          content: file.content,
          sha256: file.sha256,
          proposal: readProposal(vault.id, input.path),
          preview,
        };
      });
    },
    async saveDocument(input) {
      const vault = getVault(input.vaultId);
      return serializeVault(vault.id, async () => {
        const result = await writeFile({
          vaultId: vault.id,
          rawPath: input.path,
          content: input.content,
          expectedSha256: input.expectedSha256,
        });
        if (result.outcome === "conflict")
          throw new experimental_PluginRpcRefusal({
            code: "conflict",
            message: "This document changed elsewhere.",
          });
        const destination = input.renameToTitle
          ? await titleRenameTarget(vault, input.path, input.content)
          : null;
        if (destination === null) return { path: input.path, sha256: result.sha256 };
        await moveWithinVault(vault, input.path, destination);
        return { path: destination, sha256: result.sha256 };
      });
    },
    async saveNote(input) {
      return serializeVault(getVault(input.vaultId).id, () =>
        writeFile({
          vaultId: input.vaultId,
          rawPath: input.path,
          content: input.content,
          expectedSha256: input.expectedSha256,
        }),
      );
    },
    async createNote(input) {
      return createNote(input.vaultId, input);
    },
    async deletePath(input) {
      return removePath(input.vaultId, input.path, input.recursive === true);
    },
    async createFolder(input) {
      const vault = getVault(input.vaultId);
      const relativePath = requireVaultPath(input.path);
      await bb.sdk.files.mkdir({
        ...hostArgs(vault),
        path: absolutePath(vault, relativePath),
        rootPath: vault.rootPath,
        recursive: false,
      });
      invalidate([treeTag(vault.id)]);
      return { path: relativePath };
    },
    async reorderFiles(input) {
      const vault = getVault(input.vaultId);
      const parent = requireOptionalDirectory(input.parent);
      const paths = input.paths.map((value) => requireVaultPath(value));
      if (new Set(paths).size !== paths.length) {
        throw new Error('"paths" must not contain duplicates');
      }
      if (
        paths.some(
          (filePath) =>
            path.posix.dirname(filePath) !== (parent || ".") || !TREE_FILE_PATH.test(filePath),
        )
      ) {
        throw new Error('Every ordered path must be a file in "parent"');
      }
      const currentFiles = (await listEntries(vault)).entries
        .filter(
          (entry) => entry.kind === "file" && path.posix.dirname(entry.path) === (parent || "."),
        )
        .map((entry) => entry.path);
      if (
        paths.length !== currentFiles.length ||
        currentFiles.some((filePath) => !paths.includes(filePath))
      ) {
        throw new Error("Files changed while reordering; refresh and try again");
      }
      const replaceOrder = db.transaction(() => {
        db.prepare("DELETE FROM entry_order WHERE vault_id = ? AND parent_path = ?").run(
          vault.id,
          parent,
        );
        const insert = db.prepare(
          "INSERT INTO entry_order (vault_id, parent_path, child_path, position) VALUES (?, ?, ?, ?)",
        );
        paths.forEach((filePath, position) => insert.run(vault.id, parent, filePath, position));
      });
      replaceOrder();
      invalidate([treeTag(vault.id)]);
      return { paths };
    },
    async movePath(input) {
      return movePath(input.vaultId, input.from, input.to);
    },
    async renameToTitle(input) {
      const vaultId = input.vaultId;
      const currentPath = requireMarkdownPath(input.path);
      const file = await readFile(vaultId, currentPath);
      if (parseMarkdownDocument(file.content).title) {
        return { path: currentPath };
      }
      const base = kebabCase(deriveTitle(file.content, ""));
      if (!base) return { path: currentPath };
      const parent = path.posix.dirname(currentPath);
      const extension = path.posix.extname(currentPath);
      const desired = parent === "." ? `${base}${extension}` : `${parent}/${base}${extension}`;
      if (desired.toLowerCase() === currentPath.toLowerCase()) return { path: currentPath };
      try {
        return await movePath(vaultId, currentPath, desired);
      } catch {
        return { path: currentPath };
      }
    },
    async createVault(input) {
      const name = requireString(input.name, "name");
      const rootPath = requireString(input.rootPath, "rootPath");
      if (!isAbsoluteHostPath(rootPath)) throw new Error('"rootPath" must be absolute');
      // Store a concrete host: "the server's machine" changes when the server moves.
      const hostId = optionalString(input.hostId) ?? (await loadPrimaryHostId());
      if (!hostId) throw new Error("Choose the machine that holds the vault folder");
      const resolvedRoot = normalizeHostRoot(rootPath);
      await bb.sdk.files.mkdir({
        hostId,
        path: resolvedRoot,
        recursive: true,
      });
      const baseId = kebabCase(name) || "vault";
      const ids = new Set(listVaults().map((vault) => vault.id));
      let id = baseId;
      let counter = 2;
      while (ids.has(id)) id = `${baseId}-${counter++}`;
      db.prepare(
        "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, name, hostId, resolvedRoot, Date.now());
      invalidate([VAULTS_TAG, vaultTag(id)]);
      return getVault(id);
    },
    async setVaultHost(input) {
      const vault = getVault(input.vaultId);
      const host = (await bb.sdk.hosts.list()).find((candidate) => candidate.id === input.hostId);
      if (!host) throw new Error(`Unknown machine: ${input.hostId}`);
      // Refuse a machine that answers without the folder. One that is away
      // is allowed: Docs reads nothing there until it connects and lists it.
      const probe =
        host.status === "connected"
          ? await bb.sdk.hosts
              .pathsExist({
                hostId: host.id,
                paths: [vault.rootPath],
                signal: AbortSignal.timeout(5_000),
              })
              .catch(() => null)
          : null;
      if (probe?.existence[vault.rootPath] === false) {
        throw new Error(`${host.name} has no folder at ${vault.rootPath}`);
      }
      return serializeVault(vault.id, async () => {
        db.prepare("UPDATE vaults SET host_id = ? WHERE id = ?").run(input.hostId, vault.id);
        vaultHostChanged(vault.id);
        return getVault(vault.id);
      });
    },
    async removeVault(input) {
      const id = requireString(input.vaultId, "vaultId");
      return serializeVault(id, async () => {
        if (listVaults().length <= 1) throw new Error("At least one vault is required");
        db.transaction(() => {
          db.prepare("DELETE FROM proposals WHERE vault_id = ?").run(id);
          db.prepare("DELETE FROM entry_order WHERE vault_id = ?").run(id);
          db.prepare("DELETE FROM vaults WHERE id = ?").run(id);
        })();
        mentionSummaries.delete(id);
        treeSummaries.delete(id);
        invalidate([VAULTS_TAG, treeTag(id)]);
        return { ok: true as const };
      });
    },
    async uploadAttachment(input) {
      const vaultId = input.vaultId;
      const notePath = requireMarkdownPath(input.notePath);
      const content = requireString(input.content, "content");
      const bytes = Buffer.from(content, "base64");
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 20 MB");
      const rawName = requireString(input.name, "name");
      const extension = path.extname(rawName).toLowerCase();
      const original = sanitizeName(path.basename(rawName, extension)) || "image";
      if (!new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]).has(extension)) {
        throw new Error("Unsupported image type");
      }
      const parent = path.posix.dirname(notePath);
      const attachment = `${original}-${Date.now().toString(36)}${extension}`;
      const relativePath =
        parent === "." ? `_attachments/${attachment}` : `${parent}/_attachments/${attachment}`;
      const result = await writeFile({
        vaultId,
        rawPath: relativePath,
        content,
        contentEncoding: "base64",
        createOnly: true,
      });
      return {
        path: relativePath,
        markdownPath: `./_attachments/${attachment}`,
        result,
      };
    },
    async preparePreview(input) {
      const vault = getVault(input.vaultId);
      const relativePath = requireVaultPath(input.path);
      // Only existence matters here; the session reads the note itself.
      const { file } = await hostFiles.call(
        "statFile",
        { path: absolutePath(vault, relativePath) },
        hostArgs(vault),
      );
      if (file === null) throw new Error(`File not found: ${relativePath}`);
      return previewLease(vault);
    },
    async openFile(input) {
      const target = await resolveOpenerFile(input.source, input.path);
      const args = {
        hostId: target.hostId,
        path: target.path,
        rootPath: target.rootPath,
      };
      const [file, preview] = await Promise.all([
        bb.sdk.files.read(args),
        targetPreviewLease({ hostId: target.hostId, rootPath: target.rootPath }),
      ]);
      const pathApi = path.win32.isAbsolute(target.rootPath) ? path.win32 : path.posix;
      return {
        file,
        preview,
        previewPath: pathApi.relative(target.rootPath, target.path).replace(/\\/g, "/"),
        hostId: target.hostId,
      };
    },
    async watchOpenedFile(input) {
      const target = await resolveOpenerFile(input.source, input.path);
      return watchOpenedTarget(target);
    },
    async saveOpenedFile(input) {
      const target = await resolveOpenerFile(input.source, input.path);
      const result = await bb.sdk.files.write({
        hostId: target.hostId,
        path: target.path,
        rootPath: target.rootPath,
        content: input.content,
        ...(input.expectedSha256 === null || typeof input.expectedSha256 === "string"
          ? { expectedSha256: input.expectedSha256 }
          : {}),
      });
      if (result.outcome === "written") {
        mentionSummaries.clear();
        for (const reader of openedFileReaders.get(openedWatchId(target)) ?? []) {
          reader.sha256 = result.sha256;
          reader.revision += 1;
        }
        invalidate([openedFileTag(input.source, input.path)]);
      }
      return result;
    },
  };

  bb.rpc.register(docsRpcContract, handlers, {
    experimental_discoverable: true,
    experimental_description:
      "Read, write, propose, and safely sync Markdown documents in Docs vaults.",
  });

  async function readHttpInput<Schema extends z.ZodType>(
    context: Parameters<Parameters<BbPluginApi["http"]["route"]>[2]>[0],
    schema: Schema,
  ): Promise<{ ok: true; value: z.output<Schema> } | { ok: false; response: Response }> {
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return {
        ok: false,
        response: context.json(
          {
            ok: false,
            error: {
              code: "invalid_json",
              message: "request body must be JSON",
            },
          },
          400,
        ),
      };
    }
    const result = await schema.safeParseAsync(input);
    if (result.success) return { ok: true, value: result.data };
    return {
      ok: false,
      response: context.json(
        {
          ok: false,
          error: {
            code: "invalid_input",
            message: "request input validation failed",
            issues: result.error.issues.map((issue) =>
              issue.path.length > 0
                ? { message: issue.message, path: issue.path }
                : { message: issue.message },
            ),
          },
        },
        400,
      ),
    };
  }

  function routeRpc<Schema extends z.ZodType>(
    routePath: string,
    schema: Schema,
    handle: (input: z.output<Schema>) => object | Promise<object>,
  ): void {
    bb.http.route(
      "POST",
      routePath,
      async (context) => {
        const input = await readHttpInput(context, schema);
        if (!input.ok) return input.response;
        return context.json(await handle(input.value));
      },
      { auth: "token" },
    );
  }

  routeRpc("/list", docsRpcContract.listNotes.input, handlers.listNotes);

  function hostPathApi(rootPath: string): typeof path.posix | typeof path.win32 {
    return path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath)
      ? path.win32
      : path.posix;
  }

  function resolveHostPath(rootPath: string, candidate: string): string {
    if (isAbsoluteHostPath(candidate)) return normalizeHostRoot(candidate);
    return hostPathApi(rootPath).resolve(rootPath, candidate);
  }

  function localFilePath(rootPath: string, relativePath: string): string {
    return hostPathApi(rootPath).join(rootPath, ...relativePath.split("/"));
  }

  // The CLI's working directory is on the invoking machine, which is not
  // necessarily the server's. Resolve that machine from --workspace-host,
  // then the thread's environment, then the one connected host that has the
  // directory. Never fall back to the server's own working directory or host.
  async function resolveWorkspace(
    args: SyncCliArgs,
    context: PluginCliContext,
    target: string,
  ): Promise<{ rootPath: string; host: { id: string; name: string } }> {
    if (!context.cwd && !isAbsoluteHostPath(target)) {
      throw new CliUsageError(
        `Pass an absolute path instead of ${target}; bb sent no working directory`,
      );
    }
    const rootPath = context.cwd ? resolveHostPath(context.cwd, target) : normalizeHostRoot(target);
    const probePath = context.cwd ?? rootPath;
    let hostId = args.workspaceHostId;
    if (!hostId && context.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: context.threadId });
      if (thread.environmentId) {
        hostId = (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
      }
    }
    if (hostId) {
      const name = (await bb.sdk.hosts.list().catch(() => [])).find(
        (host) => host.id === hostId,
      )?.name;
      return { rootPath, host: { id: hostId, name: name ?? hostId } };
    }
    const { holders } = await hostsHoldingPath(probePath);
    const [holder] = holders;
    if (holder && holders.length === 1) {
      return { rootPath, host: { id: holder.id, name: holder.name } };
    }
    throw new CliUsageError(
      holders.length === 0
        ? `No connected machine has ${probePath}; pass --workspace-host <id>`
        : `Pass --workspace-host <id>; ${probePath} exists on ${holders
            .map((host) => `${host.name} (${host.id})`)
            .join(", ")}`,
    );
  }

  async function readWorkspaceFile(
    rootPath: string,
    hostId: string,
    relativePath: string,
  ): Promise<Awaited<ReturnType<typeof bb.sdk.files.read>> | null> {
    try {
      return await bb.sdk.files.read({
        hostId,
        path: localFilePath(rootPath, relativePath),
        rootPath,
      });
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async function readSyncState(
    rootPath: string,
    hostId: string,
  ): Promise<{
    state: SyncState;
    sha256: string;
  } | null> {
    const file = await readWorkspaceFile(rootPath, hostId, SYNC_STATE_FILE);
    if (!file) return null;
    if (file.contentEncoding !== "utf8") {
      throw new Error(`${SYNC_STATE_FILE} must be UTF-8 JSON`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch {
      throw new Error(
        `${SYNC_STATE_FILE} is malformed; move this workspace aside and pull into a clean directory`,
      );
    }
    const result = syncStateSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `${SYNC_STATE_FILE} is invalid: ${z.prettifyError(result.error)}. Move this workspace aside and pull into a clean directory`,
      );
    }
    const remotePaths = result.data.entries.map((entry) => entry.remotePath);
    const localPaths = result.data.entries.map((entry) => entry.localPath);
    if (
      new Set(remotePaths).size !== remotePaths.length ||
      new Set(localPaths).size !== localPaths.length
    ) {
      throw new Error(`${SYNC_STATE_FILE} contains duplicate identities`);
    }
    if (
      result.data.entries.some(
        (entry) =>
          entry.localPath !== entry.remotePath ||
          !scopeContains(result.data.scope, entry.remotePath),
      ) ||
      result.data.directories.some((directory) => !scopeContains(result.data.scope, directory))
    ) {
      throw new Error(`${SYNC_STATE_FILE} contains an identity outside its declared scope`);
    }
    return { state: result.data, sha256: file.sha256 };
  }

  async function writeSyncState(
    rootPath: string,
    hostId: string,
    state: SyncState,
    expectedSha256: string | null,
  ): Promise<void> {
    const result = await bb.sdk.files.write({
      hostId,
      path: localFilePath(rootPath, SYNC_STATE_FILE),
      rootPath,
      content: `${JSON.stringify(state, null, 2)}\n`,
      createParents: true,
      expectedSha256,
    });
    if (result.outcome === "conflict") {
      throw new Error(
        `${SYNC_STATE_FILE} changed concurrently; remote changes were left intact and the workspace can be recovered by rerunning pull`,
      );
    }
  }

  function stateFromSnapshot(snapshot: {
    vault: Vault;
    scope: SyncScope;
    files: SyncFile[];
    directories: string[];
  }): SyncState {
    return {
      schemaVersion: SYNC_STATE_VERSION,
      vault: { id: snapshot.vault.id, name: snapshot.vault.name },
      scope: snapshot.scope,
      pulledAt: new Date().toISOString(),
      entries: snapshot.files.map(({ content: _content, ...entry }) => entry),
      directories: snapshot.directories,
    };
  }

  function sameScope(left: SyncScope, right: SyncScope): boolean {
    return (
      left.kind === right.kind &&
      (left.kind === "all" || (right.kind !== "all" && left.path === right.path))
    );
  }

  function parsePullScope(args: SyncCliArgs): SyncScope {
    if (args.all && (args.folder || args.positionals.length > 0)) {
      throw new CliUsageError("--all cannot be combined with a path or --folder");
    }
    if (args.all) return { kind: "all" };
    const scopePath = args.positionals[0];
    if (!scopePath) {
      throw new CliUsageError("pull requires <path> or --all");
    }
    if (args.positionals.length > 1) {
      throw new CliUsageError("pull accepts only one vault path");
    }
    return {
      kind: args.folder ? "folder" : "file",
      path: requireVaultPath(scopePath),
    };
  }

  function simpleDiff(remotePath: string, base: string, local: string): string {
    if (base === local) return "";
    const before = base.split("\n");
    const after = local.split("\n");
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
      prefix += 1;
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    )
      suffix += 1;
    const removed = before.slice(prefix, before.length - suffix);
    const added = after.slice(prefix, after.length - suffix);
    return [
      `--- a/${remotePath}`,
      `+++ b/${remotePath}`,
      `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
    ].join("\n");
  }

  async function runPull(args: SyncCliArgs, context: PluginCliContext) {
    const scope = parsePullScope(args);
    const { rootPath, host } = await resolveWorkspace(
      args,
      context,
      args.into ?? `docs-${getVault(args.vaultId).id}`,
    );
    const hostId = host.id;
    const snapshot = await syncSnapshot(args.vaultId, scope);
    const existing = await readSyncState(rootPath, hostId);
    if (
      existing &&
      (existing.state.vault.id !== snapshot.vault.id ||
        !sameScope(existing.state.scope, snapshot.scope))
    ) {
      throw new Error(
        `${SYNC_STATE_FILE} belongs to a different vault or scope; choose another --into directory`,
      );
    }
    const oldEntries = new Map(
      existing?.state.entries.map((entry) => [entry.remotePath, entry]) ?? [],
    );
    const remoteEntries = new Map(snapshot.files.map((entry) => [entry.remotePath, entry]));
    const remoteDirectories = new Set(snapshot.directories);
    const removedDirectories =
      existing?.state.directories.filter((directory) => !remoteDirectories.has(directory)) ?? [];
    const writes: Array<{
      file: SyncFile;
      expectedSha256: string | null;
    }> = [];
    const deletes: Array<{ path: string; expectedSha256: string }> = [];
    const conflicts: Array<{ path: string; reason: string }> = [];
    for (const remote of snapshot.files) {
      const base = oldEntries.get(remote.remotePath);
      const local = await readWorkspaceFile(rootPath, hostId, remote.localPath);
      if (!base) {
        if (!local) writes.push({ file: remote, expectedSha256: null });
        else if (local.sha256 !== remote.sha256)
          conflicts.push({
            path: remote.localPath,
            reason: "untracked local file differs from the vault",
          });
        continue;
      }
      if (!local) {
        if (remote.sha256 !== base.sha256)
          conflicts.push({
            path: remote.localPath,
            reason: "locally deleted while the vault file also changed",
          });
        continue;
      }
      if (local.sha256 === remote.sha256) continue;
      if (local.sha256 === base.sha256) {
        writes.push({ file: remote, expectedSha256: local.sha256 });
      } else if (remote.sha256 !== base.sha256) {
        conflicts.push({
          path: remote.localPath,
          reason: "both local and vault copies changed",
        });
      }
    }
    for (const base of oldEntries.values()) {
      if (remoteEntries.has(base.remotePath)) continue;
      const local = await readWorkspaceFile(rootPath, hostId, base.localPath);
      if (!local) continue;
      if (local.sha256 === base.sha256)
        deletes.push({ path: base.localPath, expectedSha256: local.sha256 });
      else
        conflicts.push({
          path: base.localPath,
          reason: "vault file was deleted while the local copy changed",
        });
    }
    if (conflicts.length > 0) {
      return {
        outcome: "conflict" as const,
        rootPath,
        workspaceHost: host,
        vaultId: snapshot.vault.id,
        scope: snapshot.scope,
        written: [],
        deleted: [],
        deletedDirectories: [],
        conflicts,
      };
    }
    const written: string[] = [];
    const deleted: string[] = [];
    const deletedDirectories: string[] = [];
    try {
      await bb.sdk.files.mkdir({
        hostId,
        path: rootPath,
        recursive: true,
      });
      for (const directory of snapshot.directories) {
        await bb.sdk.files.mkdir({
          hostId,
          path: localFilePath(rootPath, directory),
          rootPath,
          recursive: true,
        });
      }
      for (const write of writes) {
        const result = await bb.sdk.files.write({
          hostId,
          path: localFilePath(rootPath, write.file.localPath),
          rootPath,
          content: write.file.content,
          contentEncoding: write.file.contentEncoding,
          createParents: true,
          expectedSha256: write.expectedSha256,
        });
        if (result.outcome === "conflict") {
          throw new Error(
            `Local file changed during pull: ${write.file.localPath}; rerun pull to recover`,
          );
        }
        written.push(write.file.localPath);
      }
      for (const deletion of deletes) {
        const current = await readWorkspaceFile(rootPath, hostId, deletion.path);
        if (current?.sha256 !== deletion.expectedSha256) {
          throw new Error(
            `Local file changed during pull: ${deletion.path}; rerun pull to recover`,
          );
        }
        await bb.sdk.files.remove({
          hostId,
          path: localFilePath(rootPath, deletion.path),
          rootPath,
          recursive: false,
        });
        deleted.push(deletion.path);
      }
      for (const directory of [...removedDirectories].sort(
        (left, right) =>
          right.split("/").length - left.split("/").length || right.localeCompare(left),
      )) {
        try {
          await bb.sdk.files.remove({
            hostId,
            path: localFilePath(rootPath, directory),
            rootPath,
            recursive: false,
          });
          deletedDirectories.push(directory);
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
        }
      }
      await writeSyncState(rootPath, hostId, stateFromSnapshot(snapshot), existing?.sha256 ?? null);
    } catch (error) {
      return {
        outcome: "partial" as const,
        rootPath,
        workspaceHost: host,
        vaultId: snapshot.vault.id,
        scope: snapshot.scope,
        written,
        deleted,
        deletedDirectories,
        conflicts: [],
        errors: [
          {
            message: errorMessage(error),
          },
        ],
      };
    }
    return {
      outcome: "pulled" as const,
      rootPath,
      workspaceHost: host,
      vaultId: snapshot.vault.id,
      scope: snapshot.scope,
      written,
      deleted,
      deletedDirectories,
      conflicts: [],
    };
  }

  async function runPushPlan(args: SyncCliArgs, context: PluginCliContext, apply: boolean) {
    const defaultVault = getVault(args.vaultId);
    if (args.positionals.length > 1) {
      throw new Error("push/status accepts only one workspace directory");
    }
    const { rootPath, host } = await resolveWorkspace(
      args,
      context,
      args.positionals[0] ?? args.into ?? `docs-${defaultVault.id}`,
    );
    const hostId = host.id;
    const existing = await readSyncState(rootPath, hostId);
    if (!existing) {
      throw new Error(`${SYNC_STATE_FILE} was not found; run bb docs pull first`);
    }
    if (args.vaultId && args.vaultId !== existing.state.vault.id) {
      throw new Error(`Workspace belongs to vault ${existing.state.vault.id}, not ${args.vaultId}`);
    }
    const snapshot = await syncSnapshot(existing.state.vault.id, existing.state.scope);
    const listing = await listHostPaths({ hostId, path: rootPath });
    if (listing.truncated) {
      throw new Error(`Local workspace exceeds ${MAX_TREE_ENTRIES} entries; narrow the pull scope`);
    }
    const localPaths = listing.paths
      .map((entry) => ({
        kind: entry.kind,
        path: entry.path.replace(/\\/g, "/"),
      }))
      .filter((entry) => entry.path !== SYNC_STATE_FILE)
      .filter((entry) => {
        try {
          requireVaultPath(entry.path);
          return true;
        } catch {
          return false;
        }
      });
    const localFiles = new Map<string, Awaited<ReturnType<typeof bb.sdk.files.read>>>();
    for (const entry of localPaths) {
      if (entry.kind !== "file") continue;
      const file = await readWorkspaceFile(rootPath, hostId, entry.path);
      if (file) localFiles.set(entry.path, file);
    }
    const baseByLocal = new Map(existing.state.entries.map((entry) => [entry.localPath, entry]));
    const remoteByPath = new Map(snapshot.files.map((entry) => [entry.remotePath, entry]));
    const writes: Array<{
      path: string;
      content: string;
      contentEncoding: "base64" | "utf8";
      expectedSha256: string | null;
    }> = [];
    const deletes: Array<{ path: string; expectedSha256: string }> = [];
    const conflicts: Array<{ path: string; reason: string }> = [];
    const warnings: Array<{ path: string; reason: string }> = [];
    const diffs: string[] = [];
    const localFolded = new Map<string, string>();
    for (const entry of localPaths) {
      const collision = localFolded.get(entry.path.toLowerCase());
      if (collision && collision !== entry.path) {
        conflicts.push({
          path: entry.path,
          reason: `local path collides with ${collision} on case-insensitive filesystems`,
        });
      }
      localFolded.set(entry.path.toLowerCase(), entry.path);
    }
    for (const [localPath, local] of localFiles) {
      if (!scopeContains(existing.state.scope, localPath)) {
        conflicts.push({
          path: localPath,
          reason: "local file is outside the pulled scope",
        });
        continue;
      }
      const base = baseByLocal.get(localPath);
      const remotePath = base?.remotePath ?? requireVaultPath(localPath);
      const remote = remoteByPath.get(remotePath);
      if (!base) {
        if (remote && remote.sha256 !== local.sha256) {
          conflicts.push({
            path: remotePath,
            reason: "new local file collides with a vault file",
          });
        } else if (!remote) {
          writes.push({
            path: remotePath,
            content: local.content,
            contentEncoding: local.contentEncoding,
            expectedSha256: null,
          });
        }
        continue;
      }
      if (!remote) {
        conflicts.push({
          path: remotePath,
          reason: "vault file was deleted after pull",
        });
        continue;
      }
      if (local.sha256 === remote.sha256) continue;
      if (local.sha256 === base.sha256 && remote.sha256 !== base.sha256) {
        conflicts.push({
          path: remotePath,
          reason: "vault file changed after pull",
        });
      } else if (local.sha256 !== base.sha256 && remote.sha256 === base.sha256) {
        writes.push({
          path: remotePath,
          content: local.content,
          contentEncoding: local.contentEncoding,
          expectedSha256: base.sha256,
        });
        if (args.diff && local.contentEncoding === "utf8" && remote.contentEncoding === "utf8") {
          diffs.push(simpleDiff(remotePath, remote.content, local.content));
        }
      } else {
        conflicts.push({
          path: remotePath,
          reason: "both local and vault copies changed",
        });
      }
    }
    for (const base of existing.state.entries) {
      if (localFiles.has(base.localPath)) continue;
      const remote = remoteByPath.get(base.remotePath);
      if (!remote) continue;
      if (!args.delete) {
        warnings.push({
          path: base.remotePath,
          reason: "local deletion ignored; pass --delete to remove from vault",
        });
      } else if (remote.sha256 !== base.sha256) {
        conflicts.push({
          path: base.remotePath,
          reason: "locally deleted while the vault file also changed",
        });
      } else {
        deletes.push({ path: base.remotePath, expectedSha256: base.sha256 });
      }
    }
    for (const remote of snapshot.files) {
      const tracked = existing.state.entries.some(
        (entry) => entry.remotePath === remote.remotePath,
      );
      const matchingLocal = localFiles.has(remote.localPath);
      if (!tracked && !matchingLocal) {
        conflicts.push({
          path: remote.remotePath,
          reason: "new vault file is not present locally; pull before pushing",
        });
      }
    }
    const discoveredLocalDirectories = localPaths
      .filter((entry) => entry.kind === "directory")
      .map((entry) => entry.path);
    const localDirectories = discoveredLocalDirectories.filter((directory) =>
      scopeContains(existing.state.scope, directory),
    );
    for (const directory of discoveredLocalDirectories) {
      const structuralAncestor =
        existing.state.scope.kind !== "all" &&
        existing.state.scope.path.startsWith(`${directory}/`);
      if (!scopeContains(existing.state.scope, directory) && !structuralAncestor) {
        conflicts.push({
          path: directory,
          reason: "local directory is outside the pulled scope",
        });
      }
    }
    const localDirectorySet = new Set(localDirectories);
    const remoteDirectorySet = new Set(snapshot.directories);
    const trackedDirectorySet = new Set(existing.state.directories);
    const createDirectories: string[] = [];
    const deleteDirectories: string[] = [];
    for (const directory of localDirectories) {
      if (trackedDirectorySet.has(directory) && !remoteDirectorySet.has(directory)) {
        conflicts.push({
          path: directory,
          reason: "vault directory was deleted after pull",
        });
      } else if (!remoteDirectorySet.has(directory)) {
        createDirectories.push(directory);
      }
    }
    for (const directory of existing.state.directories) {
      if (localDirectorySet.has(directory) || !remoteDirectorySet.has(directory)) continue;
      if (existing.state.scope.kind === "folder" && directory === existing.state.scope.path) {
        warnings.push({
          path: directory,
          reason:
            "pulled folder root deletion ignored; pull its parent or the whole vault to delete it",
        });
      } else if (!args.delete) {
        warnings.push({
          path: directory,
          reason: "local directory deletion ignored; pass --delete to remove it from the vault",
        });
      } else {
        deleteDirectories.push(directory);
      }
    }
    for (const directory of snapshot.directories) {
      if (!trackedDirectorySet.has(directory) && !localDirectorySet.has(directory)) {
        conflicts.push({
          path: directory,
          reason: "new vault directory is not present locally; pull before pushing",
        });
      }
    }
    const plan = {
      rootPath,
      workspaceHost: host,
      vaultId: existing.state.vault.id,
      scope: existing.state.scope,
      writes: writes.map((write) => write.path),
      deletes: deletes.map((deletion) => deletion.path),
      directories: createDirectories,
      deleteDirectories,
      conflicts,
      warnings,
      diffs: diffs.filter(Boolean),
    };
    if (!apply || args.dryRun || conflicts.length > 0) {
      return {
        outcome: conflicts.length > 0 ? ("conflict" as const) : ("planned" as const),
        ...plan,
      };
    }
    const applied = await syncApply({
      vaultId: existing.state.vault.id,
      writes,
      deletes,
      directories: createDirectories,
      deleteDirectories,
      dryRun: false,
    });
    if (applied.outcome !== "applied") {
      return { outcome: applied.outcome, ...plan, applied };
    }
    const refreshed = await syncSnapshot(existing.state.vault.id, existing.state.scope);
    await writeSyncState(rootPath, hostId, stateFromSnapshot(refreshed), existing.sha256);
    return { outcome: "pushed" as const, ...plan, applied };
  }

  function stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  }

  function workspaceHostSuffix(result: Record<string, unknown>): string {
    const host = result.workspaceHost;
    return isRecord(host) && typeof host.name === "string" ? ` on ${host.name}` : "";
  }

  function formatSyncHumanOutput(command: string, result: unknown): string {
    if (!isRecord(result)) return JSON.stringify(result, null, 2);
    if (command === "pull") {
      if (result.outcome === "conflict") {
        return `Pull stopped: ${Array.isArray(result.conflicts) ? result.conflicts.length : 0} conflict(s). No files were changed.\n${JSON.stringify(result.conflicts, null, 2)}`;
      }
      if (result.outcome === "partial") {
        return `Pull partially completed in ${String(result.rootPath)}${workspaceHostSuffix(result)}. The prior manifest remains valid; rerun pull to recover safely.\n${JSON.stringify(result.errors, null, 2)}`;
      }
      return `Pulled ${stringArray(result.written).length} file(s) into ${String(result.rootPath)}${workspaceHostSuffix(result)}${stringArray(result.deleted).length > 0 ? `; removed ${stringArray(result.deleted).length} remotely deleted file(s)` : ""}${stringArray(result.deletedDirectories).length > 0 ? `; removed ${stringArray(result.deletedDirectories).length} remotely deleted director${stringArray(result.deletedDirectories).length === 1 ? "y" : "ies"}` : ""}.`;
    }
    if (command === "status" || command === "push") {
      const writes = stringArray(result.writes);
      const deletes = stringArray(result.deletes);
      const directories = stringArray(result.directories);
      const deleteDirectories = stringArray(result.deleteDirectories);
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
      const lines = [
        `Docs workspace: ${String(result.rootPath)}${workspaceHostSuffix(result)}`,
        `Vault: ${String(result.vaultId)}`,
        `Changes: ${writes.length} write(s), ${deletes.length} file deletion(s), ${directories.length} directory creation(s), ${deleteDirectories.length} directory deletion(s), ${warnings.length} warning(s), ${conflicts.length} conflict(s)`,
      ];
      if (writes.length > 0) lines.push(`Write:\n  ${writes.join("\n  ")}`);
      if (deletes.length > 0) lines.push(`Delete:\n  ${deletes.join("\n  ")}`);
      if (directories.length > 0) lines.push(`Create directories:\n  ${directories.join("\n  ")}`);
      if (deleteDirectories.length > 0)
        lines.push(`Delete directories:\n  ${deleteDirectories.join("\n  ")}`);
      if (warnings.length > 0) lines.push(`Warnings:\n${JSON.stringify(warnings, null, 2)}`);
      if (conflicts.length > 0) lines.push(`Conflicts:\n${JSON.stringify(conflicts, null, 2)}`);
      const diffs = stringArray(result.diffs);
      if (diffs.length > 0) lines.push(diffs.join("\n\n"));
      if (result.outcome === "pushed") lines.push("Push completed.");
      else if (result.outcome === "planned")
        lines.push(
          command === "push"
            ? "Dry run only; no remote changes were made."
            : "No remote changes were made.",
        );
      else if (result.outcome === "partial")
        lines.push("Push partially completed; rerun status to recover safely.");
      else if (result.outcome === "conflict")
        lines.push("No push changes were made; pull and merge the conflicts first.");
      return lines.join("\n");
    }
    return JSON.stringify(result, null, 2);
  }
  routeRpc("/read", docsRpcContract.readNote.input, handlers.readNote);
  routeRpc("/write", docsRpcContract.saveNote.input, handlers.saveNote);
  routeRpc("/mkdir", docsRpcContract.createFolder.input, handlers.createFolder);
  routeRpc("/move", docsRpcContract.movePath.input, handlers.movePath);
  routeRpc("/remove", docsRpcContract.deletePath.input, handlers.deletePath);
  routeRpc("/sync/snapshot", docsRpcContract.syncSnapshot.input, handlers.syncSnapshot);
  routeRpc("/sync/apply", docsRpcContract.syncApply.input, handlers.syncApply);

  async function attemptCli(work: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PluginCliError) throw error;
      throw new PluginCliError(errorMessage(error), {
        code: "operation_failed",
      });
    }
  }

  function renderCliResult(command: string, result: unknown, asJson: boolean): string {
    return asJson ? JSON.stringify(result, null, 2) : formatSyncHumanOutput(command, result);
  }

  function workspaceArgs(args: {
    positionals: string[];
    vaultId: string | undefined;
    into: string | undefined;
    workspaceHostId: string | undefined;
    all?: boolean;
    folder?: boolean;
    delete?: boolean;
    dryRun?: boolean;
    diff?: boolean;
  }): SyncCliArgs {
    return {
      positionals: args.positionals,
      vaultId: args.vaultId,
      into: args.into,
      workspaceHostId: args.workspaceHostId,
      all: args.all ?? false,
      folder: args.folder ?? false,
      delete: args.delete ?? false,
      dryRun: args.dryRun ?? false,
      diff: args.diff ?? false,
    };
  }

  function statusExitCode(result: unknown): number {
    if (!isRecord(result)) return 0;
    if (result.outcome === "conflict") return 3;
    const changed = ["writes", "deletes", "directories", "deleteDirectories", "warnings"].some(
      (key) => Array.isArray(result[key]) && (result[key] as unknown[]).length > 0,
    );
    return changed ? 4 : 0;
  }

  const proposalPositionals = [
    {
      name: "path",
      description: "Markdown path relative to the vault root",
      required: true,
    },
  ] as const;
  const proposalVersionOption = {
    type: "string",
    required: true,
    description: "Version returned by proposal; use none only when no proposal exists",
  } as const;

  function parseProposalVersion(value: string): number | null {
    if (value === "none") return null;
    const version = Number(value);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new CliUsageError("Expected a positive proposal version or none.");
    return version;
  }

  const proposalCommands = Object.fromEntries(
    (["accept", "reject", "undo", "redo"] as const).map((action) => [
      action,
      cliCommand({
        summary: `${action[0]!.toUpperCase()}${action.slice(1)} a document proposal`,
        positionals: proposalPositionals,
        options: {
          vault: VAULT_OPTION,
          version: proposalVersionOption,
          json: JSON_OPTION,
        },
        run: (input) =>
          attemptCli(async () => {
            const expectedVersion = parseProposalVersion(input.options.version);
            if (expectedVersion === null)
              throw new CliUsageError("This action requires a proposal version.");
            const result = await handlers.resolveProposal({
              vaultId: input.options.vault,
              path: requireVaultPath(input.positionals.path),
              action,
              expectedVersion,
            });
            return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
          }),
      }),
    ]),
  );

  bb.cli.register(
    defineCli({
      name: "docs",
      summary: "Discover and safely sync Docs vaults",
      description: DOCS_DESCRIPTION,
      usageErrorExitCode: 2,
      commands: {
        ...proposalCommands,
        proposal: cliCommand({
          summary: "Read the current proposal and its version",
          positionals: proposalPositionals,
          options: { vault: VAULT_OPTION, json: JSON_OPTION },
          run: (input) =>
            attemptCli(async () => ({
              exitCode: 0,
              stdout: JSON.stringify(
                await handlers.readProposal({
                  vaultId: input.options.vault,
                  path: requireVaultPath(input.positionals.path),
                }),
                null,
                2,
              ),
            })),
        }),
        propose: cliCommand({
          summary: "Propose a Markdown revision without changing the document",
          positionals: proposalPositionals,
          options: {
            vault: VAULT_OPTION,
            version: proposalVersionOption,
            json: JSON_OPTION,
            "expected-sha256": {
              type: "string",
              required: true,
              description: "Current document SHA-256 from read --json",
            },
            file: {
              type: "string",
              required: true,
              description: "Workspace UTF-8 file containing the complete proposed Markdown",
            },
            "workspace-host": WORKSPACE_HOST_OPTION,
          },
          run: (input, context) =>
            attemptCli(async () => {
              const { rootPath: candidatePath, host } = await resolveWorkspace(
                workspaceArgs({
                  positionals: [],
                  vaultId: input.options.vault,
                  into: undefined,
                  workspaceHostId: input.options["workspace-host"],
                }),
                context,
                input.options.file,
              );
              const file = await bb.sdk.files.read({
                hostId: host.id,
                path: candidatePath,
                rootPath: (path.win32.isAbsolute(candidatePath) &&
                !path.posix.isAbsolute(candidatePath)
                  ? path.win32
                  : path.posix
                ).dirname(candidatePath),
              });
              if (file.contentEncoding !== "utf8")
                throw new CliUsageError("Proposal file must be UTF-8 Markdown.");
              const result = await handlers.proposeNote({
                vaultId: input.options.vault,
                path: requireMarkdownPath(input.positionals.path),
                content: file.content,
                expectedSha256: input.options["expected-sha256"],
                expectedVersion: parseProposalVersion(input.options.version),
              });
              return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
            }),
        }),
        "proposal-update": cliCommand({
          summary: "Edit a pending candidate using its version",
          positionals: proposalPositionals,
          options: {
            vault: VAULT_OPTION,
            version: proposalVersionOption,
            json: JSON_OPTION,
            content: {
              type: "string",
              required: true,
              description: "Complete candidate Markdown",
            },
          },
          run: (input) =>
            attemptCli(async () => {
              const expectedVersion = parseProposalVersion(input.options.version);
              if (expectedVersion === null)
                throw new CliUsageError("This action requires a proposal version.");
              const result = await handlers.updateProposal({
                vaultId: input.options.vault,
                path: requireVaultPath(input.positionals.path),
                content: input.options.content,
                expectedVersion,
              });
              return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
            }),
        }),
        vaults: cliCommand({
          summary: "List configured vaults",
          suggestFor: ["vault"],
          options: { json: JSON_OPTION },
          run: (input) =>
            attemptCli(async () => ({
              exitCode: 0,
              stdout: renderCliResult("vaults", listVaults(), input.options.json),
            })),
        }),
        "vault-add": cliCommand({
          summary: "Add a vault",
          suggestFor: ["add-vault", "vault-create"],
          positionals: [
            {
              name: "name",
              description: "Display name for the vault",
              required: true,
            },
            {
              name: "absolute-root",
              description: "Absolute directory on the host; it is created when missing",
              required: true,
            },
            {
              name: "host-id",
              description: "Connected host holding the directory; defaults to the server's host",
            },
          ],
          options: { json: JSON_OPTION },
          run: (input) =>
            attemptCli(async () => ({
              exitCode: 0,
              stdout: renderCliResult(
                "vault-add",
                await handlers.createVault({
                  name: input.positionals.name,
                  rootPath: input.positionals["absolute-root"],
                  hostId: input.positionals["host-id"],
                }),
                input.options.json,
              ),
            })),
        }),
        "vault-host": cliCommand({
          summary: "Bind a vault to the machine that holds its folder",
          description:
            "Keeps the vault's proposals and file order. Refuses a connected machine without the folder. Host IDs come from bb machine list.",
          suggestFor: ["vault-machine", "vault-bind"],
          positionals: [
            {
              name: "id",
              description: "Vault ID from `bb docs vaults`",
              required: true,
            },
            {
              name: "host-id",
              description: "Connected host holding the vault folder",
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          run: (input) =>
            attemptCli(async () => ({
              exitCode: 0,
              stdout: renderCliResult(
                "vault-host",
                await handlers.setVaultHost({
                  vaultId: input.positionals.id,
                  hostId: input.positionals["host-id"],
                }),
                input.options.json,
              ),
            })),
        }),
        "vault-remove": cliCommand({
          summary: "Remove a vault configuration",
          suggestFor: ["remove-vault", "vault-delete"],
          positionals: [
            {
              name: "id",
              description: "Vault ID from `bb docs vaults`",
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          run: (input) =>
            attemptCli(async () => ({
              exitCode: 0,
              stdout: renderCliResult(
                "vault-remove",
                await handlers.removeVault({ vaultId: input.positionals.id }),
                input.options.json,
              ),
            })),
        }),
        list: cliCommand({
          summary: "List notes and folders",
          aliases: ["ls"],
          options: { vault: VAULT_OPTION, json: JSON_OPTION },
          run: (input) =>
            attemptCli(async () => ({
              exitCode: 0,
              stdout: renderCliResult(
                "list",
                await notebookData(input.options.vault),
                input.options.json,
              ),
            })),
        }),
        read: cliCommand({
          summary: "Read a file",
          aliases: ["cat"],
          positionals: [
            {
              name: "path",
              description: "Path relative to the vault root",
              required: true,
            },
          ],
          options: { vault: VAULT_OPTION, json: JSON_OPTION },
          run: (input) =>
            attemptCli(async () => {
              const result = await readFile(input.options.vault, input.positionals.path);
              return {
                exitCode: 0,
                stdout:
                  !input.options.json && isRecord(result) && typeof result.content === "string"
                    ? result.content
                    : renderCliResult("read", result, input.options.json),
              };
            }),
        }),
        pull: cliCommand({
          summary: "Pull one file, a folder subtree, or a whole vault",
          description:
            "Writes the scope into a workspace directory with a .bb-docs-state.json manifest. Edit the files with ordinary tools, then run bb docs status and bb docs push.",
          suggestFor: ["fetch", "clone", "checkout"],
          positionals: [
            {
              name: "path",
              description: "Vault file, or folder with --folder; omit only with --all",
            },
          ],
          options: {
            vault: VAULT_OPTION,
            into: {
              type: "string",
              placeholder: "dir",
              aliases: ["dir", "target"],
              description:
                "Workspace directory to pull into; defaults to docs-<vault-id> under the working directory",
            },
            "workspace-host": WORKSPACE_HOST_OPTION,
            all: {
              type: "boolean",
              description: "Pull the whole vault instead of one path",
            },
            folder: {
              type: "boolean",
              aliases: ["recursive"],
              description: "Treat the path as a folder subtree",
            },
            json: JSON_OPTION,
          },
          constraints: [{ kind: "at-most-one", options: ["all", "folder"] }],
          run: (input, context) =>
            attemptCli(async () => {
              const path = input.positionals.path;
              const result = await runPull(
                workspaceArgs({
                  positionals: path === undefined ? [] : [path],
                  vaultId: input.options.vault,
                  into: input.options.into,
                  workspaceHostId: input.options["workspace-host"],
                  all: input.options.all,
                  folder: input.options.folder,
                }),
                context,
              );
              return {
                exitCode: !isRecord(result)
                  ? 0
                  : result.outcome === "conflict"
                    ? 3
                    : result.outcome === "partial"
                      ? 1
                      : 0,
                stdout: renderCliResult("pull", result, input.options.json),
              };
            }),
        }),
        status: cliCommand({
          summary: "Show local edits, conflicts, and ignored deletions",
          description: DOCS_STATUS_DESCRIPTION,
          positionals: [
            {
              name: "workspace-dir",
              description: "Pulled workspace directory; defaults to --into or docs-<vault-id>",
            },
          ],
          options: {
            vault: VAULT_OPTION,
            "workspace-host": WORKSPACE_HOST_OPTION,
            delete: DELETE_OPTION,
            diff: DIFF_OPTION,
            json: JSON_OPTION,
          },
          run: (input, context) =>
            attemptCli(async () => {
              const directory = input.positionals["workspace-dir"];
              const result = await runPushPlan(
                workspaceArgs({
                  positionals: directory === undefined ? [] : [directory],
                  vaultId: input.options.vault,
                  into: undefined,
                  workspaceHostId: input.options["workspace-host"],
                  delete: input.options.delete,
                  diff: input.options.diff,
                }),
                context,
                false,
              );
              return {
                exitCode: statusExitCode(result),
                stdout: renderCliResult("status", result, input.options.json),
              };
            }),
        }),
        push: cliCommand({
          summary: "Safely push local edits using optimistic concurrency",
          description:
            "Refuses to write when a vault file changed since the pull; resolve the conflict, then pull or push again.",
          positionals: [
            {
              name: "workspace-dir",
              description: "Pulled workspace directory; defaults to --into or docs-<vault-id>",
            },
          ],
          options: {
            vault: VAULT_OPTION,
            "workspace-host": WORKSPACE_HOST_OPTION,
            delete: DELETE_OPTION,
            "dry-run": {
              type: "boolean",
              aliases: ["dryrun", "plan"],
              description: "Plan the push without writing to the vault",
            },
            diff: DIFF_OPTION,
            json: JSON_OPTION,
          },
          run: (input, context) =>
            attemptCli(async () => {
              const directory = input.positionals["workspace-dir"];
              const result = await runPushPlan(
                workspaceArgs({
                  positionals: directory === undefined ? [] : [directory],
                  vaultId: input.options.vault,
                  into: undefined,
                  workspaceHostId: input.options["workspace-host"],
                  delete: input.options.delete,
                  dryRun: input.options["dry-run"],
                  diff: input.options.diff,
                }),
                context,
                true,
              );
              return {
                exitCode: !isRecord(result)
                  ? 0
                  : result.outcome === "conflict"
                    ? 3
                    : result.outcome === "partial"
                      ? 1
                      : 0,
                stdout: renderCliResult("push", result, input.options.json),
              };
            }),
        }),
        write: cliCommand({
          summary: "Deprecated: write a UTF-8 file directly",
          description: "Use bb docs pull, edit the files, then bb docs push instead.",
          positionals: [
            {
              name: "path",
              description: "Path relative to the vault root",
              required: true,
            },
          ],
          options: {
            vault: VAULT_OPTION,
            content: {
              type: "string",
              required: true,
              placeholder: "text",
              aliases: ["text", "body"],
              description: "Complete UTF-8 file contents",
            },
            json: JSON_OPTION,
          },
          run: (input) =>
            attemptCli(async () => ({
              exitCode: 0,
              stdout: renderCliResult(
                "write",
                await writeFile({
                  vaultId: input.options.vault,
                  rawPath: input.positionals.path,
                  content: input.options.content,
                }),
                input.options.json,
              ),
              stderr: DEPRECATED_MUTATION_WARNING,
            })),
        }),
        mkdir: cliCommand({
          summary: "Deprecated: create a folder directly",
          description: "Use bb docs pull, create the directory locally, then bb docs push instead.",
          positionals: [
            {
              name: "path",
              description: "Folder path relative to the vault root",
              required: true,
            },
          ],
          options: { vault: VAULT_OPTION, json: JSON_OPTION },
          run: (input) =>
            attemptCli(async () => ({
              exitCode: 0,
              stdout: renderCliResult(
                "mkdir",
                await handlers.createFolder({
                  vaultId: input.options.vault,
                  path: input.positionals.path,
                }),
                input.options.json,
              ),
              stderr: DEPRECATED_MUTATION_WARNING,
            })),
        }),
        move: cliCommand({
          summary: "Deprecated: move a path directly",
          description:
            "Use bb docs pull, move the file locally, then bb docs push --delete instead.",
          positionals: [
            {
              name: "from",
              description: "Existing path relative to the vault root",
              required: true,
            },
            {
              name: "to",
              description: "Destination path relative to the vault root",
              required: true,
            },
          ],
          options: { vault: VAULT_OPTION, json: JSON_OPTION },
          run: (input) =>
            attemptCli(async () => ({
              exitCode: 0,
              stdout: renderCliResult(
                "move",
                await movePath(input.options.vault, input.positionals.from, input.positionals.to),
                input.options.json,
              ),
              stderr: DEPRECATED_MUTATION_WARNING,
            })),
        }),
        remove: cliCommand({
          summary: "Deprecated: remove a file or directory directly",
          description:
            "Use bb docs pull, delete the file locally, then bb docs push --delete instead.",
          aliases: ["rm"],
          positionals: [
            {
              name: "path",
              description: "Path relative to the vault root",
              required: true,
            },
          ],
          options: {
            vault: VAULT_OPTION,
            recursive: {
              type: "boolean",
              description: "Remove a directory and everything inside it",
            },
            json: JSON_OPTION,
          },
          run: (input) =>
            attemptCli(async () => ({
              exitCode: 0,
              stdout: renderCliResult(
                "remove",
                await removePath(
                  input.options.vault,
                  input.positionals.path,
                  input.options.recursive,
                ),
                input.options.json,
              ),
              stderr: DEPRECATED_DELETION_WARNING,
            })),
        }),
      },
    }),
  );

  bb.ui.registerMentionProvider({
    id: "note",
    label: "Docs",
    async search({ query }) {
      const needle = query.trim().toLowerCase();
      // One asleep or slow machine must not hide the other vaults. A vault
      // that misses the wait keeps loading into the cache for the next keystroke.
      const hosts = await bb.sdk.hosts.list().catch(() => null);
      const connected = hosts
        ? new Set(hosts.filter((host) => host.status === "connected").map((host) => host.id))
        : null;
      const vaults = listVaults().filter(
        (vault) => vault.hostId !== null && (connected === null || connected.has(vault.hostId)),
      );
      const settled = await Promise.allSettled(
        vaults.map(
          (vault) =>
            new Promise<NoteSummary[]>((resolve, reject) => {
              const timer = setTimeout(() => resolve([]), MENTION_VAULT_WAIT_MS);
              mentionNoteSummaries(vault)
                .then(resolve, reject)
                .finally(() => clearTimeout(timer));
            }),
        ),
      );
      const matches = [];
      for (const [index, vault] of vaults.entries()) {
        const result = settled[index]!;
        if (result.status === "rejected") continue;
        for (const note of result.value) {
          if (
            needle &&
            !`${vault.name} ${note.title} ${note.preview} ${note.path}`
              .toLowerCase()
              .includes(needle)
          )
            continue;
          matches.push({
            id: `${vault.id}:${note.path}`,
            title: note.title,
            subtitle: `${vault.name} · ${note.preview || note.path}`,
            icon: "FileText",
          });
          if (matches.length === 25) return matches;
        }
      }
      return matches;
    },
    async resolve(itemId) {
      const separator = itemId.indexOf(":");
      if (separator < 1) throw new Error("Invalid note mention");
      const vaultId = itemId.slice(0, separator);
      const relativePath = itemId.slice(separator + 1);
      const file = await readFile(vaultId, relativePath);
      const proposal = readProposal(getVault(vaultId).id, relativePath);
      return {
        context:
          `Docs document (${vaultId}/${relativePath}):\nSHA-256: ${file.sha256}\n\n${file.content}` +
          (proposal
            ? `\n\nDocs proposal metadata:\n${JSON.stringify(proposal)}\nUse bb docs propose with this version and current document hash to propose a revision; do not push over the user's document.`
            : "\n\nProposal version: none. Use bb docs propose to suggest changes for approval."),
      };
    },
  });

  // bb's built-in Docs (simple-notes) claims the same `bb docs` command.
  bb.onInstall(async () => {
    const builtIn = (await bb.sdk.plugins.list()).plugins.find(
      (plugin) => plugin.id === "simple-notes",
    );
    if (builtIn?.enabled) await bb.sdk.plugins.disable({ pluginId: "simple-notes" });
  });

  // A removed machine never returns under the same id, so its vaults can never load again.
  bb.events.on("experimental_host.deleted", async ({ host }) => {
    const removed = listVaults().filter((vault) => vault.hostId === host.id);
    if (removed.length === 0) return;
    db.transaction(() => {
      for (const vault of removed) {
        db.prepare("DELETE FROM proposals WHERE vault_id = ?").run(vault.id);
        db.prepare("DELETE FROM entry_order WHERE vault_id = ?").run(vault.id);
        db.prepare("DELETE FROM vaults WHERE id = ?").run(vault.id);
      }
    })();
    for (const vault of removed) {
      mentionSummaries.delete(vault.id);
      bb.realtime.publish("vault-changed", { vaultId: vault.id });
      invalidate([VAULTS_TAG, vaultTag(vault.id), treeTag(vault.id)]);
    }
    // On failure the watch-vaults service retries.
    await ensureDefaultVault().catch((error: unknown) =>
      bb.log.warn(`could not create the Personal vault: ${errorMessage(error)}`),
    );
  });

  // A daemon restart drops its watches without a worker exit, and the host
  // can reconnect between two polls. Ask each host which of its watches it
  // still holds. A host that cannot answer keeps them until a later poll.
  async function lostWatches(
    armed: ReadonlyMap<string, { hostId: string }>,
    connected: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<string[]> {
    const lost = await Promise.all(
      [...connected].map(async (hostId) => {
        const vaultIds = [...armed]
          .filter(([, watch]) => watch.hostId === hostId)
          .map(([vaultId]) => vaultId);
        if (vaultIds.length === 0) return [];
        const answer = await hostFiles
          .call("watchAlive", { vaultIds }, { hostId, timeoutMs: 5_000, signal })
          .catch(() => null);
        return answer ? vaultIds.filter((vaultId) => !answer.live.includes(vaultId)) : [];
      }),
    );
    return lost.flat();
  }

  // Each vault is watched by the native watcher on its own host. The
  // server's filesystem is not the vault's, so watching it would see nothing.
  bb.background.service("watch-vaults", {
    async start(signal) {
      const armed = new Map<string, { hostId: string; rootPath: string }>();
      const warned = new Set<string>();
      let setupWarning: string | null = null;
      let wake: (() => void) | null = null;
      // `paths` names what changed when the host could; without it, anything
      // in the vault may have.
      const changed = (vaultId: string, paths?: string[]) => {
        mentionSummaries.delete(vaultId);
        bb.realtime.publish("vault-changed", { vaultId, ...(paths ? { paths } : {}) });
        invalidate(
          paths
            ? [treeTag(vaultId), ...paths.flatMap((p) => pathTags(vaultId, p))]
            : [treeTag(vaultId), vaultTag(vaultId)],
        );
      };
      // Re-arming publishes a change, since changes made while unwatched are unknown.
      const offSignal = hostFiles.experimental_onSignal("vaultChanged", ({ hostId, payload }) => {
        if (armed.get(payload.vaultId)?.hostId !== hostId) return;
        if (payload.kind === "watch-error") {
          armed.delete(payload.vaultId);
          wake?.();
          return;
        }
        if (payload.changes === undefined) return changed(payload.vaultId);
        const fresh = payload.changes.filter((change) => !isOwnEcho(payload.vaultId, change));
        if (fresh.length > 0)
          changed(
            payload.vaultId,
            fresh.map((change) => change.path),
          );
      });
      // A restarted worker has lost its watches.
      const offExit = hostFiles.experimental_onWorkerExit(({ hostId }) => {
        for (const [vaultId, watch] of armed) if (watch.hostId === hostId) armed.delete(vaultId);
        wake?.();
      });
      const unwatch = (vaultId: string, hostId: string) =>
        void hostFiles.call("unwatchVault", { vaultId }, { hostId }).catch(() => {});
      try {
        while (!signal.aborted) {
          try {
            await ensureDefaultVault();
            await bindLegacyVaults();
            setupWarning = null;
          } catch (error) {
            const message = errorMessage(error);
            if (message !== setupWarning) bb.log.warn(`could not set up vaults: ${message}`);
            setupWarning = message;
          }
          const vaults = listVaults();
          const hosts = await bb.sdk.hosts.list().catch(() => []);
          const connected = new Set(
            hosts.filter((host) => host.status === "connected").map((host) => host.id),
          );
          for (const [vaultId, watch] of armed) {
            const vault = vaults.find((candidate) => candidate.id === vaultId);
            if (vault?.hostId === watch.hostId && vault.rootPath === watch.rootPath) {
              if (connected.has(watch.hostId)) continue;
            } else {
              unwatch(vaultId, watch.hostId);
            }
            // Signals sent while a host was away are lost: re-arm on return.
            armed.delete(vaultId);
          }
          for (const vaultId of await lostWatches(armed, connected, signal)) {
            armed.delete(vaultId);
            changed(vaultId);
          }
          for (const vault of vaults) {
            if (!vault.hostId || armed.has(vault.id) || !connected.has(vault.hostId)) continue;
            const watch = { hostId: vault.hostId, rootPath: vault.rootPath };
            try {
              await hostFiles.call(
                "watchVault",
                { vaultId: vault.id, rootPath: vault.rootPath },
                { hostId: vault.hostId, signal },
              );
              armed.set(vault.id, watch);
              warned.delete(vault.id);
              changed(vault.id);
            } catch (error) {
              if (signal.aborted) break;
              if (!warned.has(vault.id)) {
                warned.add(vault.id);
                bb.log.warn(`cannot watch vault ${vault.id}: ${errorMessage(error)}`);
              }
            }
          }
          const pause = new AbortController();
          wake = () => pause.abort();
          await waitForDelay(10_000, AbortSignal.any([signal, pause.signal]));
          wake = null;
        }
      } finally {
        offSignal();
        offExit();
        for (const [vaultId, watch] of armed) unwatch(vaultId, watch.hostId);
      }
    },
  });
  bb.rpc.experimental_whileWatched("openFile", (read, signal) => {
    if (!("input" in read)) return;
    const input = docsRpcContract.openFile.input.safeParse(read.input);
    if (!input.success) return;
    void (async () => {
      let watchId: string | undefined;
      let pause: AbortController | null = null;
      let wakeRequested = false;
      let previousPreview: string | null = null;
      let failures = 0;
      const reader: OpenedFileReader = {
        tag: openedFileTag(input.data.source, input.data.path),
        sha256: undefined,
        revision: 0,
        wake() {
          wakeRequested = true;
          pause?.abort();
        },
      };
      const detach = () => {
        if (!watchId) return;
        const readers = openedFileReaders.get(watchId);
        readers?.delete(reader);
        if (readers?.size === 0) {
          openedFileReaders.delete(watchId);
          openedFileWatches.delete(watchId);
        }
        watchId = undefined;
      };
      signal.addEventListener("abort", detach, { once: true });
      try {
        while (!signal.aborted) {
          wakeRequested = false;
          let delay = 1_000;
          try {
            const target = await resolveOpenerFile(input.data.source, input.data.path);
            signal.throwIfAborted();
            const nextWatchId = openedWatchId(target);
            if (nextWatchId !== watchId) {
              detach();
              watchId = nextWatchId;
              reader.sha256 = undefined;
              const readers = openedFileReaders.get(watchId) ?? new Set<typeof reader>();
              readers.add(reader);
              openedFileReaders.set(watchId, readers);
            }
            const revision = reader.revision;
            const watch = await watchOpenedTarget(target, signal);
            signal.throwIfAborted();
            const lease = await targetPreviewLease({
              hostId: target.hostId,
              rootPath: target.rootPath,
            });
            signal.throwIfAborted();
            const hashChanged = reader.revision === revision && reader.sha256 !== watch.sha256;
            if (reader.revision === revision) reader.sha256 = watch.sha256;
            if (hashChanged || (previousPreview !== null && previousPreview !== lease.baseUrl))
              invalidate([reader.tag]);
            previousPreview = lease.baseUrl;
            failures = 0;
            delay = Math.min(
              watch.renewWithinMs,
              Math.max(1_000, lease.expiresAtMs - PREVIEW_RENEW_BEFORE_MS - Date.now() + 1_000),
            );
          } catch (error) {
            if (signal.aborted) break;
            if (failures === 0) bb.log.warn(`cannot watch opened file: ${errorMessage(error)}`);
            delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
            failures += 1;
          }
          if (wakeRequested) continue;
          pause = new AbortController();
          await waitForDelay(delay, AbortSignal.any([signal, pause.signal]));
          pause = null;
        }
      } finally {
        signal.removeEventListener("abort", detach);
        detach();
      }
    })();
  });
  bb.rpc.experimental_whileWatched("preparePreview", (read, signal) => {
    if (!("input" in read)) return;
    const input = docsRpcContract.preparePreview.input.safeParse(read.input);
    if (!input.success) return;
    const vault = listVaults().find(
      (candidate) => input.data.vaultId === undefined || candidate.id === input.data.vaultId,
    );
    if (vault) void renewPreviewWhileWatched(vault, input.data.path, signal);
  });
  bb.rpc.experimental_whileWatched("readDocument", (read, signal) => {
    if (!("input" in read)) return;
    const input = docsRpcContract.readDocument.input.safeParse(read.input);
    if (!input.success) return;
    const vault = listVaults().find((candidate) => candidate.id === input.data.vaultId);
    if (!vault) return;
    void renewPreviewWhileWatched(vault, input.data.path, signal);
  });

  async function renewPreviewWhileWatched(vault: Vault, relativePath: string, signal: AbortSignal) {
    while (!signal.aborted) {
      let lease: { expiresAtMs: number };
      try {
        lease = await previewLease(getVault(vault.id));
      } catch {
        await waitForDelay(5_000, signal);
        continue;
      }
      await waitForDelay(
        Math.max(1_000, lease.expiresAtMs - PREVIEW_RENEW_BEFORE_MS - Date.now() + 1_000),
        signal,
      );
      if (!signal.aborted) invalidate([documentTag(vault.id, relativePath)]);
    }
  }
}

export { docsRpcContract } from "./contract.js";
