import type { ScannedLine } from "./types.ts";

const FENCE_PATTERN = /^\s{0,3}(```+|~~~+)/;
const FRONT_MATTER_DELIMITER = /^---\s*$/;

export function splitLines(markdown: string): string[] {
  return markdown.split(/\r?\n/);
}

export function fenceMarker(line: string): string | null {
  const match = FENCE_PATTERN.exec(line);
  return match === null ? null : (match[1] ?? null);
}

export function frontMatterEnd(lines: string[]): number {
  if (lines[0] === undefined || !FRONT_MATTER_DELIMITER.test(lines[0])) return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONT_MATTER_DELIMITER.test(lines[index] ?? "")) return index + 1;
  }
  // An unterminated block is a stray `---`, not front matter.
  return 0;
}

/** Every line that is neither front matter nor inside a fenced block. */
export function contentLines(markdown: string): ScannedLine[] {
  const lines = splitLines(markdown);
  const start = frontMatterEnd(lines);
  const out: ScannedLine[] = [];
  let openFence: string | null = null;

  for (let index = start; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const marker = fenceMarker(text);

    if (openFence !== null) {
      if (marker !== null && marker.startsWith(openFence[0] ?? "")) openFence = null;
      continue;
    }
    if (marker !== null) {
      openFence = marker;
      continue;
    }
    out.push({ index: index + 1, text });
  }
  return out;
}
