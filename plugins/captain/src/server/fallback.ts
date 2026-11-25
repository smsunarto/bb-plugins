import { LADDER_ROLES, rungLabel, type LadderRole } from "../contract/ladder.ts";
import type { CheckDeps } from "./check.ts";
import {
  crewOnTask,
  joinCrew,
  readCrew,
  steer,
  type CrewThread,
  type ListedThread,
} from "./crew.ts";
import {
  pickRung,
  readPool,
  readRetryDecision,
  roleLadder,
  rungOfPresetName,
  rungPresetName,
  type PoolView,
} from "./ladder.ts";
import type { Captain } from "./registry.ts";
import { ROLE_SPECS } from "./roles.ts";
import { readRungChecks } from "./rung-checks.ts";
import { ensureRungPreset, spawnCrew } from "./spawn.ts";
import { reportedSince } from "./status.ts";
import { NOTICE, type Fallback } from "./store.ts";
import type { TasksPreset } from "./tasks-client.ts";

/**
 * The rate-limit fallback, one step of the background check. A crew thread
 * that failed on a provider rate limit before it reported is restarted on the
 * next eligible rung of its role's ladder: a new thread on the same task and
 * role, so the same brief, then the failed one archived, then one wake line.
 * Each failed thread gets one `fallbacks` row, and every pass advances the
 * open rows from what they record, so a pass cut off at its deadline is
 * finished by the next. Rungs only climb, so it cannot loop: after the last
 * rung the Captain is woken as blocked and nothing restarts.
 */

/**
 * With no answer from bb's provider-retry on the failed request, wait this
 * long after the error before restarting: provider-retry decides within
 * seconds, and a retry it queues must not race a restart.
 */
export const RETRY_GRACE_MS = 2 * 60_000;
/** A provider-retry decision observed this long before the error event still belongs to it. */
const DECISION_SLACK_MS = 5_000;

export async function runFallbacks(
  deps: CheckDeps,
  captain: Captain,
  threads: readonly ListedThread[],
  now: number,
): Promise<void> {
  const failed = threads.filter((thread) => isCandidate(deps, captain, thread));
  if (failed.length === 0 && deps.store.openFallbacks(captain.threadId).length === 0) return;

  const rows = await deps.tasks.crewSnapshot(threads.map((thread) => thread.id));
  const crew = joinCrew(deps, threads, rows);
  const reads = passReads(deps);
  for (const member of crew.filter((entry) => failed.includes(entry.thread))) {
    const verdict = await judge(deps, member, now);
    if (verdict === "wait") continue;
    if (verdict === "no") {
      deps.store.noticeFirstSeen(NOTICE.noFallback(member.thread.id, member.thread.updatedAt), now);
      continue;
    }
    await open(deps, captain, member, reads, now);
  }

  const lines: { key: string; failedThreadId: string; line: string }[] = [];
  for (const fallback of deps.store.openFallbacks(captain.threadId)) {
    await deps.taskGuard(fallback.taskKey, () => advance(deps, captain, fallback, reads));
    const after = deps.store.fallback(fallback.failedThreadId);
    const line = after === null ? null : wakeLine(deps, after);
    const key = NOTICE.fallbackWake(fallback.failedThreadId);
    // Claimed first, so a pass that overlaps one past its deadline sends no second line.
    if (line !== null && deps.store.claimNotice(key, now)) {
      lines.push({ key, failedThreadId: fallback.failedThreadId, line });
    }
  }
  if (lines.length === 0) return;
  try {
    await steer(deps.bb, captain.threadId, lines.map((entry) => entry.line).join("\n"), null);
    for (const entry of lines) deps.store.setFallbackWoke(entry.failedThreadId, deps.now());
  } catch (error) {
    for (const entry of lines) deps.store.releaseNotice(entry.key, now);
    deps.bb.log.warn(`fallback wake for ${captain.threadId} not sent: ${(error as Error).message}`);
  }
}

/** What one pass reads at most once, on first need, for every fallback it opens or advances. */
type Reads = {
  pool: () => Promise<PoolView | null>;
  /** Tasks' presets; rejects when Tasks does not answer. */
  presets: () => Promise<TasksPreset[]>;
};

