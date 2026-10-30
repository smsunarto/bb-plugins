import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Cause, Effect, Schedule } from "effect";
import { z } from "zod";
import {
  type CommitRef,
  type Landed,
  type LandedCommit,
  type LandedPr,
  type LandedTarget,
  canStillLand,
  commitKey,
  landedTargetSchema,
  launchTitle,
  notLanded,
} from "../../shared/landed.ts";
import { type PrRef, prKey, sameRef } from "../../shared/schema.ts";
import { isNotFound } from "./activity.ts";
import type { CodeReviewContext } from "./context.ts";
import { type Gh, GhError } from "./gh.ts";
import { prState, restRepo } from "./github.ts";
import { createLocks } from "./lock.ts";
import { runDetached } from "./run.ts";

/*
 * A thread whose listed work has not all landed is remembered, so the server
 * can launch its title when the rest lands, even after the agent's turn:
 *
 *   landed:<threadId>   TrackRecord: the thread's latest list, and when it was made
 *
 * The record goes once everything lands and the title launched, once nothing
 * more can land (a pull request closed without merging), when GitHub cannot
 * find something listed, when the thread starts watching a pull request (new
 * work, which it lists in a later call), after two weeks, or with the thread.
 */
const RECHECK_MS = 3 * 60_000;
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const trackKey = (threadId: string) => `landed:${threadId}`;
const trackRecordSchema = z.strictObject({ target: landedTargetSchema, since: z.number() });
type TrackRecord = z.infer<typeof trackRecordSchema>;
/** The tool and the background check both decide on one thread's title and record. */
const withLock = createLocks();

export const LANDED_PR_QUERY = `query LandedPr($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { url title state }
  }
}`;

type GqlLandedPr = {
  repository: { pullRequest: { url: string; title: string; state: string } };
};

type RestCommit = { sha: string; html_url: string; commit: { message: string } };
type RestCompare = {
  ahead_by: number;
  merge_base_commit: RestCommit;
  commits: RestCommit[];
};

/** Names the reference a failed read was about, keeping what kind of failure it was. */
function about(key: string) {
  return (error: unknown): never => {
    const message = `${key}: ${error instanceof Error ? error.message : String(error)}`;
    throw error instanceof GhError ? new GhError(error.code, message) : new Error(message);
  };
}

/**
 * Whether each pull request merged and each commit is on its repository's
 * default branch, as GitHub reports now.
 */
export async function readLanded(
  gh: Gh,
  { prs, commits }: { prs: readonly PrRef[]; commits: readonly CommitRef[] },
): Promise<Landed> {
  const branches = new Map<string, Promise<string>>();
  const defaultBranch = (owner: string, repo: string) => {
    const key = `${owner}/${repo}`.toLowerCase();
    let branch = branches.get(key);
    if (!branch) {
      branch = (gh.rest(restRepo(owner, repo)) as Promise<{ default_branch: string }>).then(
        (repository) => repository.default_branch,
      );
      branches.set(key, branch);
    }
    return branch;
  };

  async function readPr(ref: PrRef): Promise<LandedPr> {
    const data = (await gh.graphql(LANDED_PR_QUERY, {
      owner: ref.owner,
      name: ref.repo,
      number: ref.number,
    })) as GqlLandedPr;
    const pr = data.repository.pullRequest;
    return { ref, title: pr.title, url: pr.url, state: prState(pr.state) };
  }

  async function readCommit(ref: CommitRef): Promise<LandedCommit> {
    const branch = await defaultBranch(ref.owner, ref.repo);
    // From the branch's tip to the commit: nothing ahead means the branch holds it.
    const compare = (await gh.rest(
      `${restRepo(ref.owner, ref.repo)}/compare/${encodeURIComponent(branch)}...${ref.sha}`,
    )) as RestCompare;
    const landed = compare.ahead_by === 0;
    const commit = landed
      ? compare.merge_base_commit
      : compare.commits.find((each) => each.sha.startsWith(ref.sha));
    return {
      ref: { ...ref, sha: commit?.sha ?? ref.sha },
      branch,
      landed,
      headline: commit?.commit.message.split("\n", 1)[0] ?? null,
      url: commit?.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/commit/${ref.sha}`,
    };
  }

  const [prStates, commitStates] = await Promise.all([
    Promise.all(prs.map((ref) => readPr(ref).catch(about(prKey(ref))))),
    Promise.all(commits.map((ref) => readCommit(ref).catch(about(commitKey(ref))))),
  ]);
  return { prs: prStates, commits: commitStates };
}

/**
 * Puts 🚀 in front of the thread's title while `launched`, and takes it off
 * otherwise. An unnamed thread gets its fallback title when it launches.
 * Returns the new title, or null when the title needed no change.
 */
export async function markLaunched(
  bb: BbPluginApi,
  threadId: string,
  launched: boolean,
): Promise<string | null> {
  const thread = await bb.sdk.threads.get({ threadId });
  const title = thread.title?.trim() || (launched ? thread.titleFallback?.trim() : null);
  if (!title) return null;
  const next = launchTitle(title, launched);
  if (next === thread.title) return null;
  await bb.sdk.threads.update({ threadId, title: next });
  return next;
}

/**
 * The thread watches `ref`, so it has open work again: takes the 🚀 off,
 * under the lock so a check in flight cannot launch over it. A pull request
 * the thread's list already holds stays checked; one it does not ends the
 * background check, and the agent lists it in a later call. For a tool whose
 * own work must not fail with it.
 */
export async function reopenLanded(
  ctx: CodeReviewContext,
  threadId: string,
  ref: PrRef,
): Promise<void> {
  const kv = ctx.bb.storage.kv;
  await withLock(threadId, async () => {
    const record = trackRecordSchema.safeParse(await kv.get(trackKey(threadId)));
    if (!record.success || !record.data.target.prs.some((each) => sameRef(each, ref))) {
      await kv.delete(trackKey(threadId));
    }
    await markLaunched(ctx.bb, threadId, false);
  }).catch((error: unknown) => {
    ctx.bb.log.warn(`Could not take 🚀 off thread ${threadId}'s title: ${String(error)}`);
  });
}

