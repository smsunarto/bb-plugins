import type { Anchor, CommentThread } from "./comments.ts";
import type { CanvasDocument, CanvasNode, JsonValue } from "./document.ts";

// Pure anchoring. Zod-free so the app imports it as a value. Nothing here
// writes; a thread that stops matching stays detached until the text returns.

export interface FlatBlock {
  readonly offset: number;
  readonly index: number;
  readonly blockId: string;
  readonly text: string;
  readonly label: string;
}

export type AnchorMatch =
  | {
      readonly kind: "anchored";
      readonly offset: number;
      readonly index: number;
      readonly editedSince: boolean;
    }
  | { readonly kind: "detached" };

export interface PlacedThread {
  readonly thread: CommentThread;
  readonly match: AnchorMatch;
  /** The matched block's label, or the saved preview when detached. */
  readonly context: string;
}

export interface Placement {
  readonly byOffset: ReadonlyMap<number, readonly PlacedThread[]>;
  readonly detached: readonly PlacedThread[];
}

const previewLength = 240;
const fuzzyThreshold = 0.6;
const nearIndexBonus = 0.05;

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// FNV-1a 64 keeps blockId synchronous in the browser; crypto.subtle is async
// and would push placement out of render.
export function blockIdOf(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(normalizeText(text))) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0").slice(0, 12);
}

function propText(value: JsonValue): string {
  if (value === null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const rows = value.every((item) => Array.isArray(item));
    return value.map(propText).join(rows ? "\n" : " | ");
  }
  return Object.values(value).map(propText).join(" ");
}

export function blockText(node: CanvasNode): string {
  switch (node.kind) {
    case "markdown":
      return node.source;
    case "diagnostic":
      return node.diagnostic.message;
    case "component": {
      const parts: string[] = [node.name];
      for (const value of Object.values(node.props)) {
        const text = propText(value);
        if (text.length > 0) parts.push(text);
      }
      for (const child of node.children) parts.push(blockText(child));
      return parts.join("\n");
    }
  }
}

function blockLabel(node: CanvasNode): string {
  const quoteOf = (text: string): string => {
    const line = normalizeText(text.split("\n")[0] ?? "");
    return `"${line.length > 60 ? `${line.slice(0, 57)}...` : line}"`;
  };
  switch (node.kind) {
    case "markdown":
      return `markdown ${quoteOf(node.source)}`;
    case "diagnostic":
      return `problem ${quoteOf(node.diagnostic.message)}`;
    case "component": {
      const title = ["title", "label", "caption"]
        .map((key) => node.props[key])
        .find((value): value is string => typeof value === "string");
      return title === undefined ? node.name : `${node.name} ${quoteOf(title)}`;
    }
  }
}

export function flattenBlocks(document: CanvasDocument): readonly FlatBlock[] {
  const out: FlatBlock[] = [];
  const walk = (nodes: readonly CanvasNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "diagnostic") continue;
      const text = blockText(node);
      out.push({
        offset: node.span.startOffset,
        index: out.length,
        blockId: blockIdOf(text),
        text,
        label: blockLabel(node),
      });
      if (node.kind === "component") walk(node.children);
    }
  };
  walk(document.nodes);
  return out;
}

export function anchorAt(document: CanvasDocument, offset: number, quote: string | null): Anchor {
  const block = flattenBlocks(document).find((candidate) => candidate.offset === offset);
  if (block === undefined) throw new Error(`no block starts at offset ${offset}`);
  const normalizedQuote = quote === null ? null : normalizeText(quote);
  return {
    blockId: block.blockId,
    index: block.index,
    quote:
      normalizedQuote !== null &&
      normalizedQuote.length > 0 &&
      normalizeText(block.text).includes(normalizedQuote)
        ? normalizedQuote
        : null,
    preview: normalizeText(block.text).slice(0, previewLength),
  };
}

function trigrams(text: string): Set<string> {
  const normalized = normalizeText(text).toLowerCase();
  if (normalized.length < 3) return new Set([normalized]);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i += 1) out.add(normalized.slice(i, i + 3));
  return out;
}

export function diceSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

function contains(block: FlatBlock, quote: string): boolean {
  return normalizeText(block.text).includes(normalizeText(quote));
}

function nearest(blocks: readonly FlatBlock[], index: number): FlatBlock | undefined {
  let best: FlatBlock | undefined;
  for (const block of blocks) {
    if (best === undefined || Math.abs(block.index - index) < Math.abs(best.index - index)) {
      best = block;
    }
  }
  return best;
}

function resolve(
  blocks: readonly FlatBlock[],
  anchor: Anchor,
): { block: FlatBlock; editedSince: boolean } | null {
  const exact = nearest(
    blocks.filter((block) => block.blockId === anchor.blockId),
    anchor.index,
  );
  if (exact !== undefined) {
    return { block: exact, editedSince: anchor.quote !== null && !contains(exact, anchor.quote) };
  }
  if (anchor.quote !== null) {
    const quote = anchor.quote;
    const containing = blocks.filter((block) => contains(block, quote));
    if (containing.length === 1 && containing[0] !== undefined) {
      return { block: containing[0], editedSince: true };
    }
  }
  let best: { block: FlatBlock; score: number } | null = null;
  for (const block of blocks) {
    const bonus = Math.abs(block.index - anchor.index) <= 2 ? nearIndexBonus : 0;
    const score = diceSimilarity(anchor.preview, block.text.slice(0, previewLength)) + bonus;
    if (best === null || score > best.score) best = { block, score };
  }
  if (best !== null && best.score >= fuzzyThreshold)
    return { block: best.block, editedSince: true };
  return null;
}

/** Every input thread appears exactly once across byOffset and detached. */
export function placeThreads(
  document: CanvasDocument,
  threads: readonly CommentThread[],
): Placement {
  const blocks = flattenBlocks(document);
  const byOffset = new Map<number, PlacedThread[]>();
  const detached: PlacedThread[] = [];
  for (const thread of threads) {
    const resolved = resolve(blocks, thread.anchor);
    if (resolved === null) {
      detached.push({ thread, match: { kind: "detached" }, context: thread.anchor.preview });
      continue;
    }
    const { block, editedSince } = resolved;
    const placed: PlacedThread = {
      thread,
      match: { kind: "anchored", offset: block.offset, index: block.index, editedSince },
      context: block.label,
    };
    const list = byOffset.get(block.offset);
    if (list === undefined) byOffset.set(block.offset, [placed]);
    else list.push(placed);
  }
  return { byOffset, detached };
}
