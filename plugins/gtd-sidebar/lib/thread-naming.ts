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
  | { kind: "title-unchanged"; expectedTitle: string | null }
  | { kind: "replace-title" };

export type ThreadNamingPlan =
  | { kind: "skip"; reason: ThreadNamingSkipReason }
  | {
      kind: "run";
      intent: NamingIntent;
      userPrompt: string;
      prompt: string;
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
const MAX_AGENT_HANDOFF_LENGTH = 4_000;
const MAX_PROJECT_INSTRUCTIONS_LENGTH = 8_000;
const MAX_GENERATED_TITLE_LENGTH = 36;

const THREAD_TITLE_INSTRUCTIONS = `You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.
The task usually has to do with coding work, such as fixing a bug, changing a feature, or answering a question about a codebase.
Generate a concise UI title of at most 36 characters.
Use a single line of plain text only.
Do not include quotes, markdown, formatting characters, or trailing punctuation.
Use sentence case: capitalize only the first word, proper nouns, and identifiers. Do not use Title Case.
If the prompt includes a ticket reference, include it verbatim.
Prefer an imperative verb when the user is asking for a change.
Do not answer the user or attempt the task.`;

export function renderThreadNamingPrompt(
  userPrompt: string,
  agentHandoff = "",
  projectInstructions = "",
): string {
  const handoff = normalizeAgentHandoff(agentHandoff);
  const project = normalizeProjectTitleInstructions(projectInstructions);
  return `${THREAD_TITLE_INSTRUCTIONS}${
    project === "" ? "" : `\n\nProject-specific title instructions:\n${project}`
  }\n\nUser prompt:\n${userPrompt}${
    handoff === ""
      ? ""
      : `\n\nUse the agent's last turn handoff message to understand the current task state.\n\nAgent's last turn handoff message:\n${handoff}`
  }`;
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

function normalizeAgentHandoff(value: string): string {
  return value.trim().slice(0, MAX_AGENT_HANDOFF_LENGTH);
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

  let userPrompt: string;
  let agentHandoff = "";
  if (intent.kind === "automatic") {
    if (thread.archivedAt !== null) return { kind: "skip", reason: "archived-thread" };
    const latestRequest = turnRequests(events).at(-1);
    if (latestRequest === undefined) return { kind: "skip", reason: "missing-user-prompt" };
    if (
      latestRequest.data.initiator !== "user" ||
      latestRequest.data.retryOfRequestId !== undefined
    ) {
      return { kind: "skip", reason: "latest-turn-not-user" };
    }
    if (!events.some((event) => event.type === "turn/completed" && event.seq > latestRequest.seq)) {
      return { kind: "skip", reason: "latest-turn-incomplete" };
    }
    userPrompt = normalizeUserPrompt(latestRequest);
    if (userRequests(events).length > 1) {
      agentHandoff = intent.lastAssistantText ?? "";
    }
  } else {
    userPrompt = normalizeInitialUserPrompt(events);
  }

  if (userPrompt === "") return { kind: "skip", reason: "missing-user-prompt" };

  return {
    kind: "run",
    intent,
    userPrompt,
    prompt: renderThreadNamingPrompt(userPrompt, agentHandoff, projectInstructions),
    writeGuard:
      intent.kind === "automatic"
        ? { kind: "title-unchanged", expectedTitle: thread.title }
        : { kind: "replace-title" },
  };
}

export function sanitizeGeneratedTitle(value: string): string | null {
  const title = value.trim().replace(/\s+/gu, " ");
  if (title.length === 0) return null;
  if (title.length <= MAX_GENERATED_TITLE_LENGTH) return title;

  const candidate = title.slice(0, MAX_GENERATED_TITLE_LENGTH + 1);
  const lastSpace = candidate.lastIndexOf(" ");
  return lastSpace > 0
    ? candidate.slice(0, lastSpace)
    : candidate.slice(0, MAX_GENERATED_TITLE_LENGTH);
}
