import { contentLines } from "./scan.ts";
import type { Heading, TocNode, TocOptions } from "./types.ts";

export const DEFAULT_OPTIONS: TocOptions = {
  minLevel: 2,
  maxLevel: 4,
  indent: "  ",
  ordered: false,
};

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const CLOSING_HASHES = /\s+#+\s*$/;
const DROPPED_PUNCTUATION = /[.,:;!?'"`()[\]{}]/g;
const DASHED_CHARACTERS = /[\s/\\|]/g;

export function withDefaults(options: Partial<TocOptions>): TocOptions {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  return {
    ...merged,
    minLevel: Math.min(Math.max(merged.minLevel, 1), 6),
    maxLevel: Math.min(Math.max(merged.maxLevel, merged.minLevel), 6),
  };
}

/** Heading text is rendered as link text, so the markup around it has to go. */
export function stripInlineMarkup(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseHeadingLine(line: string): { level: number; text: string } | null {
  const match = HEADING_PATTERN.exec(line);
  if (match === null) return null;

  const level = (match[1] ?? "").length;
  const text = stripInlineMarkup((match[2] ?? "").replace(CLOSING_HASHES, ""));
  if (text.length === 0) return null;
  return { level, text };
}

export function extractHeadings(markdown: string, options: Partial<TocOptions> = {}): Heading[] {
  const settings = withDefaults(options);
  const headings: Heading[] = [];
  const taken = new Set<string>();

  for (const line of contentLines(markdown)) {
    const parsed = parseHeadingLine(line.text);
    if (parsed === null) continue;
    if (parsed.level < settings.minLevel || parsed.level > settings.maxLevel) continue;

    headings.push({
      level: parsed.level,
      text: parsed.text,
      anchor: uniqueAnchor(slugify(parsed.text), taken),
      line: line.index,
    });
  }
  return headings;
}

/**
 * Anchors have to match what the renderer generates for the heading itself,
 * which lowercases the text and joins the words with dashes.
 */
export function slugify(heading: string): string {
  const text = stripInlineMarkup(heading).trim().toLowerCase();
  const withoutPunctuation = text.replace(DROPPED_PUNCTUATION, "");
  const dashed = withoutPunctuation.replace(DASHED_CHARACTERS, "-");
  return encodeURIComponent(dashed);
}

export function uniqueAnchor(anchor: string, taken: Set<string>): string {
  const base = anchor.length === 0 ? "section" : anchor;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  let counter = 1;
  let next = `${base}-${counter}`;
  while (taken.has(next)) {
    counter += 1;
    next = `${base}-${counter}`;
  }
  taken.add(next);
  return next;
}

export function nestHeadings(headings: Heading[]): TocNode[] {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];

  for (const heading of headings) {
    const node: TocNode = { heading, children: [] };
    while (stack.length > 0 && (stack.at(-1)?.heading.level ?? 0) >= heading.level) {
      stack.pop();
    }

    const parent = stack.at(-1);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    stack.push(node);
  }
  return roots;
}

export function renderNode(
  node: TocNode,
  depth: number,
  options: TocOptions,
  position: number,
): string[] {
  const bullet = options.ordered ? `${position}.` : "-";
  const prefix = options.indent.repeat(depth);
  const lines = [`${prefix}${bullet} [${node.heading.text}](#${node.heading.anchor})`];

  for (const [index, child] of node.children.entries()) {
    lines.push(...renderNode(child, depth + 1, options, index + 1));
  }
  return lines;
}

export function renderList(nodes: TocNode[], options: Partial<TocOptions> = {}): string {
  const settings = withDefaults(options);
  const lines: string[] = [];
  for (const [index, node] of nodes.entries()) {
    lines.push(...renderNode(node, 0, settings, index + 1));
  }
  return lines.join("\n");
}

export function buildToc(markdown: string, options: Partial<TocOptions> = {}): string {
  const settings = withDefaults(options);
  const headings = extractHeadings(markdown, settings);
  if (headings.length === 0) return "";
  return renderList(nestHeadings(headings), settings);
}

export function flattenNodes(nodes: TocNode[]): Heading[] {
  const flat: Heading[] = [];
  for (const node of nodes) {
    flat.push(node.heading);
    flat.push(...flattenNodes(node.children));
  }
  return flat;
}

export function tocDepth(nodes: TocNode[]): number {
  let deepest = 0;
  for (const node of nodes) {
    deepest = Math.max(deepest, 1 + tocDepth(node.children));
  }
  return deepest;
}

export function anchorFor(headings: Heading[], text: string): string | null {
  const match = headings.find((heading) => heading.text === text);
  return match === undefined ? null : `#${match.anchor}`;
}
