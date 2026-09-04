export type Directive = {
  kind: "diff" | "code";
  path: string;
  start: number | null;
  end: number | null;
  line: number;
  raw: string;
};

export type DirectiveScan = {
  directives: Directive[];
  /** Directive-shaped text that the plugin would never render: fenced or inline. */
  hidden: number;
};

const LEAF = /^::smart-(diff|code)\{([^}]*)\}$/u;
const ANYWHERE = /::smart-(?:diff|code)\{/u;
const ATTR = /(\w+)="([^"]*)"/gu;
const FENCE = /^\s*(```|~~~)/u;

function attributes(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of body.matchAll(ATTR)) found.set(match[1]!, match[2]!);
  return found;
}

function integer(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * A directive only renders when it is the whole line and sits outside every
 * fence, so anything else counts as hidden rather than as an embed.
 */
export function scanDirectives(markdown: string): DirectiveScan {
  const lines = markdown.split("\n");
  const directives: Directive[] = [];
  let hidden = 0;
  let fence: string | null = null;
  for (const [index, text] of lines.entries()) {
    const fenceMatch = FENCE.exec(text);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      if (ANYWHERE.test(text)) hidden += 1;
      continue;
    }
    if (!ANYWHERE.test(text)) continue;
    if (fence !== null) {
      hidden += 1;
      continue;
    }
    const trimmed = text.trim();
    const leaf = LEAF.exec(trimmed);
    if (leaf === null) {
      hidden += 1;
      continue;
    }
    const attrs = attributes(leaf[2]!);
    const path = attrs.get("path");
    if (path === undefined || path.length === 0) {
      hidden += 1;
      continue;
    }
    directives.push({
      kind: leaf[1] === "diff" ? "diff" : "code",
      path,
      start: integer(attrs.get("start")),
      end: integer(attrs.get("end")),
      line: index,
      raw: trimmed,
    });
  }
  return { directives, hidden };
}

/** The last line carrying prose, used to detect directives dumped at the end. */
export function lastProseLine(markdown: string): number {
  const lines = markdown.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index]!.trim();
    if (text.length === 0) continue;
    if (ANYWHERE.test(text)) continue;
    if (FENCE.test(text)) continue;
    return index;
  }
  return -1;
}

/** Blank-line separated blocks that carry prose rather than directives. */
export function proseParagraphs(markdown: string): number {
  const lines = markdown.split("\n");
  let count = 0;
  let open = false;
  let fence: string | null = null;
  for (const text of lines) {
    const trimmed = text.trim();
    const fenceMatch = FENCE.exec(text);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]!;
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (trimmed.length === 0) {
      open = false;
      continue;
    }
    if (fence !== null || ANYWHERE.test(trimmed)) continue;
    if (!open) {
      open = true;
      count += 1;
    }
  }
  return count;
}
