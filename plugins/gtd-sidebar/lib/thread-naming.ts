export type NamingIntent = { kind: "automatic" } | { kind: "forced" };

export type ThreadNamingSkipReason =
  | "automatic-naming-disabled"
  | "archived-thread"
  | "child-thread"
  | "completed-turn-count"
  | "deleted-thread"
  | "hidden-thread"
  | "missing-user-prompt"
  | "plugin-worker"
  | "title-already-set";

export type ThreadNamingWriteGuard = { kind: "title-still-blank" } | { kind: "replace-title" };

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
        target: { kind: string };
      };
    };

export interface PlanThreadNamingInput {
  automaticallyNameThreads: boolean;
  events: readonly ThreadNamingEvent[];
  intent: NamingIntent;
  pluginId: string;
  thread: NamingThreadFacts;
}

const MAX_USER_PROMPT_LENGTH = 4_000;
const MAX_GENERATED_TITLE_LENGTH = 36;

const THREAD_TITLE_PROMPT_PREFIX = `You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.
The task usually has to do with coding work, such as fixing a bug, changing a feature, or answering a question about a codebase.
Generate a concise UI title of at most 36 characters.
Use a single line of plain text only.
Do not include quotes, markdown, formatting characters, or trailing punctuation.
Use sentence case: capitalize only the first word, proper nouns, and identifiers. Do not use Title Case.
If the prompt includes a ticket reference, include it verbatim.
Prefer an imperative verb when the user is asking for a change.
Do not answer the user or attempt the task.

User prompt:
`;

export function renderThreadNamingPrompt(userPrompt: string): string {
  return `${THREAD_TITLE_PROMPT_PREFIX}${userPrompt}`;
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

  return initialRequest.data.input
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

export function planThreadNaming({
  automaticallyNameThreads,
  events,
  intent,
  pluginId,
  thread,
}: PlanThreadNamingInput): ThreadNamingPlan {
  if (intent.kind === "automatic" && !automaticallyNameThreads) {
    return { kind: "skip", reason: "automatic-naming-disabled" };
  }
  if (thread.deletedAt !== null) return { kind: "skip", reason: "deleted-thread" };
  if (thread.visibility === "hidden") return { kind: "skip", reason: "hidden-thread" };
  if (thread.parentThreadId !== null) return { kind: "skip", reason: "child-thread" };
  if (thread.originPluginId === pluginId) return { kind: "skip", reason: "plugin-worker" };

  if (intent.kind === "automatic") {
    if (thread.archivedAt !== null) return { kind: "skip", reason: "archived-thread" };
    if (thread.title !== null && thread.title.trim() !== "") {
      return { kind: "skip", reason: "title-already-set" };
    }
    if (events.filter((event) => event.type === "turn/completed").length !== 1) {
      return { kind: "skip", reason: "completed-turn-count" };
    }
  }

  const userPrompt = normalizeInitialUserPrompt(events);
  if (userPrompt === "") return { kind: "skip", reason: "missing-user-prompt" };

  return {
    kind: "run",
    intent,
    userPrompt,
    prompt: renderThreadNamingPrompt(userPrompt),
    writeGuard:
      intent.kind === "automatic" ? { kind: "title-still-blank" } : { kind: "replace-title" },
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
