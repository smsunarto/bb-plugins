import {
  type MarkdownNode,
  markdownText,
  parseMarkdown,
} from "../../shared/vendor/review/src/markdown.ts";
import { urlProtocol } from "./link.tsx";

/** What a rewritten link stands for: upstream's mdast URL, or a footnote reference. */
export type LinkTarget =
  | { kind: "link"; url: string; title?: string }
  | { kind: "footnote"; label: string };

export interface Footnote {
  label: string;
  markdown: string;
}

export interface PreparedMarkdown {
  /** Source for the TipTap parser. Every mdast link points at `placeholderHref(index)`. */
  markdown: string;
  /** Indexed by placeholder. */
  links: LinkTarget[];
  /** GFM footnote definitions in source order, as upstream `splitFootnotes` keeps them. */
  footnotes: Footnote[];
}

const PLACEHOLDER = "#wb-link-";

export const placeholderHref = (index: number): string => `${PLACEHOLDER}${index}`;

export function placeholderIndex(href: unknown): number | undefined {
  if (typeof href !== "string" || !href.startsWith(PLACEHOLDER)) return undefined;
  const index = Number(href.slice(PLACEHOLDER.length));
  return Number.isInteger(index) ? index : undefined;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Applies upstream's Markdown semantics before TipTap parses the source. Upstream's mdast
 * (`parseMarkdown`) decides what is a link, an image or a footnote, so its URLs reach
 * `renderLink` byte-for-byte:
 *
 * - Each link (inline, reference, autolink, GFM literal) points at a placeholder fragment.
 *   markdown-it would otherwise percent-encode the URL, drop `javascript:` links, and TipTap
 *   would strip `review-source:` hrefs.
 * - A footnote reference becomes a placeholder link. Definitions move out to `footnotes`.
 * - An image stays only when remote images are allowed and it is `https:`. Otherwise its alt
 *   text renders as emphasis. A reference-style image renders nothing, as upstream.
 */
export function preprocess(
  markdown: string,
  { allowRemoteImages }: { allowRemoteImages: boolean },
): PreparedMarkdown {
  const links: LinkTarget[] = [];
  const footnotes: Footnote[] = [];
  const edits: Edit[] = [];
  const link = (target: LinkTarget) => placeholderHref(links.push(target) - 1);

  const rewrite = (node: MarkdownNode, inLink: boolean): Edit | undefined => {
    const [start, end] = span(node);

    switch (node.type) {
      case "footnoteDefinition":
        footnotes.push({
          label: node.label ?? node.identifier ?? String(footnotes.length),
          markdown: definitionBody(markdown, node),
        });
        return { start, end, text: "" };
      case "footnoteReference": {
        // A link cannot hold another link: markdown-it would keep the inner one and print the
        // outer placeholder as text. Inside a label the reference stays its literal `[^label]`.
        if (inLink) return undefined;
        const label = node.label ?? node.identifier ?? "";
        return { start, end, text: inlineLink(label, link({ kind: "footnote", label })) };
      }
      case "link":
        return linkEdit(
          markdown,
          node,
          link({ kind: "link", url: node.url ?? "", title: node.title ?? undefined }),
        );
      case "image":
        return allowRemoteImages && urlProtocol(node.url ?? "") === "https:"
          ? undefined
          : { start, end, text: emphasis(node.alt ?? "") };
      case "imageReference":
        return { start, end, text: "" };
      default:
        return undefined;
    }
  };

  const visit = (node: MarkdownNode, inLink = false) => {
    const edit = rewrite(node, inLink);
    if (edit) edits.push(edit);
    // A bracketed link keeps its label, which may hold images to rewrite.
    if (!edit || edit.start > span(node)[0])
      for (const child of node.children ?? []) visit(child, inLink || node.type === "link");
  };

  visit(parseMarkdown(markdown));

  let out = markdown;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);

  return { markdown: out, links, footnotes };
}

const span = (node: MarkdownNode) =>
  [node.position?.start.offset ?? 0, node.position?.end.offset ?? 0] as const;

/**
 * A link pointing at `href`. A bracketed link keeps its label and replaces `(dest "title")`,
 * `[ref]`, `[]` or nothing after the label's closing bracket. An autolink (`<https://…>` or a GFM
 * literal) is written out as an inline link.
 */
function linkEdit(markdown: string, node: MarkdownNode, href: string): Edit {
  const [start, end] = span(node);
  if (markdown[start] !== "[") return { start, end, text: inlineLink(markdownText(node), href) };

  const last = node.children?.at(-1)?.position?.end.offset;
  const labelEnd = last === undefined ? start + 1 : markdown.indexOf("]", last);
  return { start: labelEnd, end, text: `](${href})` };
}

const inlineLink = (text: string, href: string) => `[${escape(text)}](${href})`;

/** A definition's content, with continuation lines dedented out of the definition's indent. */
function definitionBody(markdown: string, node: MarkdownNode): string {
  const children = node.children ?? [];
  if (children.length === 0) return "";

  return markdown
    .slice(children[0]!.position?.start.offset, children.at(-1)!.position?.end.offset)
    .replace(/\n(?: {1,4}|\t)/g, "\n");
}

/** Literal text: backslash-escape ASCII punctuation, so no Markdown syntax survives. */
const escape = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/[!-/:-@[-`{-~]/g, "\\$&");

const emphasis = (alt: string) => (alt.trim() ? `*${escape(alt.trim())}*` : "");
