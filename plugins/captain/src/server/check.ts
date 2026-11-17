import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sinceTag } from "../contract/rpc.ts";
import { ANSWER_MAX_ATTEMPTS, deliverAnswer } from "./asks.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { joinCrew, listChildren, steer, type ListedThread } from "./crew.ts";
import { sendPush } from "./push.ts";
import type { Captain } from "./registry.ts";
import { ROLE_SPECS, roleOfPreset } from "./roles.ts";
import { age, crewState } from "./status.ts";
import { NOTICE } from "./store.ts";
import type { CrewRow } from "./tasks-client.ts";

/**
 * The background check: one pass a minute while any Captain has live crew or
 * an answer still being retried, otherwise idle until a Captain gains a child.
 * A pass wakes a Captain once per stall, retries undelivered answers, and
 * sends the once-only pushes. Every once-only effect is claimed in `notices`
 * before it is sent, so a reload or two overlapping passes send it at most once.
 *
 * Per Captain a pass costs one `threads.list` of its children, plus one
 * `crewSnapshot` over only the idle children and those with no role row; no
 * interactions, archived children or PR reads.
 */

export const CHECK_INTERVAL_MS = 60_000;
/** With no crew and no answer to retry, a pass runs on a thread event, or this often as a safety net. */
export const IDLE_INTERVAL_MS = 15 * 60_000;
/** How long a stall lasts, from the pass that first saw it, before the Captain is woken. */
export const STALL_WAKE_AFTER_MS = 15 * 60_000;
/** One Captain's reads and sends; a slower Captain is skipped this pass, not waited for. */
const CAPTAIN_DEADLINE_MS = 20_000;
const CAPTAIN_CONCURRENCY = 4;
/** One answer retry's send, so a hung send cannot hold the pass. */
const SEND_DEADLINE_MS = 20_000;

export type CheckDeps = Pick<CommandDeps, "bb" | "store" | "registry" | "tasks" | "files" | "now">;

export type PassResult = {
  /** The next pass runs in a minute; otherwise only on a thread event or the idle interval. */
  busy: boolean;
  /** Captains whose pass was skipped because a read failed or ran past its deadline. */
  skipped: string[];
};

export type Check = ReturnType<typeof createCheck>;

export function createCheck(deps: CheckDeps) {
  let poked = false;
  let wakeSleep: (() => void) | null = null;
  let running: Promise<PassResult> | null = null;

  /** Run the next pass soon. Never waits for it. */
  function poke(): void {
    poked = true;
    wakeSleep?.();
  }

  /** One pass; a call while one runs shares it, so passes never overlap within this instance. */
  function pass(signal?: AbortSignal): Promise<PassResult> {
    running ??= runPass(signal).finally(() => {
      running = null;
    });
    return running;
  }

  async function runPass(signal: AbortSignal | undefined): Promise<PassResult> {
    const captains = deps.store
      .liveCaptains()
      .map(({ archivedAt: _archived, ...captain }) => captain);
    const skipped: string[] = [];
    const outcomes = await mapLimit(captains, CAPTAIN_CONCURRENCY, async (captain) => {
      try {
        return await withDeadline(checkCaptain(deps, captain, signal), CAPTAIN_DEADLINE_MS);
      } catch (error) {
        deps.bb.log.warn(`check skipped ${captain.threadId}: ${(error as Error).message}`);
        skipped.push(captain.threadId);
        return { crew: 0 };
      }
    });
    await retryAnswers(deps);
    const busy =
      skipped.length > 0 ||
      outcomes.some((outcome) => outcome.crew > 0) ||
      deps.store.undeliveredAnswers(ANSWER_MAX_ATTEMPTS).length > 0;
    return { busy, skipped };
  }

  return {
    pass,
    poke,
    /** Register the service loop and the events that end an idle wait. */
    register(bb: Pick<BbPluginApi, "background" | "events" | "log">): void {
      const nudge = ({ thread }: { thread: { parentThreadId: string | null } }) => {
        if (deps.registry.get(thread.parentThreadId) !== null) poke();
      };
      bb.events.on("thread.created", nudge);
      bb.events.on("experimental_thread.parentChanged", nudge);
      bb.background.service("check", {
        async start(signal) {
          while (!signal.aborted) {
            poked = false;
            let busy = true;
            try {
              busy = (await pass(signal)).busy;
            } catch (error) {
              bb.log.warn(`check pass failed: ${(error as Error).message}`);
            }
            if (poked) continue;
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                wakeSleep = null;
                resolve();
              };
              const timer = setTimeout(done, busy ? CHECK_INTERVAL_MS : IDLE_INTERVAL_MS);
              signal.addEventListener("abort", done, { once: true });
              wakeSleep = done;
            });
          }
        },
      });
    },
  };
}

