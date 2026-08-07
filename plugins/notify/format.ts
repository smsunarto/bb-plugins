// Pure text and policy helpers. No BB API, no child processes — everything
// here is directly testable.

/** Escaped markdown literals are parked at this offset while syntax is stripped. */
const ESCAPE_OFFSET = 0xe000;

/** Notification bodies are one line: collapse whitespace, then clip. */
export function oneLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Best available human name for a thread. */
export function threadLabel(thread: {
  title: string | null;
  titleFallback: string | null;
}): string {
  const named = thread.title?.trim() || thread.titleFallback?.trim() || "";
  return named === "" ? "Untitled thread" : named;
}

/**
 * Split a notification into the two fields the web Notification API gives us.
 *
 * The thread is what identifies the notification, so it takes the title — the
 * one line macOS renders in bold. The project is context rather than news, so
 * it rides in front of the message as a bracketed tag: present when the eye
 * looks for it, and out of the way when it does not.
 *
 * With no project the message stands alone rather than carrying empty
 * brackets.
 */
export function notificationLines(
  projectName: string | null,
  threadName: string,
  message: string,
): { title: string; body: string } {
  if (projectName === null || projectName === "") {
    return { title: threadName, body: message };
  }
  return { title: threadName, body: `[${projectName}] ${message}` };
}

/**
 * A notification body is plain text — macOS has no rich-text or markdown
 * renderer for it — so agent prose arrives with its syntax showing:
 * `**Root cause:** …` is displayed literally. Flatten the markers to the words
 * they were decorating.
 *
 * The emphasis patterns require a non-word boundary so `snake_case` and
 * `2 * 3` survive; only genuine emphasis runs are unwrapped.
 */
export function plainText(markdown: string): string {
  return (
    markdown
      // A backslash-escaped marker is a literal character, so park it in the
      // private use area first — otherwise the emphasis rules below would
      // treat `\*not italic\*` as emphasis and eat both asterisks. Restored
      // at the end, once no rule can mistake it for syntax.
      .replaceAll(
        /\\([\\`*_{}[\]()#+\-.!>~|])/gu,
        (_match, char: string) =>
          String.fromCodePoint(ESCAPE_OFFSET + (char.codePointAt(0) ?? 0)),
      )
      // Fenced and inline code: keep the code, drop the fences.
      .replaceAll(/```[a-z]*\n?/giu, "")
      .replaceAll(/`([^`\n]+)`/gu, "$1")
      // Images before links — an image is a link with a leading `!`.
      .replaceAll(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replaceAll(/\*\*([^*\n]+)\*\*/gu, "$1")
      .replaceAll(/(?<![\w_])__([^_\n]+)__(?![\w_])/gu, "$1")
      .replaceAll(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/gu, "$1")
      .replaceAll(/(?<![\w_])_([^_\n]+)_(?![\w_])/gu, "$1")
      .replaceAll(/~~([^~\n]+)~~/gu, "$1")
      // Line-leading furniture: headings, quotes, bullets, numbering, rules.
      .replaceAll(/^\s{0,3}#{1,6}\s+/gmu, "")
      .replaceAll(/^\s{0,3}>\s?/gmu, "")
      .replaceAll(/^\s{0,3}[-*+]\s+/gmu, "")
      .replaceAll(/^\s{0,3}\d+\.\s+/gmu, "")
      .replaceAll(/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gmu, "")
      // Bring the parked literals back as themselves.
      .replaceAll(/[\uE000-\uE0FF]/gu, (char) =>
        String.fromCodePoint((char.codePointAt(0) ?? 0) - ESCAPE_OFFSET),
      )
  );
}

/** BB entity ids are opaque slugs; reject anything else before acting on one. */
export function isThreadId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

/** Settings hold strings; a bad value should mean "off", not NaN. */
export function parseSeconds(value: string): number {
  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export interface ThreadFilterInput {
  visibility: "visible" | "hidden";
  parentThreadId: string | null;
}

export interface ThreadFilterOptions {
  includeHiddenThreads: boolean;
  includeChildThreads: boolean;
}

/** Why a thread event produced no notification, or null when it should fire. */
export function suppressionReason(
  thread: ThreadFilterInput,
  options: ThreadFilterOptions,
): string | null {
  if (thread.visibility === "hidden" && !options.includeHiddenThreads) {
    return "hidden thread";
  }
  if (thread.parentThreadId !== null && !options.includeChildThreads) {
    return "child thread";
  }
  return null;
}
