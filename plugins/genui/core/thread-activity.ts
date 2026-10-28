// What a Threads row says a thread is doing beyond its status: its latest
// assistant message, the question or approval it waits on, and the workers
// (running subthreads) an idle parent waits for. The backend (project/source.ts)
// maps BB's answers through these; the renderer and the markdown fallback read
// the results. Pure: nothing here talks to BB.
import { threadStatusLabel, type ThreadInfo } from "./project";

/** Most characters of a latest message the backend keeps (the row expands to them; the thread has the rest). */
export const MESSAGE_CHARS = 2_000;

/** Most characters of a preview, a question, a command or a plan excerpt. */
const PREVIEW_CHARS = 400;

/** Most answer options a pending question lists. */
const MAX_OPTIONS = 6;

/** A thread's latest assistant message, as markdown, cut to MESSAGE_CHARS. */
export interface LastMessage {
  readonly text: string;
  /** The message went on past `text`. */
  readonly truncated: boolean;
}

/** What a thread waits on the user for. */
export interface PendingAsk {
  /** question: the agent asks something; approval: a command, edit, permission or tool; plan: a plan to approve; request: a form. */
  readonly kind: "question" | "approval" | "plan" | "request";
  /** What the user is asked to do, in a few words: "Answer a question", "Approve running a command". */
  readonly action: string;
  /** The question, the command, the plan's start, the request's detail; null when BB gives nothing more. */
  readonly text: string | null;
  /** `text` is a command (shown as code). */
  readonly code: boolean;
  /** Labels of a question's answer options, first MAX_OPTIONS. */
  readonly options: readonly string[];
  /** Further questions in the same interaction, or further pending interactions. */
  readonly more: number;
  /** Epoch ms BB recorded the interaction. */
  readonly since: number;
}

