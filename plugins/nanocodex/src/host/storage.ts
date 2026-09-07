import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ChatGptSubscriptionStore,
  SessionSnapshot,
  SubscriptionRevision,
  SubscriptionStoredValue,
} from "nanocodex/host";
import type {
  DurabilityAcquiredJournal,
  DurabilityAppendRequest,
  DurabilityAppendResult,
  DurabilityCompactRequest,
  DurabilityCompactResult,
  DurabilityFence,
  DurabilityRevision,
  DurabilityStore,
  DurabilityStoredJournal,
} from "nanocodex/durability";

interface StoredDurability {
  readonly version: 1;
  readonly owner?: { readonly id: string; readonly fence: string };
  readonly journal: {
    readonly revision: string;
    readonly batches: readonly { readonly revision: string; readonly payload: string }[];
  };
}

export interface StoredThread {
  readonly version: 1;
  readonly providerThreadId: string;
  readonly durabilityId: string;
  readonly nextCheckpoint: number;
  readonly checkpoints: Readonly<Record<string, SessionSnapshot>>;
  readonly forkSeed?: SessionSnapshot;
}

export interface NanocodexStorage {
  readonly durability: DurabilityStore;
  readonly subscription: ChatGptSubscriptionStore;
  durabilityFor(providerThreadId: string): DurabilityStore;
  createThread(providerThreadId: string): Promise<StoredThread>;
  createFork(providerThreadId: string, seed: SessionSnapshot): Promise<StoredThread>;
  readThread(providerThreadId: string): Promise<StoredThread>;
  readCheckpoint(providerThreadId: string, checkpointId?: string): Promise<SessionSnapshot>;
  commitCheckpoint(
    providerThreadId: string,
    snapshot: SessionSnapshot,
    options?: { readonly retainAsForkSeed?: boolean },
  ): Promise<string>;
  establishDurability(providerThreadId: string): Promise<void>;
  discardThread(providerThreadId: string): Promise<void>;
}

const fileLocks = new Map<string, Promise<unknown>>();

