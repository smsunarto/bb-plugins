export type NamingIntent =
  | { kind: "automatic"; lastAssistantText: string | null }
  | { kind: "forced" };

export type ThreadNamingSkipReason =
  | "automatic-naming-disabled"
  | "archived-thread"
  | "child-thread"
  | "deleted-thread"
  | "hidden-thread"
  | "latest-turn-incomplete"
  | "latest-turn-not-user"
  | "missing-user-prompt"
  | "plugin-worker";

export type ThreadNamingWriteGuard =
  | { kind: "title-unchanged"; expectedTitle: string | null; expectedRequestSeq: number }
  | { kind: "replace-title" };

export type ThreadNamingPlan =
  | { kind: "skip"; reason: ThreadNamingSkipReason }
  | {
      kind: "run";
      intent: NamingIntent;
      userPrompt: string;
      prompt: string;
      allowedShipped: boolean;
      writeGuard: ThreadNamingWriteGuard;
    };

export interface NamingThreadFacts {
  archivedAt: number | null;
  deletedAt: number | null;
  originPluginId: string | null;
  parentThreadId: string | null;
  title: string | null;
  visibility: "hidden" | "visible";
}

interface NamingPromptInput {
  type: string;
  text?: string;
  visibility?: "agent-only";
}

export type ThreadNamingEvent =
  | { seq: number; type: "turn/completed" }
  | {
      seq: number;
      type: "client/turn/requested";
      data: {
        initiator: "agent" | "system" | "user";
        input: readonly NamingPromptInput[];
        retryOfRequestId?: string;
        target: { kind: string };
      };
    };

export interface PlanThreadNamingInput {
  automaticallyNameThreads: boolean;
  events: readonly ThreadNamingEvent[];
  intent: NamingIntent;
  pluginId: string;
  projectInstructions?: string;
  thread: NamingThreadFacts;
}

const MAX_USER_PROMPT_LENGTH = 4_000;
const MAX_PROJECT_INSTRUCTIONS_LENGTH = 8_000;
const MAX_NAMING_CONTEXT_LENGTH = 2_400;
const MAX_GENERATED_TITLE_LENGTH = 96;
const titleSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SHIP_REQUEST = /^ship it[.!]*$/iu;

const THREAD_TITLE_INSTRUCTIONS = `Return title (specific task nouns first, <=48 chars, questions stay questions), scope (product area(s) joined ' + '; empty if unclear; never repo), activity.
Classify requested work, never suggested next steps. Continue inherits the task. Completed implementation is build/fix, not verification because tests are next. review=code review; verify=running tests; questions/exploration=explore; writing skills/docs=build. ready needs confirmed readiness; shipped needs eligible=yes. Do not repeat scope in title.`;

export interface ThreadNamingPromptContext {
  priorUserPrompt?: string;
  currentTitle?: string | null;
  allowedShipped?: boolean;
}

export function renderThreadNamingPrompt(
  userPrompt: string,
  agentHandoff = "",
  projectInstructions = "",
  context: ThreadNamingPromptContext = {},
): string {
  const projectRules = normalizeProjectTitleInstructions(projectInstructions)
    .split("\n")
    .reduce(
      (selected, line) =>
        selected.length + line.length + 1 <= 500 ? `${selected}\n${line}` : selected,
      "",
    )
    .trim();
  const sections: readonly [string, string, number][] = [
    ["Current request", userPrompt, 1_000],
    ["Project title rules", projectRules, 500],
    [
      "Task anchor",
      context.priorUserPrompt === userPrompt ? "" : (context.priorUserPrompt ?? ""),
      300,
    ],
    ["Current title", context.currentTitle ?? "", 96],
    ["Latest handoff", agentHandoff, 800],
  ];
  let remaining = MAX_NAMING_CONTEXT_LENGTH;
  let prompt = `${THREAD_TITLE_INSTRUCTIONS}\nShipped eligible: ${context.allowedShipped === true ? "yes" : "no"}.`;
  for (const [label, value, limit] of sections) {
    const selected = value.trim().slice(0, Math.min(limit, remaining));
    if (selected === "") continue;
    prompt += `\n\n${label}:\n${selected}`;
    remaining -= selected.length;
  }
  return prompt;
}

export function normalizeProjectTitleInstructions(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim().slice(0, MAX_PROJECT_INSTRUCTIONS_LENGTH);
}

export function normalizeInitialUserPrompt(events: readonly ThreadNamingEvent[]): string {
  const initialRequest = events
    .filter(
      (event): event is Extract<ThreadNamingEvent, { type: "client/turn/requested" }> =>
        event.type === "client/turn/requested" &&
        event.data.initiator === "user" &&
        event.data.target.kind === "thread-start",
    )
    .sort((left, right) => left.seq - right.seq)[0];
  if (initialRequest === undefined) return "";

  return normalizeUserPrompt(initialRequest);
}

function normalizeUserPrompt(
  request: Extract<ThreadNamingEvent, { type: "client/turn/requested" }>,
): string {
  return request.data.input
    .filter(
      (input): input is NamingPromptInput & { type: "text"; text: string } =>
        input.type === "text" &&
        typeof input.text === "string" &&
        input.visibility !== "agent-only",
    )
    .map((input) => input.text.trim())
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_USER_PROMPT_LENGTH);
}