function passReads(deps: CheckDeps): Reads {
  let pool: Promise<PoolView | null> | undefined;
  let presets: Promise<TasksPreset[]> | undefined;
  return {
    pool: () => (pool ??= readPool(deps.bb)),
    presets: () => (presets ??= deps.tasks.listPresets()),
  };
}

/** A failed crew thread of a laddered role that owes a report and was not judged yet. */
function isCandidate(deps: CheckDeps, captain: Captain, thread: ListedThread): boolean {
  if (thread.status !== "error") return false;
  const role = deps.store.crewRole(thread.id);
  return (
    role !== null &&
    role.captainId === captain.threadId &&
    (LADDER_ROLES as readonly string[]).includes(role.role) &&
    role.reportDueSince !== null &&
    deps.store.fallback(thread.id) === null &&
    deps.store.noticeSeenAt(NOTICE.noFallback(thread.id, thread.updatedAt)) === null
  );
}

/**
 * `fallback` for a rate limit bb will not retry itself; `no` for anything
 * else, judged once per thread update; `wait` while provider-retry may still
 * decide.
 */
async function judge(
  deps: CheckDeps,
  member: CrewThread,
  now: number,
): Promise<"fallback" | "no" | "wait"> {
  const due = member.crewRole?.reportDueSince ?? null;
  if (due === null || reportedSince(member, due) || member.rows[0] === undefined) return "no";
  const [event] = await deps.bb.sdk.threads.events.list({
    threadId: member.thread.id,
    types: ["provider/error"],
    order: "desc",
    limit: "1",
  });
  if (event === undefined || !isRateLimit(event.data)) return "no";
  const decision = await readRetryDecision(deps.bb, member.thread.id);
  if (
    decision !== undefined &&
    decision !== null &&
    decision.observedAt >= event.createdAt - DECISION_SLACK_MS
  ) {
    // A queued retry is bb's to run; if it fails again the thread updates and is judged anew.
    return decision.decision.kind === "retry" ? "no" : "fallback";
  }
  return now - event.createdAt >= RETRY_GRACE_MS ? "fallback" : "wait";
}

/**
 * Quota and rate-limit wording an agent puts in its error text. ACP agents
 * such as Antigravity report errors as text only: bb records them as
 * `{ message: "Provider error", detail }` with no `errorInfo`. The phrases are
 * the Antigravity CLI's (`agy`) own quota messages and Google API statuses, not
 * a bare "quota": a crash's detail carries agy's stderr, which logs `/quota`.
 */
const QUOTA_TEXT =
  /RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|exhausted your (?:quota|capacity)|out of quota|quota (?:exceeded|reached)|rate.?limit|Too Many Requests/iu;

/** A provider error that is a rate limit or an exhausted Account Pooler. */
export function isRateLimit(data: unknown): boolean {
  const error = data as {
    detail?: unknown;
    message?: unknown;
    errorInfo?: { category?: unknown; httpStatusCode?: unknown } | null;
  };
  const info = error.errorInfo ?? null;
  if (info?.category === "rate-limit" || info?.httpStatusCode === 429) return true;
  const text = `${String(error.detail ?? "")} ${String(error.message ?? "")}`;
  if (/No Account Pooler account is currently eligible|\b429\b/u.test(text)) return true;
  // A provider that classified its error said what it was; only unclassified text is read for quota.
  return info === null && QUOTA_TEXT.test(text);
}

/**
 * Record the failed thread's fallback: the next eligible rung, or none. When
 * a read the rung checks need fails, nothing is recorded: the thread stays a
 * candidate and the next pass picks again, so an unread check never pins the
 * fallback to a rung bb would refuse.
 */