/** One Captain's part of a pass. Any failed read throws, so nothing is written from a partial view. */
async function checkCaptain(
  deps: CheckDeps,
  captain: Captain,
  signal: AbortSignal | undefined,
): Promise<{ crew: number }> {
  const now = deps.now();
  const threads = await listChildren(deps.bb, captain.threadId, false, signal);
  for (const thread of threads) {
    if (thread.status !== "error") continue;
    // A failure first seen now is a Since you left transition.
    if (deps.store.noticeFirstSeen(NOTICE.failed(thread.id), now) === now) {
      deps.bb.rpc.experimental_invalidate([sinceTag(captain.threadId)]);
    }
  }
  // Only an idle thread can stall, and only a thread with no role row needs one backfilled.
  const needRows = threads.filter(
    (thread) =>
      (thread.status === "idle" && !thread.hasPendingInteraction) ||
      deps.store.crewRole(thread.id) === null,
  );
  const rows =
    needRows.length === 0 ? [] : await deps.tasks.crewSnapshot(needRows.map((t) => t.id));
  backfillRoles(deps, captain, needRows, rows);
  recordCommandWaits(deps, threads, now);

  const stalls: { key: string; line: string }[] = [];
  for (const member of joinCrew(deps, threads, rows)) {
    const due = member.crewRole?.reportDueSince ?? null;
    if (due === null) continue;
    const key = NOTICE.stall(member.thread.id, due);
    if (crewState(member, now) !== "stalled") {
      // Seen moving again before its wake: the next stall starts a fresh clock.
      deps.store.clearUnsentNotice(key);
      continue;
    }
    const first = deps.store.noticeFirstSeen(key, now);
    if (now - first < STALL_WAKE_AFTER_MS || deps.store.noticeSentAt(key) !== null) continue;
    const label = member.role === null ? "-" : ROLE_SPECS[member.role].label;
    const task = member.rows[0]?.task.key ?? "-";
    stalls.push({ key, line: `${task} ${member.thread.id} ${label} ${age(now, first)}` });
  }
  await wakeForStalls(deps, captain, stalls, now);
  await pushUndeliverable(deps, captain, rows, now);
  return { crew: threads.length };
}

/** A child with no role row gets one from its Tasks preset, owing a report since it was created. */
function backfillRoles(
  deps: CheckDeps,
  captain: Captain,
  threads: readonly ListedThread[],
  rows: readonly CrewRow[],
): void {
  for (const thread of threads) {
    if (deps.store.crewRole(thread.id) !== null) continue;
    const preset = rows
      .filter((row) => row.threadId === thread.id)
      .sort((a, b) => b.attachedAt.localeCompare(a.attachedAt))[0]?.presetName;
    const role = preset === undefined ? null : roleOfPreset(preset);
    if (role === null) continue;
    deps.store.ensureCrewRole({
      threadId: thread.id,
      captainId: captain.threadId,
      role,
      reportDueSince: thread.createdAt,
      contractSent: true,
    });
  }
}

