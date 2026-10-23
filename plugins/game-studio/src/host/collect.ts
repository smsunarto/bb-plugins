import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { generationId, runsOnBb, type GenerationJob } from "../shared/generation.ts";
import { nodeTakes, pruneTakes, type Take } from "../shared/takes.ts";
import { place } from "../shared/media-paths.ts";
import { located, removeStaleSnapshot, type CanvasDisk } from "./canvas.ts";
import type { GenerationRunner, Pruning } from "./generation.ts";
import type { Media } from "./media.ts";
import { resolveWorkspacePath } from "./slot-workspaces.ts";

/*
 * Collection keeps a canvas from growing without bound. It deletes only what it can account
 * for:
 * - takes the retention rule (`pruneTakes`) retired from a node at least GRACE_MS ago,
 *   recorded in a ledger before the board is saved, so a crash or a lost board write never
 *   forgets them;
 * - canvas outputs nothing has named for UNUSED_MS, such as takes removed by hand or those of
 *   a deleted node; the ledger records when each was first seen unused;
 * - failed runs with no provider task to resume, once a later success on their node
 *   superseded them or their node has been gone for UNUSED_MS;
 * - input snapshots no job names.
 * A file is freed only if, read again just before, no board, document, request, evidence or
 * unfinished job names it. Collection never guesses: an unreadable board or job record stops
 * it before anything is deleted.
 */

const HOUR = 3_600_000;
/**
 * Recent jobs and input snapshots wait out dispatch, adoption and review, and a retired take
 * stays in the library this long, so linking it again keeps it.
 */
export const GRACE_MS = HOUR;
/** How long a canvas output nothing names stays, so undoing a deletion or a clear keeps it. */
export const UNUSED_MS = 7 * 24 * HOUR;
/** A provider run recorded as running this recently may still run in another host worker. */
const WRITING_MS = 6 * HOUR;
/** An agent run or request older than this is taken as done, whatever its record says. */
const AGENT_MS = 7 * 24 * HOUR;
/** An agent run whose BB thread was never confirmed may still start for this long. */
const UNCONFIRMED_MS = 24 * HOUR;
const open = new Set(["queued", "running", "uncertain"]);
const LEDGER = "canvas/jobs/.retired.json";

/** What a canvas names, read from the files that can name a generation. */
export type References = {
  /** Every string in boards, requests, evidence and unfinished or recent jobs. */
  names: Set<string>;
  /** Document text and every string above, which can name files and assets in prose. */
  documents: string;
  /** `${boardId}\0${nodeId}` for every node. */
  nodes: Set<string>;
  /** Catalogued paths and their asset IDs. */
  catalog: Map<string, string>;
};
/** A take the retention rule retired, and when. */
type Retired = { assetId: string; jobId: string; at: number };
/**
 * What collection remembers between passes: retired takes, when each unnamed output was first
 * seen unnamed (by asset ID), and when each missing node was first seen missing.
 */
type Ledger = {
  /** 2 once `seen` covers every output that existed when unused timing began. */
  version: number;
  retired: Retired[];
  /** Outputs a board, document or request has named; only these can become unused. */
  seen: string[];
  unused: Record<string, number>;
  missing: Record<string, number>;
  sha256: string | null;
};
type Node = { id?: unknown; data?: Record<string, unknown> };
type Board = { nodes: Node[] };

/** Collects a JSON value's strings. A review or judgement names its job, not the takes it judged. */
function strings(value: unknown, into: Set<string>, key = ""): void {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) {
    for (const item of value)
      if (key === "reviews" || key === "judgements") {
        const jobId = (item as { jobId?: unknown } | null)?.jobId;
        if (typeof jobId === "string") into.add(jobId);
      } else strings(item, into, key);
  } else if (value && typeof value === "object")
    for (const [name, item] of Object.entries(value)) strings(item, into, name);
}

