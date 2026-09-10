import type { Anchor } from "../shared/comments.ts";

export function quoteOffset(text: string, anchor: Anchor): number | null {
  if (!anchor.quote) return null;
  const candidates: number[] = [];
  for (let at = text.indexOf(anchor.quote); at !== -1; at = text.indexOf(anchor.quote, at + 1)) {
    if (anchor.prefix && !text.slice(0, at).endsWith(anchor.prefix)) continue;
    if (anchor.suffix && !text.slice(at + anchor.quote.length).startsWith(anchor.suffix)) continue;
    candidates.push(at);
  }
  if (candidates.length === 1) return candidates[0] ?? null;
  // Surrounding edits may change context. The quote alone is safe only once.
  const first = text.indexOf(anchor.quote);
  return first >= 0 && text.indexOf(anchor.quote, first + 1) === -1 ? first : null;
}

export function textIndex(root: HTMLElement) {
  const nodes: { node: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest('button, textarea, input, select, script, style, [aria-hidden="true"]')
    )
      continue;
    const value = node.textContent ?? "";
    nodes.push({ node: node as Text, start: text.length, end: text.length + value.length });
    text += value;
  }
  return {
    text,
    range(start: number, length: number): Range | null {
      const first = nodes.find((part) => part.end > start);
      const last = nodes.find((part) => part.end >= start + length);
      if (!first || !last) return null;
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, start + length - last.start);
      return range;
    },
    offset(node: Node, offset: number): number | null {
      const part = nodes.find((entry) => entry.node === node);
      if (part) return part.start + offset;
      if (!root.contains(node) || node.nodeType !== Node.ELEMENT_NODE) return null;
      // Whole-block selections use child offsets on elements, rather than
      // character offsets on text nodes. Project that boundary into the same
      // filtered text index used for quotes and highlights.
      const boundary = document.createRange();
      boundary.setStart(node, offset);
      boundary.collapse(true);
      return nodes.find((entry) => boundary.comparePoint(entry.node, 0) >= 0)?.start ?? text.length;
    },
  };
}