/**
 * What the thread landed and what it still waits on, as GitHub reports now.
 * Writes the title and the thread's record to match. `title` is the new
 * title, null when it needed no change, or undefined when bb refused it.
 */
export function checkLanded(
  ctx: CodeReviewContext,
  threadId: string,
  target: LandedTarget,
  /** A read of `target` the caller just made. */
  read?: Landed,
) {
  return withLock(threadId, async () => {
    // Checked under the lock, so a watch started while GitHub answered still counts.
    const unlisted = (await ctx.watcher.list(threadId)).filter(
      (watch) => !watch.ended && !target.prs.some((ref) => sameRef(ref, watch.ref)),
    );
    if (unlisted.length > 0) {
      throw new Error(
        `This thread watches ${unlisted.map((watch) => prKey(watch.ref)).join(", ")}. List it too, or stop its watch if it is not this thread's work.`,
      );
    }
    return reconcile(ctx, threadId, { target, since: Date.now() }, read);
  });
}

/**
 * {@link checkLanded} for a caller that holds the thread's lock. Once
 * `signal` aborts, a read it still has to make fails, so nothing is written.
 */
async function reconcile(
  ctx: CodeReviewContext,
  threadId: string,
  record: TrackRecord,
  read?: Landed,
  signal?: AbortSignal,
) {
  const landed =
    read ?? (await readLanded(ctx.github.as(record.target.account, signal), record.target));
  // The merge is heard: a watch of it would only wake the thread to say so again.
  const merged = landed.prs.filter((pr) => pr.state === "merged");
  await Promise.all(merged.map((pr) => ctx.watcher.stop(threadId, pr.ref)));
  const pending = notLanded(landed);
  const title = await markLaunched(ctx.bb, threadId, pending.length === 0).catch(
    (error: unknown) => {
      ctx.bb.log.warn(`Could not update thread ${threadId}'s title: ${String(error)}`);
      return undefined;
    },
  );
  // Keep checking while more can land, and until a launch bb refused goes through.
  const keep = pending.length > 0 ? canStillLand(landed) : title === undefined;
  const kv = ctx.bb.storage.kv;
  if (keep) await kv.set(trackKey(threadId), record);
  else await kv.delete(trackKey(threadId));
  return { landed, pending, title };
}

/** Drops a thread's record: it was archived or deleted. */
export async function forgetLanded(ctx: CodeReviewContext, threadId: string): Promise<void> {
  await ctx.bb.storage.kv.delete(trackKey(threadId));
}

/** Rechecks one remembered thread, from its record as it stands once the thread's lock is held. */
function recheckThread(
  ctx: CodeReviewContext,
  threadId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const kv = ctx.bb.storage.kv;
  const key = trackKey(threadId);
  return withLock(threadId, async () => {
    const record = trackRecordSchema.safeParse(await kv.get(key));
    if (!record.success || Date.now() - record.data.since > MAX_AGE_MS) return kv.delete(key);
    const thread = await ctx.bb.sdk.threads.get({ threadId }).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!thread || thread.archivedAt != null || thread.deletedAt != null) return kv.delete(key);
    return reconcile(ctx, threadId, record.data, undefined, signal).catch(
      async (error: unknown) => {
        // No later pass finds what GitHub cannot find now.
        if (error instanceof GhError && error.code === "not-found") await kv.delete(key);
        throw error;
      },
    );
  });
}

/**
 * Checks every remembered thread once, one after another. A failed check
 * keeps the record for the next pass. A pass that is stopped stops at the
 * thread it is on, before that thread's next read.
 */
function rechecking(ctx: CodeReviewContext) {
  return Effect.gen(function* () {
    for (const key of yield* Effect.promise(async () => ctx.bb.storage.kv.list("landed:"))) {
      const threadId = key.slice("landed:".length);
      yield* Effect.tryPromise({
        try: async (signal) => recheckThread(ctx, threadId, signal),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Could not check what thread ${threadId} landed: ${String(error)}`),
        ),
      );
    }
  });
}

/** One pass, for a caller outside the plugin's background service. */
export function recheckLanded(ctx: CodeReviewContext): Promise<void> {
  return runDetached(rechecking(ctx));
}

/** The body of the plugin's background service: a pass every few minutes, until it stops. */
export function watchLanded(ctx: CodeReviewContext) {
  return rechecking(ctx).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning(`Landed work check failed: ${String(Cause.squash(cause))}`),
    ),
    Effect.repeat(Schedule.spaced(RECHECK_MS)),
  );
}