async function json(disk: CanvasDisk, root: string, path: string) {
  const file = await disk.read(root, path);
  if (!file) return undefined;
  if (file.contentEncoding !== "utf8") throw new Error(`${path} is not UTF-8 text.`);
  return { value: JSON.parse(file.content) as unknown, sha256: file.sha256 };
}

async function indexIds(disk: CanvasDisk, root: string) {
  const index = (await json(disk, root, "canvas/index.json"))?.value as
    | { boards?: { id: string }[]; documents?: { id: string }[] }
    | undefined;
  if (!index) throw new Error("canvas/index.json is missing; collection needs every board.");
  return {
    boards: (index.boards ?? []).map(({ id }) => id),
    documents: (index.documents ?? []).map(({ id }) => id),
  };
}

async function readBoard(disk: CanvasDisk, root: string, id: string) {
  const path = `canvas/boards/${id}.json`;
  const read = await json(disk, root, path);
  const value = read?.value as Partial<Board> | undefined;
  if (!read || !Array.isArray(value?.nodes)) throw new Error(`${path} is unreadable.`);
  return { path, board: value as Board, sha256: read.sha256 };
}

/** A job still running, or one whose paid provider task can still be resumed. A BB run has none. */
const unfinished = (job: GenerationJob) =>
  ["queued", "running", "uncertain"].includes(job.status) ||
  (job.status !== "succeeded" && job.taskId !== undefined && !runsOnBb(job.request));

async function readRequests(disk: CanvasDisk, root: string, into: Set<string>) {
  const requests = await disk.list(root, "canvas/requests", 10_000);
  if (requests?.truncated) throw new Error("canvas/requests has too many files to collect.");
  for (const name of requests?.files ?? [])
    if (name.endsWith(".json"))
      strings((await json(disk, root, `canvas/requests/${name}`))?.value, into);
}

/** Everything that names a file now. Unfinished and recent jobs name their inputs and sources. */
export async function readReferences(
  disk: CanvasDisk,
  root: string,
  jobs: GenerationJob[],
  now: number,
): Promise<References> {
  const refs: References = {
    names: new Set(),
    documents: "",
    nodes: new Set(),
    catalog: new Map(),
  };
  const ids = await indexIds(disk, root);
  for (const id of ids.boards) {
    const { board } = await readBoard(disk, root, id);
    for (const node of board.nodes)
      if (typeof node.id === "string") refs.nodes.add(`${id}\0${node.id}`);
    strings(board, refs.names);
  }
  const documents: string[] = [];
  for (const id of ids.documents) {
    const file = await disk.read(root, `canvas/documents/${id}.md`);
    if (file) documents.push(file.content);
  }
  const documentText = documents.join("\n");
  strings((await json(disk, root, "canvas/evidence/index.json"))?.value, refs.names);
  await readRequests(disk, root, refs.names);
  for (const job of jobs)
    if (unfinished(job) || now - job.updatedAt < GRACE_MS) {
      strings(job.request, refs.names);
      strings(job.target, refs.names);
    }
  const manifest = (await json(disk, root, "canvas/assets.json"))?.value as
    | { assets?: Record<string, { path?: unknown }> }
    | undefined;
  for (const [id, entry] of Object.entries(manifest?.assets ?? {}))
    if (typeof entry.path === "string") refs.catalog.set(entry.path, id);
  // A node's text can name a file in Markdown, as a document can.
  refs.documents = [documentText, ...refs.names].join("\n");
  return refs;
}

/** Whether the canvas names a file, by path or by the asset ID it has or would get. */
export function referenced(refs: References, path: string): boolean {
  const id = refs.catalog.get(path) ?? createHash("sha256").update(path).digest("hex").slice(0, 32);
  return (
    refs.names.has(path) ||
    refs.names.has(id) ||
    refs.documents.includes(path) ||
    refs.documents.includes(id)
  );
}

const times = (value: unknown) =>
  Object.fromEntries(
    Object.entries(value && typeof value === "object" ? value : {}).filter(
      ([, at]) => typeof at === "number",
    ),
  ) as Record<string, number>;

