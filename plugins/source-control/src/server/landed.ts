/**
 * Work a thread landed. The agent lists its pull requests and default-branch
 * commits once something lands; the card shows them with a button that
 * settles the thread, and the thread's title starts with 🚀 while everything
 * listed has landed. A thread whose list has not all landed is kept in
 * `landed_track`, and the `landed` service checks it every three minutes so
 * the title launches after the agent's turn too.
 *
 * The record goes once everything lands and the title launched, once nothing
 * more can land, when GitHub cannot find something listed, when the thread
 * watches a pull request its list lacks, after two weeks, or with the thread.
 * Ported from `plugins/code-review/src/server/lib/landed.ts`.
 */
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { z } from "zod";
import {
  canStillLand,
  landedDirective,
  landedTargetSchema,
  launchTitle,
  loginSchema,
  MAX_LANDED,
  notLanded,
  parseCommitReference,
  parsePrReference,
  prKey,
  sameCommit,
  sameRef,
  type Landed,
  type LandedTarget,
  type PrRef,
} from "../core/watch.ts";
import type { SiteOutcome } from "./forge-sites.ts";
import { createLocks, type PrWatcher } from "./pr-watch.ts";
import type { Store } from "./store.ts";

export const SHARE_LANDED = "source_control_share_landed";

const files = instructionFiles(import.meta.url);
const RECHECK_MS = 3 * 60_000;
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;

export const trackRecordSchema = z
  .object({ target: landedTargetSchema, since: z.number() })
  .strict();
export type TrackRecord = z.infer<typeof trackRecordSchema>;

type Read = (
  login: string | null,
  listed: Pick<LandedTarget, "prs" | "commits">,
  threadId: string,
) => Promise<SiteOutcome<Landed>>;

