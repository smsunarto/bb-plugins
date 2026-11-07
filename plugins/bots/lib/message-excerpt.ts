/** Longest excerpt kept; the Bots tab clips it to one line. */
export const EXCERPT_MAX_CHARS = 160;

/**
 * A one-line plain-text preview of a bot's message: code and UI blocks,
 * markdown markers, and link targets removed, whitespace collapsed. Null when
 * nothing readable is left.
 */
export function messageExcerpt(text: string | null | undefined): string | null {
  if (!text) return null;
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, "$1$2")
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  return plain.length <= EXCERPT_MAX_CHARS
    ? plain
    : `${plain.slice(0, EXCERPT_MAX_CHARS - 1).trimEnd()}…`;
}
