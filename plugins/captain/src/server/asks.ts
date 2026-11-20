import { asksTag } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { steer } from "./crew.ts";
import { Refusal, type Blocker, type Item } from "./output.ts";
import { sendPush } from "./push.ts";
import type { Captain } from "./registry.ts";
import { SHIP_READY_REVIEWS } from "./roles.ts";
import { NOTICE, type Ask, type AskKind } from "./store.ts";
import { TasksError, type TasksTask } from "./tasks-client.ts";

/**
 * Asks: the open decisions waiting on the user. Rules live here so `ask` and
 * `verdict --ship` open asks the same way.
 */

export const ASK_TEXT_MAX = 80;
/**
 * An option is a banner button, so every option fits on one row. Counted in
 * graphemes, so an emoji or an accented letter is one. The "Recommended" tag
 * the banner and the `Asked:` comment add sits outside the label and is not
 * counted. Enforced only when an ask opens: stored asks keep their labels.
 */
export const ASK_OPTION_MAX = 12;
export const SHIP_OPTIONS = ["Merge", "Hold"] as const;
/** The banner picks options with keys 1 to 9. */
const OPTIONS_MAX = 9;

export type AskDraft = {
  kind: AskKind;
  task: TasksTask | null;
  text: string;
  detail: string;
  options: string[];
};

/** Every rule an ask must meet, checked before anything is written. */
export function askBlockers(draft: Omit<AskDraft, "task"> & { taskKey: string | null }): Blocker[] {
  const blockers: Blocker[] = [];
  const text = draft.text.trim();
  if (text === "" || text.length > ASK_TEXT_MAX || /[\r\n]/u.test(text)) {
    blockers.push({
      reason: `an ask is one imperative line of 1 to ${ASK_TEXT_MAX} characters (this is ${text.length})`,
      fix: 'shorten it, such as "Pick the Unity account for cloud crew"; put the rest in --detail',
    });
  }
  if (draft.detail.trim() === "") {
    blockers.push({
      reason: "an ask needs detail: what is blocked and why you recommend the first option",
      fix: "pass --detail <text> or --detail-file <path>",
    });
  }
  if ((draft.kind === "decision" || draft.kind === "ship") && draft.taskKey === null) {
    blockers.push({ reason: `a ${draft.kind} ask needs its task`, fix: "pass --task <key>" });
  }
  const options = draft.options.map((option) => option.trim());
  if (draft.kind === "ship") {
    if (options.length > 0) {
      blockers.push({
        reason: "a ship ask's options are always Merge and Hold",
        fix: "drop --option",
      });
    }
  } else {
    if (draft.kind === "decision" && options.length < 2) {
      blockers.push({
        reason: "a decision ask needs two or more options, the recommended one first",
        fix: "pass --option <recommended> --option <other>",
      });
    }
    if (options.length === 1 && draft.kind !== "decision") {
      blockers.push({
        reason: "one option is no choice",
        fix: "pass two or more --option values, or none",
      });
    }
    if (options.length > OPTIONS_MAX) {
      blockers.push({
        reason: `an ask takes at most ${OPTIONS_MAX} options`,
        fix: "keep the options that matter",
      });
    }
    if (options.some((option) => option === "")) {
      blockers.push({ reason: "an option is empty", fix: "drop the empty --option" });
    }
    blockers.push(...options.flatMap(longOptionBlocker));
    if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
      blockers.push({ reason: "two options are the same", fix: "drop the duplicate --option" });
    }
  }
  return blockers;
}

