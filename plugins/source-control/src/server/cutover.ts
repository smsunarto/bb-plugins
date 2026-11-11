/**
 * The cutover import: what the old `code-review` and `gitbutler` plugins keep
 * in their own storage, read through their read-only `exportForCutover` RPCs
 * and written into Source Control by natural key. Running it twice, or again
 * after a run that stopped half way, imports only what is missing; it never
 * writes to the old plugins. Each kind reports what it read, imported, found
 * already present, and skipped with the reason.
 */
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ImportCount, ImportKind, ImportReport } from "../core/cutover.ts";
import type { Placement } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import { commitRefSchema, loginSchema, prKey, prRefSchema } from "../core/watch.ts";
import type { HostCalls } from "./host-calls.ts";
import type { LandedWork } from "./landed.ts";
import { watchRecordSchema, type PrWatcher, type WatchRecord } from "./pr-watch.ts";
import { rowsOf } from "./review-sources.ts";
import type { Store } from "./store.ts";

const codeReviewExportSchema = z.object({
  version: z.literal(1),
  pins: z.unknown(),
  instructions: z.unknown(),
  reviewed: z.array(z.object({ branchId: z.string(), value: z.unknown(), location: z.unknown() })),
  watches: z.array(z.object({ key: z.string(), value: z.unknown() })),
  landed: z.array(z.object({ threadId: z.string(), value: z.unknown() })),
  counts: z.object({ runs: z.number(), links: z.number(), threads: z.number() }),
});
type CodeReviewExport = z.infer<typeof codeReviewExportSchema>;

const gitbutlerExportSchema = z.object({
  version: z.literal(1),
  records: z.array(z.object({ kind: z.string(), key: z.string(), value: z.unknown() })),
});

const oldPinSchema = prRefSchema.extend({ account: loginSchema.optional() }).strip();
const oldRevisionSchema = z.object({
  base: z.string().regex(/^[0-9a-f]{4,64}$/i),
  head: z.string().regex(/^[0-9a-f]{4,64}$/i),
  paths: z.array(z.string().min(1)),
});
const oldLocationSchema = z.object({ hostId: z.string().min(1), path: z.string().min(1) });
const oldCheckSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(["success", "failure", "pending", "neutral", "skipped", "cancelled"]),
  detailsUrl: z.string().nullable(),
});
/** A code-review watch record; extra fields of its checks are dropped. */
const oldWatchSchema = watchRecordSchema.extend({
  checks: z.object({ headRefOid: z.string(), checks: z.array(oldCheckSchema.strip()) }).strip(),
});
const oldLandedSchema = z.object({
  target: z.object({
    account: loginSchema,
    prs: z.array(prRefSchema.strip()),
    commits: z.array(commitRefSchema.strip()),
  }),
  since: z.number(),
});

/** code-review's id for a GitButler branch: the first 12 hex of sha256(host, path, branch). */
export function legacyBranchId(hostId: string, path: string, branch: string): string {
  return createHash("sha256").update(`${hostId}\0${path}\0${branch}`).digest("hex").slice(0, 12);
}

function counter() {
  const counts = new Map<ImportKind, ImportCount>();
  const of = (kind: ImportKind) => {
    let count = counts.get(kind);
    if (!count) {
      count = { read: 0, imported: 0, present: 0, skipped: {} };
      counts.set(kind, count);
    }
    return count;
  };
  return {
    read: (kind: ImportKind, n = 1) => {
      of(kind).read += n;
    },
    imported: (kind: ImportKind) => {
      of(kind).imported += 1;
    },
    present: (kind: ImportKind) => {
      of(kind).present += 1;
    },
    skip: (kind: ImportKind, reason: string, n = 1) => {
      const count = of(kind);
      if (n > 0) count.skipped[reason] = (count.skipped[reason] ?? 0) + n;
    },
    report: () => Object.fromEntries(counts),
  };
}
type Counter = ReturnType<typeof counter>;