async function open(
  deps: CheckDeps,
  captain: Captain,
  member: CrewThread,
  reads: Reads,
  now: number,
): Promise<void> {
  const crewRole = member.crewRole;
  const row = member.rows[0];
  if (crewRole === null || row === undefined) return;
  const role = crewRole.role as LadderRole;
  const ladder = roleLadder(deps.store, role).rungs;
  const presets = await reads.presets().catch(() => null);
  const read = await readRungChecks(deps.bb, {
    role,
    ladderLength: ladder.length,
    presets,
    bbProjectId:
      captain.repos.find((repo) => row.task.key.startsWith(`${repo.tasksProjectKey}-`))
        ?.bbProjectId ?? null,
    rungPresetName: (rung) => rungPresetName(role, rung),
  });
  if (read.unread) {
    deps.bb.log.warn(
      `fallback for ${member.thread.id} waits for the next pass: presets or a provider list not read`,
    );
    return;
  }
  const from = crewRole.rung ?? rungOfPresetName(row.presetName);
  const fromSpec = ladder[from - 1];
  const choice = pickRung(ladder, await reads.pool(), now, { after: from, checks: read.checks });
  deps.store.openFallback({
    failedThreadId: member.thread.id,
    captainId: captain.threadId,
    taskId: row.task.id,
    taskKey: row.task.key,
    role,
    fromRung: from,
    fromLabel: fromSpec === undefined ? row.presetName : rungLabel(fromSpec),
    toRung: choice.rung,
    toLabel: choice.rung === null ? null : rungLabel(choice.spec),
    baseBranch: crewRole.baseBranch,
    skipped: choice.skipped,
    createdAt: now,
  });
}

/**
 * One step closer to the wake: start the new thread, then archive the failed
 * one. A live thread already on the task and role, such as one the Captain
 * dispatched by hand or a start a cut-off pass made, counts as the restart.
 */
async function advance(
  deps: CheckDeps,
  captain: Captain,
  fallback: Fallback,
  reads: Reads,
): Promise<void> {
  if (fallback.toRung === null) return;
  const role = fallback.role as LadderRole;
  try {
    if (fallback.newThreadId === null) {
      const crew = await readCrew(deps, captain.threadId);
      const live = crewOnTask(crew, fallback.taskKey, role).find(
        (member) => member.thread.id !== fallback.failedThreadId,
      );
      if (live !== undefined) {
        deps.store.setFallbackThread(fallback.failedThreadId, live.thread.id);
      } else {
        const spec = roleLadder(deps.store, role).rungs[fallback.toRung - 1];
        if (spec === undefined) throw new Error(`${role} has no rung ${fallback.toRung} now`);
        const preset = await ensureRungPreset(
          deps,
          role,
          fallback.toRung,
          spec,
          await reads.presets(),
        );
        const started = await spawnCrew(deps, captain, {
          taskId: fallback.taskId,
          taskKey: fallback.taskKey,
          role,
          preset,
          rung: fallback.toRung,
          baseBranch: fallback.baseBranch ?? undefined,
          known: new Set(crew.map((member) => member.thread.id)),
        });
        for (const note of started.notes) deps.bb.log.info(note);
        deps.store.setFallbackThread(fallback.failedThreadId, started.threadId);
      }
    }
    if (!fallback.archived) {
      await deps.bb.sdk.threads.archive({ threadId: fallback.failedThreadId });
      deps.store.setFallbackArchived(fallback.failedThreadId);
    }
  } catch (error) {
    // Tasks or bb did not answer: the row keeps what is done, and the next pass resumes it.
    deps.bb.log.warn(
      `fallback for ${fallback.failedThreadId} paused, next pass retries: ${(error as Error).message}`,
    );
  }
}

/** The Captain's wake line once the fallback is done, or null while it is not. */
function wakeLine(deps: CheckDeps, fallback: Fallback): string | null {
  const vars = {
    task: fallback.taskKey,
    role: ROLE_SPECS[fallback.role].label,
    failed: fallback.failedThreadId,
    from: fallback.fromRung,
    fromLabel: fallback.fromLabel,
    skipped: fallback.skipped.length === 0 ? "" : ` Skipped ${fallback.skipped.join("; ")}.`,
  };
  if (fallback.toRung === null) return deps.files.read("fallback-blocked", vars);
  if (fallback.newThreadId === null || !fallback.archived) return null;
  return deps.files.read("fallback-restarted", {
    ...vars,
    to: fallback.toRung,
    toLabel: fallback.toLabel ?? "",
    thread: fallback.newThreadId,
  });
}
