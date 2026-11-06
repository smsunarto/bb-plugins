import { parseMarkdown } from "../../shared/review/markdown.ts";
import { type Footnote, type LinkTarget, type PreparedMarkdown, preprocess } from "./preprocess.ts";

/**
 * A markdown block split for editing. A leading h1 is the document title, which renders as
 * header chrome and stays out of the editor. The body is what the editor holds: every link and
 * image points at a placeholder and footnote definitions are moved out, so `restore` can write
 * the exact URLs and definitions back.
 */
export interface EditableSource {
  /** The leading h1 line, or "" when the block has none. */
  title: string;
  body: PreparedMarkdown;
}

export function prepareEditable(source: string): EditableSource {
  const first = parseMarkdown(source).children?.[0];
  const titleEnd =
    first?.type === "heading" && first.depth === 1 ? (first.position?.end.offset ?? 0) : 0;

  return {
    title: source.slice(0, titleEnd),
    body: preprocess(source.slice(titleEnd), { allowRemoteImages: true, editable: true }),
  };
}

/** The block's markdown after an edit: the editor's serialized body with placeholders resolved. */
export function restoreEditable(source: EditableSource, edited: string): string {
  const body = restore(edited, source.body.links, source.body.footnotes).trim();
  if (!source.title) return body;
  return body ? `${source.title}\n\n${body}` : source.title;
}

const PLACEHOLDER_TAIL = /\]\(#wb-link-(\d+)\)/g;

function restore(edited: string, links: LinkTarget[], footnotes: Footnote[]): string {
  const parts: string[] = [];
  let cursor = 0;

  for (const match of edited.matchAll(PLACEHOLDER_TAIL)) {
    const target = links[Number(match[1])];
    if (!target) continue;

    if (target.kind === "footnote") {
      // The reference's label text is the footnote label; the whole `[label](…)` becomes `[^label]`.
      const open = openingBracket(edited, match.index, cursor);
      if (open === undefined) continue;
      parts.push(edited.slice(cursor, open), `[^${target.label}]`);
    } else {
      const title = target.title ? ` "${target.title.replace(/["\\]/g, "\\$&")}"` : "";
      parts.push(edited.slice(cursor, match.index), `](${destination(target.url)}${title})`);
    }
    cursor = match.index + match[0].length;
  }
  parts.push(edited.slice(cursor));

  const definitions = footnotes.map(
    (footnote) => `[^${footnote.label}]: ${footnote.markdown.replace(/\n/g, "\n    ")}`,
  );
  return [parts.join("").trimEnd(), ...definitions].filter(Boolean).join("\n\n");
}

/** The unescaped `[` before `index`, no earlier than `floor`. */
function openingBracket(text: string, index: number, floor: number): number | undefined {
  for (let at = index - 1; at >= floor; at--)
    if (text[at] === "[" && text[at - 1] !== "\\") return at;
  return undefined;
}

/** A link destination as written: angle brackets when it is empty or holds spaces or parens. */
function destination(url: string): string {
  return url === "" || /[\s()<>]/.test(url) ? `<${url.replace(/[<>\\]/g, "\\$&")}>` : url;
}