/** A blocker when one trimmed option is longer than a button label may be. */
function longOptionBlocker(option: string): Blocker[] {
  const length = graphemes(option);
  if (length <= ASK_OPTION_MAX) return [];
  return [
    {
      reason: `option "${option}" is ${length} characters; an option is at most ${ASK_OPTION_MAX}, so the buttons fit on one row`,
      fix: 'shorten it to a label, such as "Redis"; move the detail into --detail-file',
    },
  ];
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Characters as a reader counts them: one per grapheme, not per UTF-16 unit. */
function graphemes(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

/** The ship gate: a ship ask needs a `review` verdict of passed or skipped. */
export function shipBlockers(taskKey: string, review: string | null): Blocker[] {
  if (review !== null && SHIP_READY_REVIEWS.has(review)) return [];
  return [
    {
      reason:
        review === null ? `${taskKey} has no review verdict` : `${taskKey}'s review is ${review}`,
      fix:
        review === null
          ? `bb captain dispatch ${taskKey} --role Review, then bb captain verdict ${taskKey} review passed`
          : `bb captain verdict ${taskKey} review passed after the fix`,
    },
  ];
}

/**
 * Open an ask, or return the open one with the same kind, task and text, so a
 * rerun opens nothing twice. A new ask is posted on its task as an `Asked:`
 * comment and sends one push; the push is retried on a rerun until it is sent.
 */
export async function openAsk(
  deps: CommandDeps,
  captain: Captain,
  draft: AskDraft,
): Promise<{ item: Item; notes: string[] }> {
  const notes: string[] = [];
  const text = draft.text.trim();
  const taskKey = draft.task?.key ?? null;
  const options = draft.kind === "ship" ? [...SHIP_OPTIONS] : draft.options.map((o) => o.trim());
  const existing = deps.store.findOpenAsk(captain.threadId, draft.kind, taskKey, text);
  const ask =
    existing ??
    deps.store.openAsk({
      captainId: captain.threadId,
      taskKey,
      kind: draft.kind,
      text,
      detail: draft.detail.trim(),
      options,
      askedAt: deps.now(),
    });
  if (existing === null && draft.task !== null) {
    const body = [
      `Asked: ${text} (${ask.id})`,
      options.length === 0
        ? null
        : options
            .map((option, i) => `${i + 1}. ${option}${i === 0 ? " (recommended)" : ""}`)
            .join("\n"),
      ask.detail,
    ]
      .filter((part) => part !== null)
      .join("\n\n");
    const warning = await captainComment(deps, captain, draft.task.id, body);
    if (warning !== null) notes.push(`warning: ${warning}`);
  }
  if (existing === null) deps.bb.rpc.experimental_invalidate([asksTag(captain.threadId)]);
  const pushKey = NOTICE.askPush(ask.id);
  if (deps.store.noticeSentAt(pushKey) === null) {
    const warning = await sendPush(deps.bb, {
      title: text,
      body: `${captain.name} Captain${taskKey === null ? "" : ` · ${taskKey}`} · ${ask.kind}`,
      threadId: captain.threadId,
    });
    if (warning === null) deps.store.markNoticeSent(pushKey, deps.now());
    else notes.push(`warning: ${warning}`);
  }
  return { item: askItem(ask, existing === null ? "open" : "exists"), notes };
}

export function askItem(ask: Ask, state: string): Item {
  return {
    id: ask.id,
    ok: true,
    state,
    detail: [ask.kind, ask.taskKey ?? "-", ask.answer ?? ask.text].join("  "),
    data: {
      kind: ask.kind,
      task: ask.taskKey,
      text: ask.text,
      options: ask.options,
      answer: ask.answer,
      delivered: ask.answerDeliveredAt !== null,
    },
  };
}

/** A task comment that reads as the Captain's: an agent comment from its thread. */
export async function captainComment(
  deps: CommandDeps,
  captain: Captain,
  taskId: string,
  body: string,
): Promise<string | null> {
  try {
    await deps.tasks.createComment({
      taskId,
      body,
      author: `${captain.name} Captain`,
      threadId: captain.threadId,
    });
    return null;
  } catch (error) {
    if (!(error instanceof TasksError)) throw error;
    return `comment not posted: ${error.message}`;
  }
}

/** Sends of an answer before it becomes a health row; the same cap Tasks gives wake lines. */
export const ANSWER_MAX_ATTEMPTS = 6;
/** Wait after the nth failed send; the last delay repeats. */
export const ANSWER_BACKOFF_MS = [1, 2, 5, 15].map((minutes) => minutes * 60_000);

function retryDelayMs(attempt: number): number {
  return ANSWER_BACKOFF_MS[Math.min(attempt, ANSWER_BACKOFF_MS.length) - 1] ?? 60_000;
}

/**
 * Send the Captain one line with the answer. Each send first claims its
 * attempt, so `ask resolve` and the background check never send one attempt
 * twice; `answer delivered at` is set only when the send succeeds. The check
 * retries a failed send with backoff until `ANSWER_MAX_ATTEMPTS`; a rerun of
 * `ask resolve` tries again past the cap.
 */
export async function deliverAnswer(
  deps: Pick<CommandDeps, "bb" | "store" | "files" | "now" | "wakeCheck">,
  ask: Ask & { answer: string },
): Promise<string | null> {
  const attempt = ask.deliveryAttempts + 1;
  if (
    !deps.store.claimAnswerAttempt(ask.id, ask.deliveryAttempts, deps.now() + retryDelayMs(attempt))
  ) {
    return "answer not delivered to the Captain: another send of it is in flight";
  }
  // The attempt count decides when an answer turns into a health row.
  const changed = () => deps.bb.rpc.experimental_invalidate([asksTag(ask.captainId)]);
  const subject = ask.taskKey === null ? ask.text : `${ask.taskKey} ${ask.text}`;
  try {
    await steer(
      deps.bb,
      ask.captainId,
      deps.files.read("answer", { id: ask.id, answer: ask.answer, subject }),
      null,
    );
    deps.store.markAnswerDelivered(ask.id, deps.now());
    changed();
    return null;
  } catch (error) {
    changed();
    // The background check owns the retry; wake it in case it is idle.
    deps.wakeCheck();
    return `answer not delivered to the Captain: ${(error as Error).message}`;
  }
}

export type Resolved = { ask: Ask; state: "answered" | "undelivered"; notes: string[] };

/**
 * Answer an ask: record the answer once, post it on the task, and send it to
 * the Captain. `bb captain ask resolve` and the banner both run this; a rerun
 * with the same answer only retries an undelivered send. Throws a `Refusal`.
 */
export async function resolveAsk(
  deps: CommandDeps,
  address: string,
  rawAnswer: string,
): Promise<Resolved> {
  // The user's shell has no thread, so the ask itself names its Captain.
  const id = address.trim().toLowerCase();
  const answer = rawAnswer.trim();
  const ask = deps.store.ask(id);
  if (ask === null) throw new Refusal([{ reason: `no ask ${id}`, fix: "bb captain status" }]);
  const captain = deps.registry.get(ask.captainId);
  const blockers: Blocker[] = [];
  if (captain === null) {
    blockers.push({ reason: `${id}'s Captain is archived`, fix: "nothing to answer" });
  }
  if (answer === "" || /[\r\n]/u.test(answer)) {
    blockers.push({ reason: "an answer is one line of words", fix: '--answer "Merge"' });
  }
  if (ask.answer !== null && ask.answer !== answer) {
    blockers.push({
      reason: `${id} was already answered ${JSON.stringify(ask.answer)}`,
      fix: "open a new ask with bb captain ask",
    });
  }
  if (blockers.length > 0 || captain === null) throw new Refusal(blockers);

  const notes: string[] = [];
  if (ask.answer === null) {
    deps.store.answerAsk(id, answer, deps.now());
    deps.bb.rpc.experimental_invalidate([asksTag(ask.captainId)]);
    if (ask.taskKey !== null) {
      const task = await deps.tasks.getTaskByKey(ask.taskKey).catch(() => null);
      const warning =
        task === null
          ? `comment not posted: task ${ask.taskKey} not read`
          : await captainComment(deps, captain, task.id, `Answered: ${answer} (${id})`);
      if (warning !== null) notes.push(`warning: ${warning}`);
    }
  }
  const answered = deps.store.ask(id);
  if (answered === null || answered.answer === null) throw new Error(`${id} lost its answer`);
  let state: Resolved["state"] = "answered";
  if (answered.answerDeliveredAt === null) {
    const warning = await deliverAnswer(deps, { ...answered, answer: answered.answer });
    if (warning !== null) {
      state = "undelivered";
      notes.push(`warning: ${warning}; rerun this command to retry`);
    }
  }
  return { ask: deps.store.ask(id) ?? answered, state, notes };
}