export function createCutover(deps: {
  bb: BbPluginApi;
  store: Store;
  host: HostCalls;
  watcher: PrWatcher;
  landed: LandedWork;
  instructions: { get(): Promise<string>; set(text: string): Promise<void> };
  now: () => number;
}) {
  const { bb, store } = deps;

  async function exported<T>(pluginId: string, schema: z.ZodType<T>) {
    try {
      return {
        ok: true as const,
        value: await bb.sdk.plugins.callRpc({
          pluginId,
          method: "exportForCutover",
          input: {},
          outputSchema: schema,
        }),
      };
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  function pins(data: CodeReviewExport, count: Counter) {
    const list = Array.isArray(data.pins) ? data.pins : [];
    count.read("pins", list.length);
    for (const item of list) {
      const pin = oldPinSchema.safeParse(item);
      if (!pin.success) {
        count.skip("pins", "not a pull request reference");
        continue;
      }
      if (store.putPin(prKey(pin.data), JSON.stringify(pin.data), deps.now()))
        count.imported("pins");
      else count.present("pins");
    }
  }

  async function instructions(data: CodeReviewExport, count: Counter) {
    const text = typeof data.instructions === "string" ? data.instructions.trim() : "";
    if (!text) return;
    count.read("reviewInstructions");
    const current = (await deps.instructions.get()).trim();
    if (current === text) count.present("reviewInstructions");
    else if (current)
      count.skip("reviewInstructions", "Source Control already has different instructions");
    else {
      await deps.instructions.set(text);
      count.imported("reviewInstructions");
    }
  }

  /**
   * A local branch's viewed marks: the old branch id names a checkout and a
   * branch; Source Control's last read of that checkout has the branch's
   * Change. Each marked path becomes (Change, path, blob at the mark's head),
   * read from the checkout's host. A mark that cannot be tied to a blob is
   * counted and skipped, never guessed.
   */
  async function viewed(data: CodeReviewExport, count: Counter) {
    for (const entry of data.reviewed) {
      const branch = resolveBranch(entry, count);
      if (!branch) continue;
      for (const revision of branch.revisions) await viewedAt(branch, revision, count);
    }
  }

  /** The Change an old branch id names, recorded once; null when it cannot be found, counted. */
  function resolveBranch(entry: CodeReviewExport["reviewed"][number], count: Counter) {
    const revisions = z.array(oldRevisionSchema).safeParse(entry.value);
    const paths = revisions.success
      ? revisions.data.reduce((sum, revision) => sum + revision.paths.length, 0)
      : 0;
    count.read("viewedMarks", paths);
    count.read("branchIds");
    if (!revisions.success) {
      count.skip("branchIds", "unreadable record");
      return null;
    }
    const location = oldLocationSchema.safeParse(entry.location);
    if (!location.success) {
      count.skip("branchIds", "code-review never recorded where the branch was");
      count.skip("viewedMarks", "branch location unknown", paths);
      return null;
    }
    const { hostId, path } = location.data;
    const placement = store
      .checkouts()
      .find((each: Placement) => each.hostId === hostId && each.path === path);
    const row = placement
      ? rowsOf(store, placement).find(
          (each) => legacyBranchId(hostId, path, each.branch) === entry.branchId,
        )
      : undefined;
    if (!row) {
      const why = placement
        ? "branch no longer in its checkout"
        : "checkout not read by Source Control";
      count.skip("branchIds", why);
      count.skip("viewedMarks", "branch not found", paths);
      return null;
    }
    const key = row.key as ChangeKey;
    if (store.putLegacyBranch(entry.branchId, key)) count.imported("branchIds");
    else count.present("branchIds");
    return { key, hostId, path, revisions: revisions.data };
  }

  /** One old revision's marks, each tied to its file's blob at that head by the checkout's host. */
  async function viewedAt(
    branch: { key: ChangeKey; hostId: string; path: string },
    revision: z.infer<typeof oldRevisionSchema>,
    count: Counter,
  ) {
    const answer = await deps.host
      .range(
        branch.hostId,
        { path: branch.path, base: revision.base, head: revision.head, read: { kind: "files" } },
        { signal: AbortSignal.timeout(20_000), timeoutMs: 20_000 },
      )
      .catch(() => null);
    if (!answer?.ok || answer.value.kind !== "files") {
      const why = answer ? "commits not in the checkout" : "host away; run the import again later";
      count.skip("viewedMarks", why, revision.paths.length);
      return;
    }
    const blobs = new Map(answer.value.files.map((file) => [file.path, file.blob ?? null]));
    for (const file of revision.paths) markViewed(branch.key, file, blobs.get(file), count);
  }

  function markViewed(
    key: ChangeKey,
    file: string,
    blob: string | null | undefined,
    count: Counter,
  ) {
    if (!blob) {
      count.skip("viewedMarks", blob === null ? "file deleted at head" : "file not in the diff");
      return;
    }
    if (store.setViewed(key, file, blob, true)) count.imported("viewedMarks");
    else count.present("viewedMarks");
  }

  function watches(data: CodeReviewExport, count: Counter) {
    count.read("prWatches", data.watches.length);
    for (const { value } of data.watches) {
      const parsed = oldWatchSchema.safeParse(value);
      if (!parsed.success) {
        count.skip("prWatches", "unreadable record");
        continue;
      }
      if (parsed.data.ended) {
        count.skip("prWatches", "already ended");
        continue;
      }
      const record: WatchRecord = {
        ...parsed.data,
        checks: { headRefOid: parsed.data.checks.headRefOid, checks: parsed.data.checks.checks },
      };
      if (deps.watcher.adopt(record)) count.imported("prWatches");
      else count.present("prWatches");
    }
  }

  function landed(data: CodeReviewExport, count: Counter) {
    count.read("landed", data.landed.length);
    for (const { threadId, value } of data.landed) {
      const parsed = oldLandedSchema.safeParse(value);
      if (!parsed.success) {
        count.skip("landed", "unreadable record");
        continue;
      }
      if (deps.landed.adopt(threadId, parsed.data)) count.imported("landed");
      else count.present("landed");
    }
  }

  return {
    async run(): Promise<ImportReport> {
      const count = counter();
      const unavailable: ImportReport["unavailable"] = [];
      const review = await exported("code-review", codeReviewExportSchema);
      if (review.ok) {
        const data = review.value;
        pins(data, count);
        await instructions(data, count);
        await viewed(data, count);
        watches(data, count);
        landed(data, count);
        count.read("reviewRuns", data.counts.runs);
        count.skip("reviewRuns", "stay readable in their review threads", data.counts.runs);
      } else unavailable.push({ plugin: "code-review", reason: review.reason });
      const butler = await exported("gitbutler", gitbutlerExportSchema);
      if (butler.ok) {
        for (const record of butler.value.records) {
          const kind = (
            {
              threadBranches: "threadBranches",
              reviewRequests: "reviewRequests",
              conflictResolutions: "conflictResolutions",
            } as const
          )[record.kind as "threadBranches"];
          if (!kind) continue;
          count.read(kind);
          count.skip(
            kind,
            kind === "threadBranches"
              ? "re-read from thread history by Source Control"
              : "transient thread links; not carried over",
          );
        }
      } else unavailable.push({ plugin: "gitbutler", reason: butler.reason });
      return { unavailable, counts: count.report() };
    },
  };
}

export type Cutover = ReturnType<typeof createCutover>;