export function createNanocodexStorage(dataDir: string): NanocodexStorage {
  const root = join(dataDir, "native");
  const threadDir = join(root, "threads");
  const durabilityDir = join(root, "durability");
  const subscriptionFile = join(root, "subscription.json");
  const threadFile = (id: string): string => join(threadDir, `${fileId(id)}.json`);
  const durabilityFile = (id: string): string => join(durabilityDir, `${fileId(id)}.json`);

  const readDurability = async (journalId: string): Promise<StoredDurability> =>
    readJson(durabilityFile(journalId), emptyDurability());

  const durability: DurabilityStore = {
    async load(journalId) {
      const stored = await readDurability(journalId);
      return toJournal(stored.journal);
    },
    async acquire(journalId, request) {
      return withFileLock(durabilityFile(journalId), async () => {
        const stored = await readDurability(journalId);
        const fence = String(BigInt(stored.owner?.fence ?? "0") + 1n);
        const next: StoredDurability = {
          ...stored,
          owner: { id: request.ownerId, fence },
        };
        await writeJsonAtomic(durabilityFile(journalId), next);
        return {
          ...toJournal(next.journal),
          ownerId: request.ownerId,
          fence: fence as DurabilityFence,
        } satisfies DurabilityAcquiredJournal;
      });
    },
    async append(journalId, request) {
      return withFileLock(durabilityFile(journalId), async () => {
        const stored = await readDurability(journalId);
        const ownerResult = checkOwner(stored, request);
        if (ownerResult !== null) return ownerResult;
        if (stored.journal.revision !== request.expectedRevision) {
          return {
            status: "conflict",
            actualRevision: stored.journal.revision as DurabilityRevision,
          } satisfies DurabilityAppendResult;
        }
        const revision = String(BigInt(stored.journal.revision) + 1n);
        const next: StoredDurability = {
          ...stored,
          journal: {
            revision,
            batches: [...stored.journal.batches, { revision, payload: request.payload }],
          },
        };
        await writeJsonAtomic(durabilityFile(journalId), next);
        return { status: "appended", revision: revision as DurabilityRevision };
      });
    },
    async compact(journalId, request) {
      return withFileLock(durabilityFile(journalId), async () => {
        const stored = await readDurability(journalId);
        const ownerResult = checkOwner(stored, request);
        if (ownerResult !== null) return ownerResult;
        if (stored.journal.revision !== request.expectedRevision) {
          return {
            status: "conflict",
            actualRevision: stored.journal.revision as DurabilityRevision,
          } satisfies DurabilityCompactResult;
        }
        if (stored.journal.revision === "0") {
          return { status: "not_committed", message: "cannot compact an empty journal" };
        }
        const next: StoredDurability = {
          ...stored,
          journal: {
            revision: stored.journal.revision,
            batches: [{ revision: stored.journal.revision, payload: request.payload }],
          },
        };
        await writeJsonAtomic(durabilityFile(journalId), next);
        return {
          status: "compacted",
          revision: stored.journal.revision as DurabilityRevision,
        };
      });
    },
  };

  const subscription: ChatGptSubscriptionStore = {
    async load(id) {
      requireSubscriptionId(id);
      return readJson<SubscriptionStoredValue>(subscriptionFile, {
        revision: "0" as SubscriptionRevision,
      });
    },
    async compareAndSwap(id, request) {
      requireSubscriptionId(id);
      return withFileLock(subscriptionFile, async () => {
        const stored = await readJson<SubscriptionStoredValue>(subscriptionFile, {
          revision: "0" as SubscriptionRevision,
        });
        if (stored.revision !== request.expectedRevision) {
          return { status: "conflict", actualRevision: stored.revision };
        }
        const revision = String(BigInt(stored.revision) + 1n) as SubscriptionRevision;
        await writeJsonAtomic(subscriptionFile, { revision, payload: request.payload });
        return { status: "committed", revision };
      });
    },
  };

  const readThread = async (providerThreadId: string): Promise<StoredThread> => {
    const stored = await readJson<
      (Omit<StoredThread, "durabilityId"> & { readonly durabilityId?: string }) | null
    >(threadFile(providerThreadId), null);
    if (stored === null || stored.version !== 1 || stored.providerThreadId !== providerThreadId) {
      throw new Error(`No native NanoCodex state exists for ${providerThreadId}`);
    }
    return {
      ...stored,
      durabilityId: stored.durabilityId ?? stored.forkSeed?.prompt_cache_key ?? providerThreadId,
    };
  };

  return {
    durability,
    subscription,
    durabilityFor(providerThreadId) {
      return scopeDurability(durability, providerThreadId);
    },
    async createThread(providerThreadId) {
      const stored: StoredThread = {
        version: 1,
        providerThreadId,
        durabilityId: providerThreadId,
        nextCheckpoint: 0,
        checkpoints: {},
      };
      await writeJsonAtomic(threadFile(providerThreadId), stored);
      return stored;
    },
    async createFork(providerThreadId, seed) {
      const stored: StoredThread = {
        version: 1,
        providerThreadId,
        durabilityId: seed.prompt_cache_key,
        nextCheckpoint: 0,
        checkpoints: {},
        forkSeed: seed,
      };
      await writeJsonAtomic(threadFile(providerThreadId), stored);
      return stored;
    },
    readThread,
    async readCheckpoint(providerThreadId, checkpointId) {
      const stored = await readThread(providerThreadId);
      const resolved =
        checkpointId ??
        (stored.nextCheckpoint === 0 ? undefined : String(stored.nextCheckpoint - 1));
      const snapshot = resolved === undefined ? undefined : stored.checkpoints[resolved];
      if (snapshot === undefined) {
        throw new Error(
          `Unknown NanoCodex checkpoint ${checkpointId ?? "tip"} for ${providerThreadId}`,
        );
      }
      return snapshot;
    },
    async commitCheckpoint(providerThreadId, snapshot, options = {}) {
      return withFileLock(threadFile(providerThreadId), async () => {
        const stored = await readThread(providerThreadId);
        const checkpointId = String(stored.nextCheckpoint);
        const next: StoredThread = {
          version: 1,
          providerThreadId,
          durabilityId: stored.durabilityId,
          nextCheckpoint: stored.nextCheckpoint + 1,
          checkpoints: { ...stored.checkpoints, [checkpointId]: snapshot },
          ...(options.retainAsForkSeed === true ? { forkSeed: snapshot } : {}),
        };
        await writeJsonAtomic(threadFile(providerThreadId), next);
        return checkpointId;
      });
    },
    async establishDurability(providerThreadId) {
      await withFileLock(threadFile(providerThreadId), async () => {
        const stored = await readThread(providerThreadId);
        if (stored.forkSeed === undefined) return;
        const next: StoredThread = {
          version: 1,
          providerThreadId,
          durabilityId: stored.durabilityId,
          nextCheckpoint: stored.nextCheckpoint,
          checkpoints: stored.checkpoints,
        };
        await writeJsonAtomic(threadFile(providerThreadId), next);
      });
    },
    async discardThread(providerThreadId) {
      await Promise.all([
        unlinkIfPresent(threadFile(providerThreadId)),
        unlinkIfPresent(durabilityFile(providerThreadId)),
      ]);
    },
  };
}

function scopeDurability(store: DurabilityStore, providerThreadId: string): DurabilityStore {
  const compact = store.compact;
  return {
    load: () => store.load(providerThreadId),
    acquire: (_journalId, request) => store.acquire(providerThreadId, request),
    append: (_journalId, request) => store.append(providerThreadId, request),
    ...(compact === undefined
      ? {}
      : { compact: (_journalId, request) => compact(providerThreadId, request) }),
  };
}

function emptyDurability(): StoredDurability {
  return { version: 1, journal: { revision: "0", batches: [] } };
}

function toJournal(journal: StoredDurability["journal"]): DurabilityStoredJournal {
  return {
    revision: journal.revision as DurabilityRevision,
    batches: journal.batches.map((batch) => ({
      revision: batch.revision as DurabilityRevision,
      payload: batch.payload,
    })),
  };
}

function checkOwner(
  stored: StoredDurability,
  request: DurabilityAppendRequest | DurabilityCompactRequest,
): { readonly status: "fenced" } | null {
  return stored.owner?.id === request.ownerId && stored.owner?.fence === request.fence
    ? null
    : { status: "fenced" };
}

async function withFileLock<Result>(key: string, action: () => Promise<Result>): Promise<Result> {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const current = previous.then(action, action);
  fileLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (fileLocks.get(key) === current) fileLocks.delete(key);
  }
}

async function readJson<Value>(path: string, fallback: Value): Promise<Value> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Value;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function fileId(id: string): string {
  if (id.length === 0 || id.length > 300) throw new TypeError("NanoCodex state ID is invalid");
  return Buffer.from(id).toString("base64url");
}

function requireSubscriptionId(id: string): void {
  if (id !== "nanocodex") throw new Error(`Unknown ChatGPT subscription: ${id}`);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}