export function createLanded(deps: {
  bb: BbPluginApi;
  store: Store;
  watcher: PrWatcher;
  read: Read;
  now: () => number;
  standingDown: () => boolean;
}) {
  const { bb, store, watcher } = deps;
  const withLock = createLocks();

  const record = (threadId: string): TrackRecord | null => {
    const json = store.landedRow(threadId);
    if (json === null) return null;
    try {
      const parsed = trackRecordSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  /** 🚀 in front of the title while launched, not otherwise. Null when nothing changed. */
  async function markLaunched(threadId: string, launched: boolean): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    const title = thread.title?.trim() || (launched ? thread.titleFallback?.trim() : null);
    if (!title) return null;
    const next = launchTitle(title, launched);
    if (next === thread.title) return null;
    await bb.sdk.threads.update({ threadId, title: next });
    return next;
  }

  const readOrThrow = async (target: LandedTarget, threadId: string) => {
    const outcome = await deps.read(target.account, target, threadId);
    if (!outcome.ok) throw Object.assign(new Error(outcome.message), { reason: outcome.reason });
    return outcome.value;
  };

  /** Holds the thread's lock: writes the title and record to match what landed. */
  async function reconcile(threadId: string, track: TrackRecord, read?: Landed) {
    const landed = read ?? (await readOrThrow(track.target, threadId));
    // The merge is heard: a watch of it would only wake the thread to say so again.
    await Promise.all(
      landed.prs.filter((pr) => pr.state === "merged").map((pr) => watcher.stop(threadId, pr.ref)),
    );
    const pending = notLanded(landed);
    const title = await markLaunched(threadId, pending.length === 0).catch((error: unknown) => {
      bb.log.warn(`Could not update thread ${threadId}'s title: ${String(error)}`);
      return undefined;
    });
    // Keep checking while more can land, and until a launch bb refused goes through.
    const keep = pending.length > 0 ? canStillLand(landed) : title === undefined;
    if (keep) store.putLanded(threadId, JSON.stringify(track));
    else store.dropLanded(threadId);
    return { landed, pending, title };
  }

  async function recheck(threadId: string): Promise<void> {
    await withLock(threadId, async () => {
      const track = record(threadId);
      if (!track || deps.now() - track.since > MAX_AGE_MS) return store.dropLanded(threadId);
      const thread = await bb.sdk.threads.get({ threadId }).catch((error: unknown) => {
        if (/not found/i.test(String(error))) return null;
        throw error;
      });
      if (!thread || thread.archivedAt != null || thread.deletedAt != null)
        return store.dropLanded(threadId);
      const outcome = await deps.read(track.target.account, track.target, threadId);
      // A site that is away is asked again on the next pass.
      if (!outcome.ok) {
        if (outcome.reason === "gone") store.dropLanded(threadId);
        return;
      }
      await reconcile(threadId, track, outcome.value);
    });
  }

  async function pass(): Promise<void> {
    if (deps.standingDown()) return;
    for (const threadId of store.landedThreads())
      await recheck(threadId).catch((error: unknown) =>
        bb.log.warn(`Could not check what thread ${threadId} landed: ${String(error)}`),
      );
  }

  const parameters = z
    .object({
      pullRequests: z.array(z.string().min(1)).max(MAX_LANDED).optional(),
      commits: z.array(z.string().min(1)).max(MAX_LANDED).optional(),
      account: loginSchema.optional(),
    })
    .strict();

  return {
    /** The thread watches `ref`, so it has open work again: the 🚀 comes off. */
    async reopen(threadId: string, ref: PrRef): Promise<void> {
      await withLock(threadId, async () => {
        const track = record(threadId);
        if (!track?.target.prs.some((each) => sameRef(each, ref))) store.dropLanded(threadId);
        await markLaunched(threadId, false);
      }).catch((error: unknown) => {
        bb.log.warn(`Could not take 🚀 off thread ${threadId}'s title: ${String(error)}`);
      });
    },

    forget(threadId: string): void {
      store.dropLanded(threadId);
    },

    /** Takes a record the cutover read from code-review; false when the thread already has one. */
    adopt(threadId: string, track: TrackRecord): boolean {
      if (record(threadId)) return false;
      store.putLanded(threadId, JSON.stringify(track));
      return true;
    },

    pass,

    service: {
      start(signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const tick = () => {
            if (signal.aborted) return;
            pass()
              .catch((error: unknown) => bb.log.warn(`Landed work check failed: ${String(error)}`))
              .finally(() => {
                if (!signal.aborted) timer = setTimeout(tick, RECHECK_MS);
              });
          };
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
          tick();
        });
      },
    },

    /** Checks what the thread landed, marks its title with 🚀 while all of it has, and returns the card. */
    tool: {
      name: SHARE_LANDED,
      ...files.tool(SHARE_LANDED),
      presentation: {
        label: { pending: "Checking landed work", completed: "Checked landed work" },
      },
      parameters,
      async execute(
        { pullRequests = [], commits = [], account }: z.output<typeof parameters>,
        { threadId }: PluginAgentToolContext,
      ) {
        const prs = pullRequests.map((reference) => {
          const ref = parsePrReference(reference);
          if (!ref)
            throw new Error(`${reference}: use a GitHub pull request URL or owner/repo#123.`);
          return ref;
        });
        const commitRefs = commits.map((reference) => {
          const ref = parseCommitReference(reference);
          if (!ref) throw new Error(`${reference}: use owner/repo@<sha> or a GitHub commit URL.`);
          return ref;
        });
        if (prs.length + commitRefs.length === 0)
          throw new Error(
            "List the pull requests and default-branch commits this thread delivered.",
          );
        const listed = {
          prs: prs.filter((ref, i) => prs.findIndex((other) => sameRef(other, ref)) === i),
          commits: commitRefs.filter(
            (ref, i) => commitRefs.findIndex((other) => sameCommit(other, ref)) === i,
          ),
        };
        // Read before anything is written: work that has not landed at all leaves the title alone.
        const outcome = await deps.read(account ?? null, listed, threadId);
        if (!outcome.ok) throw new Error(outcome.message);
        const target: LandedTarget = { account: outcome.login, ...listed };
        const unlanded = notLanded(outcome.value);
        if (unlanded.length === listed.prs.length + listed.commits.length)
          throw new Error(
            `Nothing listed has landed yet: ${unlanded.join(", ")}. Call again once a pull request merges or the commits reach the default branch.`,
          );
        const { landed, pending, title } = await withLock(threadId, async () => {
          // Checked under the lock, so a watch started while GitHub answered still counts.
          const unlisted = watcher
            .list(threadId)
            .filter((watch) => !watch.ended && !listed.prs.some((ref) => sameRef(ref, watch.ref)));
          if (unlisted.length > 0)
            throw new Error(
              `This thread watches ${unlisted.map((watch) => prKey(watch.ref)).join(", ")}. List it too, or stop its watch if it is not this thread's work.`,
            );
          return reconcile(threadId, { target, since: deps.now() }, outcome.value);
        });
        const directive = landedDirective({
          account: target.account,
          prs: landed.prs.map((pr) => pr.ref),
          commits: landed.commits.map((commit) => commit.ref),
        });
        const note =
          pending.length === 0
            ? title === undefined
              ? "Everything listed has landed, but the thread title could not be updated."
              : "Everything listed has landed; the thread title starts with 🚀."
            : `Not landed yet: ${pending.join(", ")}. The title gets 🚀 once all of it lands.`;
        return `${directive}\n\n${note}`;
      },
    },
  };
}

export type LandedWork = ReturnType<typeof createLanded>;
