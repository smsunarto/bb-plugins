import { asksTag } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { steer } from "./crew.ts";
import { Refusal, type Blocker, type Item } from "./output.ts";
import { sendPush } from "./push.ts";
import type { Captain } from "./registry.ts";
import { SHIP_READY_REVIEWS } from "./roles.ts";
import { NOTICE, type Answerer, type Ask, type AskKind } from "./store.ts";
import { TasksError, type TasksTask } from "./tasks-client.ts";
import { clip, displayWidth } from "./width.ts";

/**
 * Asks: the open decisions waiting on the user. Rules live here so `ask` and
 * `verdict --ship` open asks the same way.
 */

export const ASK_TEXT_MAX = 80;
/**
 * An option is a banner button, so every option fits on one row: at most 12
 * columns, where an emoji or a wide East Asian character counts 2. The
 * "Recommended" tag the banner and the `Asked:` comment add sits outside the
 * label and is not counted. `openAsk` checks it only for a new ask: stored
 * asks keep their labels.
 */
export const ASK_OPTION_COLUMNS = 12;
/**
 * An option must fit the answer field: one line of at most 80 UTF-16 units.
 * An identical rerun can keep labels stored before this rule.
 */
const ASK_OPTION_UNITS = ASK_TEXT_MAX;
/** A refused option is echoed from its first 64 units, cut to 24 columns. */
const ECHO_UNITS = 64;
const ECHO_COLUMNS = 24;
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

/** Draft blockers other than the new ask's column limit and task lookup. */
export function askBlockers(
  draft: Omit<AskDraft, "task"> & { taskKey: string | null },
  storedOptions?: readonly string[],
): Blocker[] {
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
  blockers.push(...optionListBlockers(draft.kind, options, storedOptions));
  return blockers;
}

/** The list and answer field rules for a draft's trimmed options. */
function optionListBlockers(
  kind: AskKind,
  options: readonly string[],
  storedOptions: readonly string[] | undefined,
): Blocker[] {
  if (kind === "ship") {
    return options.length === 0
      ? []
      : [{ reason: "a ship ask's options are always Merge and Hold", fix: "drop --option" }];
  }
  const blockers: Blocker[] = [];
  if (kind === "decision" && options.length < 2) {
    blockers.push({
      reason: "a decision ask needs two or more options, the recommended one first",
      fix: "pass --option <recommended> --option <other>",
    });
  }
  if (options.length === 1 && kind !== "decision") {
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
  const checkLabels = storedOptions === undefined || !sameOptions(storedOptions, options);
  for (const option of checkLabels ? options.slice(0, OPTIONS_MAX) : []) {
    if (/[\r\n]/u.test(option)) {
      blockers.push({
        reason: `option ${echo(option)} spans lines; an option is one line`,
        fix: "put it on one line; move the detail into --detail-file",
      });
    } else if (option.length > ASK_OPTION_UNITS) {
      blockers.push({
        reason: `option ${echo(option)} is ${option.length} UTF-16 units; an option is at most ${ASK_OPTION_UNITS}`,
        fix: "shorten it; move the detail into --detail-file",
      });
    }
  }
  if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
    blockers.push({ reason: "two options are the same", fix: "drop the duplicate --option" });
  }
  return blockers;
}

/**
 * The column rule for a new ask's trimmed options: each fits a banner button.
 * `openAsk` runs it only when no open ask matches, so a rerun of an older ask
 * still retries its push.
 */
export function optionLabelBlockers(options: readonly string[]): Blocker[] {
  return options.slice(0, OPTIONS_MAX).flatMap((option): Blocker[] => {
    const columns = displayWidth(option);
    if (columns <= ASK_OPTION_COLUMNS) return [];
    return [
      {
        reason: `option ${echo(option)} is ${columns} columns; an option is ≤${ASK_OPTION_COLUMNS} columns (wide characters count 2), so the buttons fit on one row`,
        fix: 'shorten it to a label, such as "Redis", with no ⭐ or other marker; move the detail into --detail-file',
      },
    ];
  });
}