function turnRequests(
  events: readonly ThreadNamingEvent[],
): Extract<ThreadNamingEvent, { type: "client/turn/requested" }>[] {
  return events
    .filter(
      (event): event is Extract<ThreadNamingEvent, { type: "client/turn/requested" }> =>
        event.type === "client/turn/requested",
    )
    .sort((left, right) => left.seq - right.seq);
}

function userRequests(
  events: readonly ThreadNamingEvent[],
): Extract<ThreadNamingEvent, { type: "client/turn/requested" }>[] {
  return turnRequests(events).filter(
    (event) => event.data.initiator === "user" && event.data.retryOfRequestId === undefined,
  );
}

function isTaskSteering(prompt: string): boolean {
  return /^(?:please\s+)?(?:continue|keep going|go ahead|do it|do that|proceed|yes|yep|ok(?:ay)?|thanks|looks good|ship it)[.!\s]*$/iu.test(
    prompt,
  );
}

function shipmentSucceeded(handoff: string): boolean {
  return (
    /(?:^|[.!]\s+|\n)\s*(?:[-*]\s*)?(?:✅\s*)?(?:\*\*)?(?:I\s+)?(?:successfully\s+)?(?:shipped\b|pushed to\b|merged (?:into|to)\b|deployed to\b|published to\b)/iu.test(
      handoff,
    ) &&
    !/\b(?:not|never|failed|blocked|interrupted|pending|attempted|will|would|could|should|if|example)\b|\?/iu.test(
      handoff,
    )
  );
}

export function planThreadNaming({
  automaticallyNameThreads,
  events,
  intent,
  pluginId,
  projectInstructions = "",
  thread,
}: PlanThreadNamingInput): ThreadNamingPlan {
  if (intent.kind === "automatic" && !automaticallyNameThreads) {
    return { kind: "skip", reason: "automatic-naming-disabled" };
  }
  if (thread.deletedAt !== null) return { kind: "skip", reason: "deleted-thread" };
  if (thread.visibility === "hidden") return { kind: "skip", reason: "hidden-thread" };
  if (thread.parentThreadId !== null) return { kind: "skip", reason: "child-thread" };
  if (thread.originPluginId === pluginId) return { kind: "skip", reason: "plugin-worker" };
  if (intent.kind === "automatic" && thread.archivedAt !== null) {
    return { kind: "skip", reason: "archived-thread" };
  }

  const latestRequest =
    intent.kind === "automatic" ? turnRequests(events).at(-1) : userRequests(events).at(-1);
  if (latestRequest === undefined) return { kind: "skip", reason: "missing-user-prompt" };
  if (intent.kind === "automatic") {
    if (
      latestRequest.data.initiator !== "user" ||
      latestRequest.data.retryOfRequestId !== undefined
    ) {
      return { kind: "skip", reason: "latest-turn-not-user" };
    }
    if (!events.some((event) => event.type === "turn/completed" && event.seq > latestRequest.seq)) {
      return { kind: "skip", reason: "latest-turn-incomplete" };
    }
  }

  const userPrompt = normalizeUserPrompt(latestRequest);
  if (userPrompt === "") return { kind: "skip", reason: "missing-user-prompt" };
  const agentHandoff = intent.kind === "automatic" ? (intent.lastAssistantText ?? "") : "";
  const steering = isTaskSteering(userPrompt);
  const userPrompts = userRequests(events)
    .filter((event) => event.seq <= latestRequest.seq)
    .map(normalizeUserPrompt);
  const priorUserPrompt =
    userPrompt.length <= 160 || steering
      ? userPrompts
          .slice(0, -1)
          .reverse()
          .find((prompt) => prompt !== "" && prompt !== userPrompt && !isTaskSteering(prompt))
      : undefined;
  const lastActionablePrompt = userPrompts
    .slice()
    .reverse()
    .find((prompt) => prompt !== "" && (!isTaskSteering(prompt) || SHIP_REQUEST.test(prompt)));
  const allowedShipped =
    SHIP_REQUEST.test(lastActionablePrompt ?? "") && shipmentSucceeded(agentHandoff);

  return {
    kind: "run",
    intent,
    userPrompt,
    prompt: renderThreadNamingPrompt(userPrompt, agentHandoff, projectInstructions, {
      priorUserPrompt,
      currentTitle: steering ? thread.title : null,
      allowedShipped,
    }),
    allowedShipped,
    writeGuard:
      intent.kind === "automatic"
        ? {
            kind: "title-unchanged",
            expectedTitle: thread.title,
            expectedRequestSeq: latestRequest.seq,
          }
        : { kind: "replace-title" },
  };
}

export function sanitizeGeneratedTitle(value: string, allowedShipped = false): string | null {
  const normalized = (allowedShipped ? value : value.replace(/☑️?/gu, ""))
    .trim()
    .replace(/\s+/gu, " ");
  const title = Array.from(titleSegmenter.segment(normalized), ({ segment }) => segment)
    .slice(0, MAX_GENERATED_TITLE_LENGTH)
    .join("")
    .trimEnd();
  const task = title.replace(/^[^\p{L}\p{N}[]+/u, "").replace(/^(?:\[[^\]]*\]\s*)+/u, "");
  return /[\p{L}\p{N}]/u.test(task) ? title : null;
}
