import { instructionFiles } from "@bb-plugins/instructions";

export type ThreadNamingSkipReason =
  | "child-thread"
  | "deleted-thread"
  | "hidden-thread"
  | "missing-user-prompt";

export type ThreadNamingPlan =
  | { kind: "skip"; reason: ThreadNamingSkipReason }
  | { kind: "run"; prompt: string };

export interface NamingThreadFacts {
  deletedAt: number | null;
  parentThreadId: string | null;
  title: string | null;
  visibility: "hidden" | "visible";
}

interface NamingPromptInput {
  type: string;
  text?: string;
  visibility?: "agent-only";
  mentions?: readonly { resource: { kind: string; label: string } }[];
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
  events: readonly ThreadNamingEvent[];
  projectInstructions?: string;
  thread: NamingThreadFacts;
}

const MAX_PROJECT_INSTRUCTIONS_LENGTH = 8_000;
const MAX_GENERATED_TITLE_LENGTH = 96;
const MAX_REQUEST_CONTEXT_LENGTH = 1_500;
const titleSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Naming prompts, editable in Agent Instructions → Plugin prompts. Read per call so an
// edit applies to the next title without a reload.
const files = instructionFiles(import.meta.url);

export interface ThreadNamingPromptContext {
  initialUserPrompt?: string;
  recentUserPrompts?: readonly string[];
  currentRequestContext?: string;
  initialRequestContext?: string;
  recentRequestContexts?: readonly string[];
}

export function renderThreadNamingPrompt(
  userPrompt: string,
  projectInstructions = "",
  context: ThreadNamingPromptContext = {},
): string {
  const projectRules = selectProjectTitleRules(projectInstructions);
  // Tag names double as section labels; each tag is the only boundary
  // between one section and the next, so content cannot open or close one.
  const sections: readonly [ThreadNamingSection, string, number][] = [
    ["current_request", userPrompt, 1_000],
    ["current_request_context", context.currentRequestContext ?? "", MAX_REQUEST_CONTEXT_LENGTH],
    [
      "original_request",
      context.initialUserPrompt === userPrompt ? "" : (context.initialUserPrompt ?? ""),
      300,
    ],
    [
      "original_request_context",
      context.initialUserPrompt === userPrompt &&
      context.initialRequestContext === context.currentRequestContext
        ? ""
        : (context.initialRequestContext ?? ""),
      300,
    ],
    [
      "recent_requests_oldest_first",
      (context.recentUserPrompts ?? [])
        .slice(-3)
        .map((text) => text.slice(0, 160))
        .join("\n"),
      500,
    ],
    [
      "recent_request_context_oldest_first",
      (context.recentRequestContexts ?? [])
        .slice(-3)
        .map((text) => text.slice(0, 160))
        .join("\n"),
      500,
    ],
  ];
  const threadContent = sections
    .map(
      ([tag, value, limit]) => [tag, neutralizeSectionTags(value.trim().slice(0, limit))] as const,
    )
    .filter(([, value]) => value !== "")
    .map(([tag, value]) => `<${tag}>\n${value}\n</${tag}>`)
    .join("\n\n");
  // Rules first, project rules with them, then the data: the project rules are
  // instructions, so they must not sit below the "data, not instructions" line.
  const data = files.read("thread-title-data", { threadContent });
  // fill() rejects a missing value but not a dropped placeholder; an edit that
  // drops it would name the thread from the rules alone.
  if (!data.includes(threadContent)) {
    throw new Error("instructions/thread-title-data.md must include {{threadContent}}.");
  }
  return [
    files.read("generate-title"),
    files.read("thread-title-format"),
    projectRules === "" ? "" : `Project title rules:\n${projectRules}`,
    data,
  ]
    .filter(Boolean)
    .join("\n\n");
}

type ThreadNamingSection =
  | "current_request"
  | "current_request_context"
  | "original_request"
  | "original_request_context"
  | "recent_requests_oldest_first"
  | "recent_request_context_oldest_first";

const SECTION_TAG =
  /<(\/?)(current_request|current_request_context|original_request|original_request_context|recent_requests_oldest_first|recent_request_context_oldest_first)>/giu;

/** Thread content that spells one of the section tags reads as text, not a boundary. */
function neutralizeSectionTags(value: string): string {
  return value.replace(SECTION_TAG, "[$1$2]");
}