/** The latest message as kept: trimmed, cut at a word boundary, an open code fence closed. Null for none. */
export function lastMessage(output: string | null | undefined): LastMessage | null {
  if (typeof output !== "string") return null;
  const trimmed = output.trim();
  if (trimmed === "") return null;
  if (trimmed.length <= MESSAGE_CHARS) return { text: trimmed, truncated: false };
  const cut = trimmed.slice(0, MESSAGE_CHARS);
  const space = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  let text = (space > MESSAGE_CHARS * 0.8 ? cut.slice(0, space) : cut).trimEnd();
  if ((text.match(/^\s*(?:```|~~~)/gm) ?? []).length % 2 === 1) text += "\n```";
  return { text, truncated: true };
}

/**
 * A message's markdown as one line of plain text for a two-line preview:
 * code blocks, link targets, images, emphasis, heading and list markers,
 * table pipes and HTML tags dropped; whitespace collapsed.
 */
export function previewText(markdown: string): string {
  const text = markdown
    .replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?(?:^\s*\1\s*$|(?![\s\S]))/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, " ")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return clip(text, PREVIEW_CHARS);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Paths a permission asks to read or write, and network access, in a few words. */
function permissionSummary(permissions: Record<string, unknown> | null): string | null {
  const files = record(permissions?.fileSystem);
  const write = list(files?.write).filter((path): path is string => typeof path === "string");
  const read = list(files?.read).filter((path): path is string => typeof path === "string");
  const network = record(permissions?.network)?.enabled === true;
  const parts = [
    write.length > 0 ? `write ${write.join(", ")}` : "",
    read.length > 0 ? `read ${read.join(", ")}` : "",
    network ? "network access" : "",
  ].filter((part) => part !== "");
  return parts.length === 0 ? null : clip(parts.join(" · "), PREVIEW_CHARS);
}

function ask(kind: PendingAsk["kind"], action: string, body: string | null, since: number, extra: Partial<PendingAsk> = {}): PendingAsk {
  return { kind, action, text: body === null ? null : clip(body, PREVIEW_CHARS), code: false, options: [], more: 0, since, ...extra };
}

/** One BB interaction (threads.interactions.list entry) as the user's task, or null for a shape it doesn't know. */
function interactionAsk(interaction: Record<string, unknown>): PendingAsk | null {
  const payload = record(interaction.payload);
  if (payload === null) return null;
  const since = typeof interaction.createdAt === "number" ? interaction.createdAt : 0;
  switch (payload.kind) {
    case "user_question": {
      const questions = list(payload.questions).map(record).filter((question) => question !== null);
      const first = questions[0];
      if (first === undefined) return ask("question", "Answer a question", null, since);
      const options = list(first.options)
        .map((option) => text(record(option)?.label))
        .filter((label): label is string => label !== null);
      return ask("question", questions.length > 1 ? `Answer ${questions.length} questions` : "Answer a question", text(first.prompt) ?? text(first.shortLabel), since, {
        options: options.slice(0, MAX_OPTIONS),
        more: questions.length - 1,
      });
    }
    case "approval": {
      const subject = record(payload.subject);
      const reason = text(payload.reason);
      switch (subject?.kind) {
        case "command": {
          const command = text(subject.command);
          return ask("approval", "Approve running a command", command, since, { code: command !== null });
        }
        case "file_change": {
          const scope = text(subject.writeScope);
          return ask("approval", "Approve file changes", scope === null ? reason : `In ${scope}`, since);
        }
        case "permission_grant":
          return ask("approval", "Grant a permission", permissionSummary(record(subject.permissions)) ?? reason, since);
        case "plan":
          return ask("plan", "Approve a plan", text(subject.plan) === null ? null : previewText(String(subject.plan)), since);
        case "tool_use": {
          const presentation = record(subject.presentation);
          const tool = text(subject.tool);
          const shown = text(presentation?.title) ?? text(record(presentation?.label)?.pending) ?? text(presentation?.detail) ?? reason;
          return ask("approval", tool === null ? "Approve a tool" : `Approve using ${tool}`, shown, since);
        }
        default:
          return ask("approval", "Approve an action", reason, since);
      }
    }
    default: {
      // A plugin's form (e.g. the secrets plugin: "Add secrets", "Requesting MAIL_API_KEY"), or a provider's own request kind (`vendor/kind`).
      const presentation = record(payload.presentation);
      const pendingLabel = text(record(presentation?.label)?.pending);
      return ask("request", text(payload.title) ?? text(presentation?.title) ?? "Respond to a request", text(presentation?.detail) ?? pendingLabel, since);
    }
  }
}

/**
 * What the thread waits on the user for, from BB's interaction list: the
 * oldest still-pending interaction it can describe (the one blocking the
 * turn), with how many others are pending too. Null when nothing is pending.
 */
export function pendingAsk(interactions: unknown): PendingAsk | null {
  const pending = list(interactions)
    .map(record)
    .filter((interaction): interaction is Record<string, unknown> => interaction !== null && interaction.status === "pending")
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  for (const interaction of pending) {
    const found = interactionAsk(interaction);
    if (found !== null) return { ...found, more: found.more + pending.length - 1 };
  }
  return null;
}

/** How many running threads each parent has, from the running threads' parents (null: a root thread). */
export function workersByParent(parents: readonly (string | null)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const parent of parents) if (parent !== null) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  return counts;
}

/** "1 running worker", "3 running workers". */
export function workersLabel(count: number): string {
  return `${count} running worker${count === 1 ? "" : "s"}`;
}

/** An idle thread whose subthreads still run is waiting on them, not done. */
export function waitsOnWorkers(thread: Pick<ThreadInfo, "status" | "needsInput" | "archived" | "runningWorkers">): boolean {
  return thread.status === "idle" && !thread.needsInput && !thread.archived && thread.runningWorkers > 0;
}

/** The status a Threads row shows: "Waiting on 2 running workers" for an idle parent of running workers, else BB's status. */
export function threadActivityLabel(thread: Pick<ThreadInfo, "status" | "needsInput" | "archived" | "runningWorkers">): string {
  return waitsOnWorkers(thread) ? `Waiting on ${workersLabel(thread.runningWorkers)}` : threadStatusLabel(thread);
}