/** The ledger collection frees from. */
async function readLedger(disk: CanvasDisk, root: string): Promise<Ledger> {
  const read = await json(disk, root, LEDGER);
  const value = (read?.value ?? {}) as Partial<Record<keyof Ledger, unknown>>;
  const retired = (Array.isArray(value.retired) ? (value.retired as Retired[]) : []).filter(
    (entry) =>
      typeof entry?.assetId === "string" &&
      typeof entry.jobId === "string" &&
      typeof entry.at === "number",
  );
  return {
    version: typeof value.version === "number" ? value.version : 0,
    retired,
    seen: Array.isArray(value.seen) ? value.seen.filter((id) => typeof id === "string") : [],
    unused: times(value.unused),
    missing: times(value.missing),
    sha256: read?.sha256 ?? null,
  };
}

async function writeLedger(disk: CanvasDisk, root: string, ledger: Ledger): Promise<Ledger> {
  const retired = [...new Map(ledger.retired.map((entry) => [entry.assetId, entry])).values()];
  const { version, seen, unused, missing } = ledger;
  const content = `${JSON.stringify({ version, retired, seen, unused, missing })}\n`;
  const written = await disk.write(root, LEDGER, content, "utf8", ledger.sha256);
  if (written === null) throw new Error("Another collection changed the ledger. Try again later.");
  return { version, retired, seen, unused, missing, sha256: written };
}

const sameTimes = (a: Ledger, b: Ledger) =>
  JSON.stringify([a.version, a.seen, a.unused, a.missing]) ===
  JSON.stringify([b.version, b.seen, b.unused, b.missing]);

/**
 * Notes when each finished canvas output was first seen unnamed, and each node first seen
 * missing; whatever is named or present again starts over.
 */
function track(ledger: Ledger, jobs: GenerationJob[], refs: References, now: number): Ledger {
  const seen = new Set(ledger.seen);
  // The first pass counts what is already there, so earlier removals are freed too.
  const first = ledger.version < 2;
  const unused: Record<string, number> = {};
  const missing: Record<string, number> = {};
  for (const job of jobs.filter((item) => item.target && !unfinished(item))) {
    const node = `${job.target!.boardId}\0${job.target!.nodeId}`;
    const gone = !refs.nodes.has(node);
    if (gone) missing[node] = ledger.missing[node] ?? now;
    for (const { id, path } of media(job, refs)) {
      const named = referenced(refs, path);
      if (first || named) seen.add(id);
      // An output that never reached its live node, such as one whose attach failed, stays.
      if (!named && (seen.has(id) || gone)) unused[id] = ledger.unused[id] ?? now;
    }
  }
  return { ...ledger, version: 2, seen: [...seen].sort(), unused, missing };
}

/** A finished media run's catalogued outputs, with their asset IDs. */
function media(job: GenerationJob, refs: References) {
  if (job.status !== "succeeded" || job.request.kind === "text") return [];
  return job.outputs.flatMap(({ path, type }) => {
    const id = refs.catalog.get(path);
    return type !== "text" && id ? [{ id, path }] : [];
  });
}

/** Applies the retention rule to a node in place. Returns the takes it retired. */
function trimNode(node: Node, at: number): Retired[] {
  if (!node.data || !Array.isArray(node.data.takes)) return [];
  const takes: Take[] = nodeTakes(node as Parameters<typeof nodeTakes>[0]);
  const kept = pruneTakes(takes, node.data.assetId);
  if (kept.length === takes.length) return [];
  node.data.takes = kept;
  return takes
    .filter((take) => !kept.includes(take))
    .map(({ assetId, jobId }) => ({ assetId, jobId, at }));
}

/**
 * Applies the retention rule to every board. Retired takes join the ledger before each board
 * is saved; a board edited meanwhile keeps its edit, and the pass stops so the next one starts
 * from what is on disk.
 */
