const MAX_CITED_LINES = 200;
const CITATION_CONTEXT_LINES = 2;

function lineLabel(path: string, start: number, end: number): string {
  return start === end ? `${path}:L${start}` : `${path}:L${start}-L${end}`;
}

export function citationPatch(
  path: string,
  content: string,
  requestedStart?: number,
  requestedEnd?: number,
): { label: string; patch: string } | { error: string } {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  if (lines.length === 1 && lines[0] === "") {
    return { error: "The cited file is empty." };
  }

  const start = requestedStart ?? 1;
  const end = requestedEnd ?? (requestedStart === undefined ? Math.min(lines.length, 40) : start);
  if (start > lines.length) {
    return { error: `Line ${start} is outside this ${lines.length}-line file.` };
  }
  if (end < start) {
    return { error: "The citation end line must not come before its start line." };
  }
  if (end - start + 1 > MAX_CITED_LINES) {
    return { error: `A code citation can include at most ${MAX_CITED_LINES} lines.` };
  }

  const boundedEnd = Math.min(end, lines.length);
  const renderStart = Math.max(1, start - CITATION_CONTEXT_LINES);
  const renderEnd = Math.min(lines.length, boundedEnd + CITATION_CONTEXT_LINES);
  const excerpt = lines.slice(renderStart - 1, renderEnd);
  const count = excerpt.length;
  const body = excerpt.map((line) => ` ${line}`).join("\n");
  const patch = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${renderStart},${count} +${renderStart},${count} @@`,
    body,
    "",
  ].join("\n");
  return { label: lineLabel(path, start, boundedEnd), patch };
}
