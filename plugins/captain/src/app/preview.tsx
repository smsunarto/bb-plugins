/**
 * A Drive card's preview: the head of a Markdown file as plain lines. A card
 * shows a dozen lines at thumbnail size, so it renders text, not Markdown:
 * headings in medium weight, list items with their marker, code and table
 * rows as text. Nothing in it fetches, links or takes focus; the card is the
 * one control. Inline marks, links and HTML tags keep only their text.
 */
import { memo } from "react";

export type PreviewLine =
  | { kind: "heading" | "text" | "code"; text: string }
  | { kind: "item"; marker: string; depth: number; text: string }
  | { kind: "gap" };

/** More lines than a card's height ever shows. */
const MAX_LINES = 24;

export function previewLines(markdown: string): PreviewLine[] {
  const lines: PreviewLine[] = [];
  const source = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").split(/\r?\n/u);
  let fenced = false;
  for (const raw of source) {
    if (lines.length >= MAX_LINES) break;
    if (/^\s*(```|~~~)/u.test(raw)) {
      fenced = !fenced;
      continue;
    }
    const line = fenced ? codeLine(raw) : proseLine(raw.trimEnd());
    if (line === null) continue;
    // Blank lines collapse into one gap, and none leads.
    if (line.kind === "gap" && (lines.length === 0 || lines.at(-1)?.kind === "gap")) continue;
    lines.push(line);
  }
  while (lines.at(-1)?.kind === "gap") lines.pop();
  return lines;
}

function codeLine(raw: string): PreviewLine | null {
  return raw.trim() === "" ? null : { kind: "code", text: raw.trimEnd() };
}

/** One line outside a fence, or null for a line that says nothing in a preview. */
function proseLine(line: string): PreviewLine | null {
  if (line.trim() === "") return { kind: "gap" };
  const heading = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line);
  if (heading) return { kind: "heading", text: inline(heading[1] ?? "") };
  const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u.exec(line);
  if (item) {
    const [, indent = "", bullet = "", rest = ""] = item;
    const marker = /\d/u.test(bullet) ? bullet : "•";
    const depth = Math.min(3, Math.floor(indent.length / 2));
    return { kind: "item", marker, depth, text: inline(rest) };
  }
  // A table's divider row says nothing; its other rows read as cells parted by a dot.
  if (/^\s*\|?\s*:?-{2,}/u.test(line) && /^[\s|:-]+$/u.test(line)) return null;
  const text = line.trim().startsWith("|") ? tableRow(line) : inline(line.replace(/^\s*>\s?/u, ""));
  if (text === "" || /^(-{3,}|\*{3,}|_{3,})$/u.test(text)) return null;
  return { kind: "text", text };
}

function tableRow(line: string): string {
  return line
    .split("|")
    .map((cell) => inline(cell))
    .filter(Boolean)
    .join(" · ");
}

/** A code span: a run of backticks, its text, and the same run again. */
const CODE_SPAN = /(`+)(.+?)\1/gu;

/**
 * Inline Markdown as its text. Code spans keep their text verbatim, `<` and
 * all; outside them, images and links keep their label, autolinks their
 * target, and marks and HTML tags go.
 */
function inline(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    out += prose(text.slice(last, match.index));
    out += match[2] ?? "";
    last = match.index + match[0].length;
  }
  return (out + prose(text.slice(last))).trim();
}

function prose(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<([a-z][a-z0-9+.-]*:[^<>\s]+|[^<>\s@]+@[^<>\s@]+)>/giu, "$1")
    .replace(/<\/?[a-z][^<>]*>/giu, "")
    .replace(/(\*\*|__|~~)/gu, "");
}

/** The preview, memoized on its text: a refresh with the same excerpt redraws nothing. */
export const Preview = memo(function Preview({ markdown }: { markdown: string }) {
  const lines = previewLines(markdown);
  return (
    <span className="flex min-w-0 flex-col text-[10px] leading-snug break-words text-foreground">
      {lines.map((line, index) => {
        const key = `${index}`;
        switch (line.kind) {
          case "gap":
            return <span key={key} className="h-1 shrink-0" />;
          case "heading":
            return (
              <span key={key} className="font-medium">
                {line.text}
              </span>
            );
          case "code":
            return (
              <span key={key} className="truncate text-muted-foreground">
                {line.text}
              </span>
            );
          case "item":
            return (
              <span key={key} className="flex gap-1" style={{ paddingInlineStart: line.depth * 8 }}>
                <span className="shrink-0">{line.marker}</span>
                <span className="min-w-0">{line.text}</span>
              </span>
            );
          default:
            return <span key={key}>{line.text}</span>;
        }
      })}
    </span>
  );
});