async function trimBoards(disk: CanvasDisk, root: string, now: number, signal?: AbortSignal) {
  let ledger = await readLedger(disk, root);
  for (const id of (await indexIds(disk, root)).boards) {
    const read = await readBoard(disk, root, id);
    const trimmed = structuredClone(read.board);
    const retired = trimmed.nodes.flatMap((node) => trimNode(node, now));
    if (!retired.length) continue;
    signal?.throwIfAborted();
    ledger = await writeLedger(disk, root, { ...ledger, retired: [...ledger.retired, ...retired] });
    const content = `${JSON.stringify(trimmed, null, 2)}\n`;
    if ((await disk.write(root, read.path, content, "utf8", read.sha256)) === null)
      throw new Error(`${read.path} changed during collection. Try again later.`);
  }
}

/** Whether a node still uses a job: a take, a pick, a review or judgement record, or a link. */
const named = (refs: References, job: GenerationJob) =>
  refs.names.has(job.id) || job.outputs.some(({ path }) => referenced(refs, path));

export type Context = {
  jobs: GenerationJob[];
  refs: References;
  /** The paths of this job the ledger lets go: retired an hour ago, or unnamed for a week. */
  retired: Set<string>;
  /** The job's node has been gone for UNUSED_MS. */
  orphaned: boolean;
  /** Every file in the job's staging folder, which goes with it only if none is named. */
  folder: string[];
  now: number;
};

function failure(job: GenerationJob, context: Context): boolean {
  const target = job.target!;
  return context.jobs.some(
    (other) =>
      other.status === "succeeded" &&
      other.request.kind !== "text" &&
      other.target?.boardId === target.boardId &&
      other.target.nodeId === target.nodeId &&
      other.createdAt > job.createdAt,
  );
}

/** A finished media run frees the outputs the ledger retired and nothing names. */
function outputs(job: GenerationJob, { refs, retired }: Context, retire: Pruning): Pruning {
  const free = job.outputs.filter(
    ({ path, type }) => type !== "text" && retired.has(path) && !referenced(refs, path),
  );
  if (!free.length) return { kind: "keep" };
  const rest = job.outputs.filter((output) => !free.includes(output));
  const done = !rest.some(({ type }) => type !== "text") && !refs.names.has(job.id);
  return done && retire.kind === "delete" ? retire : { kind: "trim", outputs: rest };
}

/** What to free of one job. Agent requests without a node, uploads and evidence are kept. */
export function decide(job: GenerationJob, context: Context): Pruning {
  const { refs, now } = context;
  const target = job.target;
  const keep = { kind: "keep" } as const;
  if (!target || unfinished(job) || now - job.updatedAt < GRACE_MS) return keep;
  const folderFree = context.folder.every((path) => !referenced(refs, path));
  const retire = folderFree ? ({ kind: "delete" } as const) : keep;
  const live = refs.nodes.has(`${target.boardId}\0${target.nodeId}`);
  const history = (!live && context.orphaned) || (live && failure(job, context));
  if (job.status !== "succeeded") return history && !named(refs, job) ? retire : keep;
  if (job.request.kind === "text") return text(job, context, live) ? retire : keep;
  return outputs(job, context, retire);
}

/** Reviews and judgements go once the takes they judged and their records left the node. */
function text(job: GenerationJob, { refs, orphaned }: Context, live: boolean): boolean {
  if (named(refs, job)) return false;
  if (!live) return orphaned;
  const request = job.request as Extract<GenerationJob["request"], { kind: "text" }>;
  const judged = request.reviewOf ?? request.judgeOf;
  return !!judged && !judged.some((id) => refs.names.has(id));
}

const locks = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The job whose staging folder holds a path; takes from before runs name no job. */
const owner = (path: string) => /^canvas\/staging\/([a-zA-Z0-9_-]{1,100})\//.exec(path)?.[1];

