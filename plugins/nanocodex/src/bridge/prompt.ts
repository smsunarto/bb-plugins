/**
 * `src/bridge/prompt.ts` — history to prompt text, as a pure function.
 *
 * Internal to `continuity.ts`; nothing else imports it. Exported so its tests
 * can drive it directly with hand-built states, which is the point: the single
 * hardest judgement in this plugin — what the model is told about earlier
 * turns, and what gets dropped when that does not fit — is one pure function
 * with no process, no file, and no clock. Per boundary-discipline the shell
 * stays thin and the policy is testable without spawning anything.
 *
 * Determinism is load-bearing, not stylistic: the result becomes the child's
 * argv, the recorder captures argv in the `bridge->provider` lane, and the
 * parity test replays it. No timestamps, no counters outside the state, no
 * `Math.random`.
 */

import type { ContinuityState, LedgerTurn, TurnAction } from "./continuity.ts";

/** What the render did, so the caller can report elision without re-deriving it. */
export interface RenderedPrompt {
  readonly text: string;
  readonly bytes: number;
  readonly elidedTurns: number;
}

/**
 * How much of a turn survives the budget. Degradation is graded rather than a
 * cliff: a turn loses its actions, then its commentary, then everything but a
 * one-line marker. A cliff would drop the task definition from a long session
 * and leave the model confidently wrong.
 */
export type TurnTier = "full" | "summary" | "elided";

/** Per-field cap; a single pasted log must not consume the whole budget. */
const MAX_FIELD_BYTES = 6_000;

/** Floor for the adaptive re-render cap when pinned + recent overflow. */
const MIN_FIELD_BYTES = 256;

/** Estimated bytes of one turn's `## Turn N - ...` headings. */
const TURN_HEADINGS_BYTES = 64;

const HISTORY_HEADER =
  "Earlier turns of this conversation, oldest first. You are a fresh session; " +
  "this is a record, not your memory. Files changed below are already on disk.";

function cappedBytes(text: string, cap: number): number {
  return Math.min(byteLength(text), cap);
}

function renderAction(action: TurnAction): string {
  switch (action.kind) {
    case "command":
      return action.exitCode === null
        ? `- $ ${action.command}`
        : `- $ ${action.command} (exit ${action.exitCode})`;
    case "fileChange":
      return `- edited ${action.paths.join(", ")}`;
    case "tool":
      return action.brief.length === 0
        ? `- ${action.tool}`
        : `- ${action.tool}: ${action.brief}`;
  }
}

function turnCost(turn: LedgerTurn, tier: "full" | "summary", cap: number): number {
  let cost =
    cappedBytes(turn.userText, cap) + cappedBytes(turn.final, cap) + TURN_HEADINGS_BYTES;
  if (tier === "full") {
    for (const commentary of turn.commentary) cost += cappedBytes(commentary, cap);
    for (const action of turn.actions) cost += byteLength(renderAction(action)) + 1;
  }
  return cost;
}

/**
 * Assign a tier to every turn within `budgetBytes`.
 *
 *   pinned    the FIRST turn's user text always survives at `summary` or
 *             better — it is where the task was stated, and a session that
 *             forgets its task is worse than one that forgets its middle.
 *   recent    the last two turns always survive at `full`.
 *   the rest  `full` from newest backwards while the budget allows, then
 *             `summary`, then `elided`.
 *
 * Total: it always returns an assignment, and if pinned + recent alone exceed
 * the budget `renderPrompt` truncates their long texts in the middle rather
 * than overflowing.
 */
export function planTiers(
  turns: readonly LedgerTurn[],
  budgetBytes: number,
): ReadonlyMap<number, TurnTier> {
  const tiers = new Map<number, TurnTier>();
  for (const turn of turns) tiers.set(turn.ordinal, "elided");
  if (turns.length === 0) return tiers;

  let spend = 0;
  const recent = turns.slice(-2);
  for (const turn of recent) {
    tiers.set(turn.ordinal, "full");
    spend += turnCost(turn, "full", MAX_FIELD_BYTES);
  }
  const first = turns[0]!;
  if (tiers.get(first.ordinal) === "elided") {
    tiers.set(first.ordinal, "summary");
    spend += turnCost(first, "summary", MAX_FIELD_BYTES);
  }

  const middleNewestFirst = turns
    .slice(0, -2)
    .filter((turn) => tiers.get(turn.ordinal) === "elided")
    .reverse();
  for (const turn of middleNewestFirst) {
    const cost = turnCost(turn, "summary", MAX_FIELD_BYTES);
    if (spend + cost > budgetBytes) break;
    tiers.set(turn.ordinal, "summary");
    spend += cost;
  }
  const summaryNewestFirst = [...turns]
    .reverse()
    .filter((turn) => tiers.get(turn.ordinal) === "summary");
  for (const turn of summaryNewestFirst) {
    const upgrade =
      turnCost(turn, "full", MAX_FIELD_BYTES) - turnCost(turn, "summary", MAX_FIELD_BYTES);
    if (spend + upgrade > budgetBytes) break;
    tiers.set(turn.ordinal, "full");
    spend += upgrade;
  }
  return tiers;
}