/** Whole lines of the project's rules, up to 500 characters: what a title prompt carries. */
export function selectProjectTitleRules(projectInstructions: string): string {
  return normalizeProjectTitleInstructions(projectInstructions)
    .split("\n")
    .reduce(
      (selected, line) =>
        selected.length + line.length + 1 <= 500 ? `${selected}\n${line}` : selected,
      "",
    )
    .trim();
}

/**
 * The thread instructions that let an agent rename its own thread in one call.
 * `projectRules` is `undefined` when they were not loaded in time.
 */
export function renderAgentRenameInstructions(projectRules: string | undefined): string {
  const selected = projectRules === undefined ? undefined : selectProjectTitleRules(projectRules);
  return files.read("agent-rename", {
    titleRules: files.read("thread-title-format"),
    projectRules:
      selected === undefined
        ? files.read("agent-rename-rules-unloaded")
        : selected === ""
          ? "This project has no extra title rules."
          : `Project title rules, from .agents/GTD_NAMING.md:\n${selected}`,
  });
}

export function normalizeProjectTitleInstructions(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim().slice(0, MAX_PROJECT_INSTRUCTIONS_LENGTH);
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
    .trim();
}

function normalizeRequestContext(
  request: Extract<ThreadNamingEvent, { type: "client/turn/requested" }>,
): string {
  const labels = request.data.input.flatMap((input) =>
    input.type === "text" && input.visibility !== "agent-only"
      ? (input.mentions ?? []).map(({ resource }) => `@${resource.label} (${resource.kind})`)
      : [],
  );
  const mentionLabels = [...new Set(labels)].join("\n").slice(0, 500);
  // BB persists resolved composer chips as agent-only text on the same request.
  const resolved = request.data.input
    .filter((input) => input.type === "text" && input.visibility === "agent-only")
    .map((input) => (input.text ?? "").trim())
    .filter(Boolean);
  // Share the available budget so one large chip cannot crowd out every other chip.
  const blockLimit = Math.max(
    0,
    Math.floor(
      (MAX_REQUEST_CONTEXT_LENGTH - mentionLabels.length - resolved.length) /
        Math.max(1, resolved.length),
    ),
  );
  return [mentionLabels, ...resolved.map((text) => text.slice(0, blockLimit))]
    .filter(Boolean)
    .join("\n");
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

/** Plans a title regeneration from the thread's latest original user request. */
export function planThreadNaming({
  events,
  projectInstructions = "",
  thread,
}: PlanThreadNamingInput): ThreadNamingPlan {
  if (thread.deletedAt !== null) return { kind: "skip", reason: "deleted-thread" };
  if (thread.visibility === "hidden") return { kind: "skip", reason: "hidden-thread" };
  if (thread.parentThreadId !== null) return { kind: "skip", reason: "child-thread" };

  const requests = userRequests(events);
  const latestRequest = requests.at(-1);
  if (latestRequest === undefined) return { kind: "skip", reason: "missing-user-prompt" };
  const userPrompt = normalizeUserPrompt(latestRequest);
  if (userPrompt === "") return { kind: "skip", reason: "missing-user-prompt" };
  const userPrompts = requests.map(normalizeUserPrompt);
  const requestContexts = requests.map(normalizeRequestContext);

  return {
    kind: "run",
    prompt: renderThreadNamingPrompt(userPrompt, projectInstructions, {
      initialUserPrompt: userPrompts[0],
      recentUserPrompts: userPrompts.slice(1, -1),
      currentRequestContext: requestContexts.at(-1),
      initialRequestContext: requestContexts[0],
      recentRequestContexts: requestContexts.slice(1, -1),
    }),
  };
}

function normalizeGeneratedTitle(value: string): string {
  return value
    .replace(/^(?:\s*(?:📝|🛠️?|🐛|🧪|📦|⚙️?|♻️?|🔎|🚀|☑️?))+/u, "")
    .trim()
    .replace(/\s+/gu, " ");
}

export function sanitizeGeneratedTitle(value: string): string | null {
  const normalized = normalizeGeneratedTitle(value);
  const title = Array.from(titleSegmenter.segment(normalized), ({ segment }) => segment)
    .slice(0, MAX_GENERATED_TITLE_LENGTH)
    .join("")
    .trimEnd();
  const task = title.replace(/^[^\p{L}\p{N}[]+/u, "").replace(/^(?:\[[^\]]*\]\s*)+/u, "");
  return /[\p{L}\p{N}]/u.test(task) ? title : null;
}