/** Each job's paths the ledger lets go: retired over an hour ago, or unnamed for a week. */
function retiredPaths(ledger: Ledger, catalog: Map<string, string>, now: number) {
  const paths = new Map([...catalog].map(([path, id]) => [id, path]));
  const byJob = new Map<string, Set<string>>();
  const add = (assetId: string) => {
    const path = paths.get(assetId);
    const jobId = path && owner(path);
    if (jobId) byJob.set(jobId, (byJob.get(jobId) ?? new Set()).add(path));
  };
  for (const { assetId, at } of ledger.retired) if (now - at >= GRACE_MS) add(assetId);
  for (const [assetId, since] of Object.entries(ledger.unused))
    if (now - since >= UNUSED_MS) add(assetId);
  return byJob;
}

/**
 * Every file recursive deletion of the job's folder would remove, or null when it cannot vouch
 * for them: too many, or a link it would not follow.
 */
async function inventory(mediaDir: string, jobId: string): Promise<string[] | null> {
  const folder = join(mediaDir, "staging", jobId);
  let names: string[];
  try {
    names = await readdir(folder, { recursive: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  if (names.length > 1000) return null;
  const files: string[] = [];
  for (const name of names) {
    const entry = await lstat(join(folder, name));
    if (entry.isSymbolicLink()) return null;
    if (!entry.isDirectory()) files.push(`canvas/staging/${jobId}/${name.split(sep).join("/")}`);
  }
  return files;
}

/**
 * Frees one job, deciding again under its lock with references and jobs read just before, so
 * a reference or a job made since the pass began protects its files.
 */
async function free(
  { root, mediaDir }: { root: string; mediaDir: string },
  disk: CanvasDisk,
  runner: GenerationRunner,
  job: GenerationJob,
  context: Omit<Context, "refs" | "folder" | "jobs">,
  signal?: AbortSignal,
) {
  const folder = await inventory(mediaDir, generationId.parse(job.id));
  if (!folder) return [];
  const jobs = await runner.records(root);
  const refs = await readReferences(disk, root, jobs, context.now);
  signal?.throwIfAborted();
  return runner.prune({ rootPath: root, jobId: job.id }, (current) =>
    decide(current, { ...context, jobs, refs, folder }),
  );
}

/**
 * The BB threads of agent runs that may still write where their prompts told them to, as their
 * records say, and whether a run's thread was never confirmed.
 */
export async function writers(
  disk: CanvasDisk,
  runner: GenerationRunner,
  rootPath: string,
  now = Date.now(),
): Promise<{ threads: string[]; unconfirmed: boolean }> {
  const root = await realpath(rootPath);
  const threads = new Set<string>();
  let unconfirmed = false;
  for (const job of await runner.records(root)) {
    if (job.request.kind !== "agent" || !open.has(job.status) || now - job.createdAt >= AGENT_MS)
      continue;
    if (job.taskId) threads.add(job.taskId);
    else if (now - job.createdAt < UNCONFIRMED_MS) unconfirmed = true;
  }
  return { threads: [...threads], unconfirmed };
}

/**
 * Whether an agent request is still open. Its thread may sit idle waiting for the user, then
 * go on with the paths its prompt named, so only the agent closing it, or its age, ends it.
 */
async function openRequest(disk: CanvasDisk, root: string, now: number) {
  const requests = await disk.list(root, "canvas/requests", 10_000);
  for (const name of requests?.files ?? []) {
    if (!name.endsWith(".json")) continue;
    const record = (await json(disk, root, `canvas/requests/${name}`).catch(() => undefined))
      ?.value as { status?: unknown; createdAt?: unknown } | undefined;
    if (
      open.has(String(record?.status)) &&
      typeof record?.createdAt === "number" &&
      now - record.createdAt < AGENT_MS
    )
      return true;
  }
  return false;
}

/**
 * Whether a run may still write where it was told to, so its media cannot move yet: a provider
 * run here, or one recorded as running lately, which another worker may run; an open agent
 * request; a BB thread of an agent run the server has not seen stop; or, as `hold` says, the
 * game's own thread at work. Read again at each step of a move, so a run that starts during the
 * move holds it off.
 */
async function busy(
  { runner, disk }: { runner: GenerationRunner; disk: CanvasDisk },
  root: string,
  now: number,
  { settled, hold }: { settled: ReadonlySet<string>; hold: boolean },
) {
  if (hold || runner.running(root)) return true;
  const records = await runner.records(root);
  if (
    records.some(
      (job) =>
        !runsOnBb(job.request) &&
        ["queued", "running"].includes(job.status) &&
        now - job.updatedAt < WRITING_MS,
    )
  )
    return true;
  if (await openRequest(disk, root, now)) return true;
  const { threads, unconfirmed } = await writers(disk, runner, root, now);
  return unconfirmed || threads.some((thread) => !settled.has(thread));
}

/**
 * Moves the checkout's media to its own folder when nothing is writing there, then frees what
 * nothing uses. Returns the freed canvas paths, and the catalogued staged paths whose files
 * are gone, so the server can forget both.
 */
export async function collectCanvas(
  rootPath: string,
  disk: CanvasDisk,
  runner: GenerationRunner,
  media: Media,
  {
    now = Date.now(),
    signal,
    note,
    settled = [],
    hold = false,
  }: { now?: number; signal?: AbortSignal; note: string; settled?: string[]; hold?: boolean },
): Promise<{ deleted: string[]; missing: string[]; skipped?: string; warning?: string }> {
  const root = await realpath(rootPath);
  // A checkout that shares another's Assets also shares its jobs, which other boards may use.
  if ((await resolveWorkspacePath(root)).workspacePath !== root)
    return {
      deleted: [],
      missing: [],
      skipped: "This checkout shares its generation jobs with another.",
    };
  return serial(root, async () => {
    let state;
    let warning: string | undefined;
    try {
      state = await media.migrate(root, {
        busy: () => busy({ runner, disk }, root, now, { settled: new Set(settled), hold }),
        note,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // A move that cannot finish, such as on a full disk, must not stop freeing space.
      signal?.throwIfAborted();
      warning = `Could not move the checkout's media: ${error instanceof Error ? error.message : String(error)}`;
      state = await media.state(root);
    }
    // None at all, or still another checkout's: nothing here can say what is unused.
    if (state.kind === "lost" || state.kind === "copied")
      return {
        deleted: [],
        missing: [],
        skipped:
          state.kind === "lost"
            ? "The checkout's media folder is missing."
            : "The checkout's media are still in the checkout it was copied from.",
      };
    const swept = await sweep(
      { root, mediaDir: state.dir, legacy: state.kind === "moved" },
      disk,
      runner,
      { now, ...(signal ? { signal } : {}) },
    );
    return warning ? { ...swept, warning } : swept;
  });
}

async function sweep(
  where: { root: string; mediaDir: string; legacy: boolean },
  base: CanvasDisk,
  runner: GenerationRunner,
  { now, signal }: { now: number; signal?: AbortSignal },
) {
  const { root, mediaDir } = where;
  const disk = located(base, mediaDir);
  await removeLeftovers(mediaDir);
  await trimBoards(disk, root, now, signal);
  const jobs = await runner.records(root);
  const refs = await readReferences(disk, root, jobs, now);
  const before = await readLedger(disk, root);
  const tracked = track(before, jobs, refs, now);
  const ledger = sameTimes(before, tracked) ? before : await writeLedger(disk, root, tracked);
  const retired = retiredPaths(ledger, refs.catalog, now);
  const deleted: string[] = [];
  for (const job of jobs) {
    const since = job.target && ledger.missing[`${job.target.boardId}\0${job.target.nodeId}`];
    const context = {
      now,
      retired: retired.get(job.id) ?? new Set<string>(),
      orphaned: since !== undefined && now - since >= UNUSED_MS,
    };
    // A first look with this pass's references; a candidate is decided again before it goes.
    if (decide(job, { ...context, jobs, refs, folder: [] }).kind === "keep") continue;
    deleted.push(...(await free(where, disk, runner, job, context, signal)));
  }
  const remaining = await runner.records(root);
  const final = await readReferences(disk, root, remaining, now);
  const catalog = final.catalog;
  await compact(disk, root, remaining, final);
  const snapshots = new Set(
    remaining.flatMap(
      (job) => JSON.stringify(job).match(/canvas\/inputs\/[a-f0-9]{64}\.[a-z0-9]+/g) ?? [],
    ),
  );
  deleted.push(...(await freeSnapshots(mediaDir, snapshots, now - GRACE_MS, signal)));
  return { deleted, missing: await missingFiles(where, catalog, new Set(deleted)) };
}

/** Catalogued staged files that are gone, but not those freed just now. */
async function missingFiles(
  { root, mediaDir, legacy }: { root: string; mediaDir: string; legacy: boolean },
  catalog: Map<string, string>,
  freed: Set<string>,
) {
  const missing: string[] = [];
  for (const path of catalog.keys()) {
    if (!path.startsWith("canvas/staging/") || freed.has(path)) continue;
    const at = place(root, mediaDir, path);
    if (await exists(join(at.root, ...at.path.split("/")))) continue;
    // A file written to the old folder during a move, which the next pass moves in.
    if (legacy && (await exists(join(root, ...path.split("/"))))) continue;
    missing.push(path);
  }
  return missing;
}

/** Keeps in the ledger only what still has files to free, and nodes jobs still target. */
async function compact(
  disk: CanvasDisk,
  root: string,
  remaining: GenerationJob[],
  refs: References,
) {
  const outputs = new Set(remaining.flatMap((job) => job.outputs.map(({ path }) => path)));
  const current = await readLedger(disk, root);
  const paths = new Map([...refs.catalog].map(([path, id]) => [id, path]));
  const live = (assetId: string) => outputs.has(paths.get(assetId) ?? "");
  // Named again, or back on a board, during the pass: the clock starts over.
  const idle = (assetId: string) => live(assetId) && !referenced(refs, paths.get(assetId)!);
  const targets = new Set(
    remaining.flatMap(({ target }) => (target ? [`${target.boardId}\0${target.nodeId}`] : [])),
  );
  const compacted: Ledger = {
    ...current,
    retired: current.retired.filter(({ assetId }) => live(assetId)),
    seen: current.seen.filter(live),
    unused: Object.fromEntries(Object.entries(current.unused).filter(([id]) => idle(id))),
    missing: Object.fromEntries(
      Object.entries(current.missing).filter(
        ([node]) => targets.has(node) && !refs.nodes.has(node),
      ),
    ),
  };
  if (compacted.retired.length !== current.retired.length || !sameTimes(compacted, current))
    await writeLedger(disk, root, compacted);
}

/** Deletes input snapshots no job names, once older than `before`. Returns their canvas paths. */
async function freeSnapshots(
  mediaDir: string,
  named: Set<string>,
  before: number,
  signal?: AbortSignal,
) {
  let names: string[];
  try {
    names = await readdir(join(mediaDir, "inputs"));
  } catch {
    return [];
  }
  const freed: string[] = [];
  for (const name of names) {
    const path = `canvas/inputs/${name}`;
    if (named.has(path) || !/^[a-f0-9]{64}\.[a-z0-9]+$/.test(name)) continue;
    signal?.throwIfAborted();
    if (await removeStaleSnapshot(mediaDir, `inputs/${name}`, before)) freed.push(path);
  }
  return freed;
}

/** Folders a crash left set aside for deletion. */
async function removeLeftovers(mediaDir: string) {
  let names: string[];
  try {
    names = await readdir(join(mediaDir, "staging"));
  } catch {
    return;
  }
  for (const name of names)
    if (name.startsWith(".freed-"))
      await rm(join(mediaDir, "staging", name), { recursive: true, force: true });
}