function takeBytesFromStart(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function takeBytesFromEnd(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

/** The head states intent and the tail states the outcome; the middle is the
 *  part that can go. */
function truncateMiddle(text: string, maxBytes: number): string {
  const total = byteLength(text);
  if (total <= maxBytes) return text;
  const headBytes = Math.max(1, Math.floor(maxBytes / 2));
  const tailBytes = Math.max(1, maxBytes - headBytes);
  const head = takeBytesFromStart(text, headBytes);
  const tail = takeBytesFromEnd(text, tailBytes);
  const omitted = total - byteLength(head) - byteLength(tail);
  return `${head} ... [${omitted} bytes omitted] ... ${tail}`;
}

function renderHistory(
  state: ContinuityState,
  tiers: ReadonlyMap<number, TurnTier>,
  cap: number,
): string {
  const lines: string[] = ["<bb-thread-history>", HISTORY_HEADER];
  if (state.baseSummary !== null) {
    const count = (state.baseThrough ?? 0) + 1;
    lines.push(
      `[summary of ${count} earlier turns: ${truncateMiddle(state.baseSummary, cap)}]`,
    );
  }
  let elidedRun = 0;
  const flushElided = (): void => {
    if (elidedRun === 0) return;
    lines.push(`[${elidedRun} earlier exchanges omitted]`);
    elidedRun = 0;
  };
  for (const turn of state.turns) {
    const tier = tiers.get(turn.ordinal) ?? "elided";
    if (tier === "elided") {
      elidedRun += 1;
      continue;
    }
    flushElided();
    lines.push("", `## Turn ${turn.ordinal} - user`, truncateMiddle(turn.userText, cap));
    const prose =
      tier === "full" && turn.commentary.length > 0
        ? [...turn.commentary, turn.final].filter((text) => text.length > 0)
        : turn.final.length > 0
          ? [turn.final]
          : [];
    lines.push(`## Turn ${turn.ordinal} - assistant`);
    if (prose.length > 0) {
      lines.push(...prose.map((text) => truncateMiddle(text, cap)));
    } else {
      lines.push(`(no answer; the turn ${turn.status === "completed" ? "was empty" : turn.status})`);
    }
    if (tier === "full" && turn.actions.length > 0) {
      lines.push(`### Turn ${turn.ordinal} - actions`);
      lines.push(...turn.actions.map((action) => truncateMiddle(renderAction(action), cap)));
    }
  }
  flushElided();
  lines.push("</bb-thread-history>");
  return lines.join("\n");
}

/**
 * Render the prompt body: history, then the live request.
 *
 * The layout is tagged so the model can tell a record of the past from the
 * thing it is being asked to do now. It also says plainly that the workspace
 * on disk already reflects the history, which is what stops a fresh session
 * from redoing finished edits.
 *
 *   <bb-thread-history>
 *   Earlier turns of this conversation, oldest first. You are a fresh session;
 *   this is a record, not your memory. Files changed below are already on disk.
 *   [summary of 6 earlier turns: ...]        <- baseSummary, when compacted
 *   [4 earlier exchanges omitted]            <- elided run
 *
 *   ## Turn 7 - user
 *   ...
 *   ## Turn 7 - assistant
 *   ...
 *   ### Turn 7 - actions
 *   - $ od -An -t c hello.txt (exit 0)
 *   - edited hello.txt
 *   </bb-thread-history>
 *
 *   <bb-request>
 *   ...the new input...
 *   </bb-request>
 *
 * With no history the `<bb-thread-history>` block is omitted entirely and the
 * prompt is exactly the user's text — a first turn must not pay for machinery
 * it does not use, and the fixtures show a bare "hello" already costs 13.4k
 * input tokens before we add a byte.
 */
export function renderPrompt(args: {
  state: ContinuityState;
  /** Flattened from `PromptInput[]` by the caller. */
  userText: string;
  budgetBytes: number;
}): RenderedPrompt {
  const { state, userText, budgetBytes } = args;
  if (state.turns.length === 0 && state.baseSummary === null) {
    return { text: userText, bytes: byteLength(userText), elidedTurns: 0 };
  }
  const tiers = planTiers(state.turns, budgetBytes);
  const elidedTurns = state.turns.filter(
    (turn) => (tiers.get(turn.ordinal) ?? "elided") === "elided",
  ).length;

  let history = renderHistory(state, tiers, MAX_FIELD_BYTES);
  if (byteLength(history) > budgetBytes) {
    const fields = Math.max(1, history.split("\n").length);
    const tighterCap = Math.max(MIN_FIELD_BYTES, Math.floor(budgetBytes / fields));
    history = renderHistory(state, tiers, tighterCap);
  }
  const text = `${history}\n\n<bb-request>\n${userText}\n</bb-request>`;
  return { text, bytes: byteLength(text), elidedTurns };
}

/**
 * Flatten `PromptInput[]` to text.
 *
 * nanocodex takes one positional string and reads no stdin, so images and file
 * blocks cannot be handed over as content. `localFile`/`localImage` become a
 * path mention the agent can open itself (it has filesystem tools and the same
 * cwd); a remote `image` url becomes the url. `visibility: "agent-only"` blocks
 * are included — they are meant for the agent.
 */
export function flattenPromptInput(input: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of input) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as { type?: unknown; text?: unknown; path?: unknown; url?: unknown };
    switch (record.type) {
      case "text":
        if (typeof record.text === "string" && record.text.length > 0) parts.push(record.text);
        break;
      case "localFile":
      case "localImage":
        if (typeof record.path === "string" && record.path.length > 0) {
          parts.push(`(see the file at ${record.path})`);
        }
        break;
      case "image":
        if (typeof record.url === "string" && record.url.length > 0) {
          parts.push(`(see the image at ${record.url})`);
        }
        break;
      default:
        break;
    }
  }
  return parts.join("\n\n");
}

/** Bytes, not UTF-16 units: the budget is about what the model is charged for. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
