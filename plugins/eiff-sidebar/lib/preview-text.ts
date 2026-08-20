const PREVIEW_LIMIT = 200;

/**
 * Turns the latest agent output into the single plain-text line used by a
 * thread card.
 */
export function toPreviewText(markdown: string | null): string | null {
  try {
    if (typeof markdown !== "string") return null;

    const text = markdown
      .replace(/\r\n?/g, "\n")
      .replace(/^\s{0,3}#{1,6}(?:[ \t]+|$)/gm, "")
      .replace(/^\s*(?:>\s*)+/gm, "")
      .replace(/^\s*(?:[-+*]|\d+[.)])[ \t]+/gm, "")
      .replace(/!\[([^\]\n]*)\]\([^\n)]*\)/g, "$1")
      .replace(/\[([^\]\n]+)\]\([^\n)]*\)/g, "$1")
      .replace(/`+/g, "")
      .replace(/\*{1,3}/g, "")
      .replace(/_{1,3}/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length === 0) return null;
    if (text.length <= PREVIEW_LIMIT) return text;

    const boundary = text.lastIndexOf(" ", PREVIEW_LIMIT);
    return boundary > 0 ? text.slice(0, boundary) : text.slice(0, PREVIEW_LIMIT);
  } catch {
    return null;
  }
}