/** Start the background-command allowance when a pass first sees it; forget it once the thread moves. */
function recordCommandWaits(deps: CheckDeps, threads: readonly ListedThread[], now: number): void {
  for (const thread of threads) {
    const due = deps.store.crewRole(thread.id)?.reportDueSince ?? null;
    if (due === null) continue;
    const key = NOTICE.command(thread.id, due);
    const { activeBackgroundAgentCount, activeWorkflowCount, activeBackgroundCommandCount } =
      thread.activity;
    const commandsOnly =
      thread.status === "idle" &&
      !thread.hasPendingInteraction &&
      activeBackgroundAgentCount + activeWorkflowCount === 0 &&
      activeBackgroundCommandCount > 0;
    if (commandsOnly) deps.store.noticeFirstSeen(key, now);
    else deps.store.clearUnsentNotice(key);
  }
}

/** One wake line for every stall that came due this pass; a failed send is retried next pass. */
async function wakeForStalls(
  deps: CheckDeps,
  captain: Captain,
  stalls: readonly { key: string; line: string }[],
  now: number,
): Promise<void> {
  const claimed = stalls.filter((stall) => deps.store.claimNotice(stall.key, now));
  if (claimed.length === 0) return;
  try {
    await steer(
      deps.bb,
      captain.threadId,
      deps.files.read("stall", { stalls: claimed.map((stall) => stall.line).join("; ") }),
    );
  } catch (error) {
    for (const stall of claimed) deps.store.releaseNotice(stall.key, now);
    deps.bb.log.warn(`stall wake for ${captain.threadId} not sent: ${(error as Error).message}`);
  }
}

/** One push per report Tasks gave up delivering. A failed push is not retried: the row still shows. */
async function pushUndeliverable(
  deps: CheckDeps,
  captain: Captain,
  rows: readonly CrewRow[],
  now: number,
): Promise<void> {
  for (const row of rows) {
    const comment = row.lastNotifyingComment;
    if (comment?.delivery.state !== "undeliverable") continue;
    if (!deps.store.claimNotice(NOTICE.undeliverablePush(comment.id), now)) continue;
    const warning = await sendPush(deps.bb, {
      title: `Report not delivered: ${row.task.key}`,
      body: `${captain.name} Captain · ${row.threadId} · ${comment.delivery.reason ?? "unknown"}`,
      threadId: captain.threadId,
    });
    if (warning !== null) deps.bb.log.warn(warning);
  }
}

/** Retry each due answer once; the send that reaches the cap pushes once. */
async function retryAnswers(deps: CheckDeps): Promise<void> {
  // The check owns retries, so a failed send here does not wake it again.
  const sendDeps = { ...deps, wakeCheck: () => {} };
  for (const ask of deps.store.undeliveredAnswers(ANSWER_MAX_ATTEMPTS)) {
    if (ask.answer === null) continue;
    if (ask.nextDeliveryAt !== null && ask.nextDeliveryAt > deps.now()) continue;
    // A send past its deadline counts as failed here; it may still land, and then marks delivery.
    const warning = await withDeadline(
      deliverAnswer(sendDeps, { ...ask, answer: ask.answer }),
      SEND_DEADLINE_MS,
    ).catch((error: unknown) => `answer send timed out: ${(error as Error).message}`);
    if (warning === null) continue;
    const after = deps.store.ask(ask.id);
    if (after === null || after.deliveryAttempts < ANSWER_MAX_ATTEMPTS) continue;
    if (!deps.store.claimNotice(NOTICE.answerPush(ask.id), deps.now())) continue;
    const captain = deps.registry.get(ask.captainId);
    const pushWarning = await sendPush(deps.bb, {
      title: `Answer not delivered: ${ask.text}`,
      body: `${captain?.name ?? "A"} Captain · ${ask.id} · retry with bb captain ask resolve`,
      threadId: ask.captainId,
    });
    if (pushWarning !== null) deps.bb.log.warn(pushWarning);
  }
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Map with at most `limit` calls in flight, results in input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