function refuseUnlessLabelsFit(options: readonly string[]): void {
  const blockers = optionLabelBlockers(options);
  if (blockers.length > 0) throw new Refusal(blockers);
}

/** An option quoted for a blocker, bounded in size however long it is. */
function echo(option: string): string {
  const cutsPair = /[\u{10000}-\u{10ffff}]/u.test(option.slice(ECHO_UNITS - 1, ECHO_UNITS + 1));
  const head = option.slice(0, cutsPair ? ECHO_UNITS - 1 : ECHO_UNITS);
  const candidate = head.length < option.length && !head.endsWith("…") ? head + "…" : head;
  const clipped = clip(candidate, ECHO_COLUMNS);
  const label = clipped !== candidate && clipped.endsWith("……") ? clipped.slice(0, -1) : clipped;
  return JSON.stringify(label).replace(
    /[\u007f-\u009f\u2028\u2029\p{Bidi_Control}]/gu,
    (value) => "\\u" + value.charCodeAt(0).toString(16).padStart(4, "0"),
  );
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

/** A full commit id, the only head a ship ask may name. */
export const FULL_SHA = /^[0-9a-f]{40}$/u;

/** The answer that closes a ship ask a newer head replaced; it is never delivered. */
export const SUPERSEDED = "Superseded";

/** The head a ship ask's detail names, from its leading `Review <verdict> at <sha>.`. */
function shipAskHead(detail: string): string | null {
  return /^Review \S+ at ([0-9a-f]{40})\./u.exec(detail)?.[1] ?? null;
}

/**
 * Close the task's open ship asks that no longer match its review verdict:
 * every one when the verdict is not ship-ready, else each that names another
 * head. A Merge on such an ask would cover commits no review approved. The
 * review field is the task's, so this covers every Captain's asks on it, not
 * only the recording Captain's. Each is answered `Superseded` and the task
 * gets a comment from the recording Captain. Another Captain's ask is sent its
 * answer as a resolved ask is, so that Captain stops waiting on a Merge; the
 * background check retries a failed send. The recording Captain gets no send.
 */
export async function supersedeShipAsks(
  deps: CommandDeps,
  captain: Captain,
  task: TasksTask,
  verdict: { value: string; head: string | null },
): Promise<string[]> {
  const notes: string[] = [];
  const head = verdict.head?.toLowerCase() ?? null;
  const keep = SHIP_READY_REVIEWS.has(verdict.value) ? head : null;
  const recorded = `review ${verdict.value}${head === null ? "" : ` at ${head}`}`;
  const stale = deps.store
    .openAsksOnTask(task.key)
    .filter((ask) => ask.kind === "ship")
    .filter((ask) => keep === null || shipAskHead(ask.detail) !== keep);
  for (const ask of stale) {
    const at = deps.now();
    deps.store.answerAsk(ask.id, SUPERSEDED, "captain", at);
    const own = ask.captainId === captain.threadId;
    // The recording Captain knows; another Captain hears it, so it stops waiting on a Merge.
    if (own) deps.store.markAnswerDelivered(ask.id, at);
    const owner = own
      ? null
      : (deps.registry.get(ask.captainId) ?? deps.store.captain(ask.captainId));
    const whose = owner === null ? "" : `, the ${owner.name} Captain's ship ask,`;
    const warning = await captainComment(
      deps,
      captain,
      task.id,
      `${SUPERSEDED}: ${ask.id}${whose} does not match the recorded ${recorded}; a Merge on it grants nothing.`,
    );
    notes.push(`${ask.id} superseded: it does not match the recorded ${recorded}`);
    if (warning !== null) notes.push(`warning: ${warning}`);
    const answered = own ? null : deps.store.ask(ask.id);
    if (answered !== null && answered.answer !== null && answered.answerDeliveredAt === null) {
      const failed = await deliverAnswer(deps, { ...answered, answer: answered.answer });
      if (failed !== null)
        notes.push(`warning: ${ask.id}: ${failed}; the background check retries it`);
    }
  }
  if (stale.length > 0) {
    const owners = new Set(stale.map((ask) => ask.captainId));
    deps.bb.rpc.experimental_invalidate([...owners].map(asksTag));
  }
  return notes;
}

/**
 * Open an ask, or return the open one with the same kind, task and text, so a
 * rerun opens nothing twice. A new ask is posted on its task as an `Asked:`
 * comment and sends one push; the push is retried on a rerun until it is sent.
 * Throws a Refusal if a new ask's labels exceed the column limit.
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
  // No await between this lookup and the insert, so the ask a rerun matches
  // cannot be answered in between and let a new ask skip the column rule.
  if (existing === null) refuseUnlessLabelsFit(options);
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
  notes.push(...ignoredOptions(existing, options));
  return { item: askItem(ask, existing === null ? "open" : "exists"), notes };
}

/** A rerun of an open ask keeps its stored options; say so when it gave different ones. */
function ignoredOptions(existing: Ask | null, options: readonly string[]): string[] {
  if (existing === null || options.length === 0) return [];
  return sameOptions(existing.options, options)
    ? []
    : [
        `note: ${existing.id} is already open, so it keeps its options; the new --option values were ignored`,
      ];
}

function sameOptions(stored: readonly string[], supplied: readonly string[]): boolean {
  return stored.length === supplied.length && stored.every((option, i) => option === supplied[i]);
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
      answeredBy: ask.answeredBy,
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

/** The ask an id such as `A7` names, or a refusal. */
export function askOrRefuse(store: Pick<CommandDeps["store"], "ask">, address: string): Ask {
  const id = address.trim().toLowerCase();
  const ask = store.ask(id);
  if (ask === null) throw new Refusal([{ reason: `no ask ${id}`, fix: "bb captain status" }]);
  return ask;
}

/**
 * Who answers `ask` from `fromThread`, or a refusal: the user from no thread;
 * the ask's own Captain thread, except for a ship ask's first answer; no one else.
 */
function answerer(ask: Ask, fromThread: string | null): Answerer {
  if (fromThread === null) return "user";
  if (fromThread !== ask.captainId) {
    throw new Refusal([
      {
        reason: `${ask.id} is the user's to answer; ${fromThread} is not its Captain`,
        fix: `report the answer you need to its Captain (${ask.captainId})`,
      },
    ]);
  }
  if (ask.kind === "ship" && ask.answer === null) {
    throw new Refusal([
      {
        reason: `${ask.id} is a ship ask; only the user answers Merge or Hold`,
        fix: "leave it in the user's banner",
      },
    ]);
  }
  return "captain";
}

export type Resolved = { ask: Ask; state: "answered" | "undelivered"; notes: string[] };

/**
 * Answer an ask: record the answer and who gave it once, post it on the task,
 * and send it to the Captain. `bb captain ask resolve` and the banner both run
 * this; a rerun with the same answer only retries an undelivered send.
 * `fromThread` is the calling thread, or null for the user (the banner or a
 * terminal). Only the ask's own Captain thread may answer from a thread, and
 * never a ship ask's first answer: Merge is the user's alone. Throws a `Refusal`.
 */
export async function resolveAsk(
  deps: CommandDeps,
  address: string,
  rawAnswer: string,
  fromThread: string | null,
): Promise<Resolved> {
  // The user's shell has no thread, so the ask itself names its Captain.
  const ask = askOrRefuse(deps.store, address);
  const { id } = ask;
  const answer = rawAnswer.trim();
  const by = answerer(ask, fromThread);
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
      fix:
        ask.kind === "ship"
          ? `once Review has passed: bb captain verdict ${ask.taskKey ?? "<task>"} review passed --head <sha> --ship`
          : "open a new ask with bb captain ask",
    });
  }
  if (blockers.length > 0 || captain === null) throw new Refusal(blockers);

  const notes: string[] = [];
  if (ask.answer === null) {
    deps.store.answerAsk(id, answer, by, deps.now());
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
