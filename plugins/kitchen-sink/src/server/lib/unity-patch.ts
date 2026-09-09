type Hunk = { oldStart: number; newStart: number; before: string[]; after: string[]; end: number };
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function readHunk(lines: string[], index: number, match: RegExpExecArray): Hunk {
  const oldCount = Number(match[2] ?? 1);
  const newCount = Number(match[4] ?? 1);
  const before: string[] = [];
  const after: string[] = [];
  let end = index;
  while (before.length < oldCount || after.length < newCount) {
    const line = lines[++end];
    if (line === undefined) throw new Error("Incomplete patch");
    const prefix = line.charAt(0);
    if (![" ", "+", "-"].includes(prefix)) throw new Error("Invalid hunk");
    const noNewline = lines[end + 1]?.startsWith("\\ No newline");
    const content = line.slice(1) + (noNewline ? "" : "\n");
    if (noNewline) end++;
    if (prefix !== "+") before.push(content);
    if (prefix !== "-") after.push(content);
  }
  if (before.length !== oldCount || after.length !== newCount)
    throw new Error("Invalid hunk counts");
  return {
    oldStart: Number(match[1]) - (oldCount === 0 ? 0 : 1),
    newStart: Number(match[3]) - (newCount === 0 ? 0 : 1),
    before,
    after,
    end,
  };
}

/** Apply only exact, complete unified hunks. Never guess when the base moved. */
export function applyUnityPatch(base: string, patch: string): string {
  const old = base.replace(/\r\n/g, "\n").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const output: string[] = [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let cursor = 0;
  let hunks = 0;
  for (let index = 0; index < lines.length; index++) {
    const match = HEADER.exec(lines[index]!);
    if (!match) continue;
    const hunk = readHunk(lines, index, match);
    if (hunk.oldStart < cursor || hunk.oldStart > old.length)
      throw new Error("Invalid hunk position");
    output.push(...old.slice(cursor, hunk.oldStart));
    if (output.length !== hunk.newStart) throw new Error("Invalid new hunk position");
    cursor = hunk.oldStart;
    for (const line of hunk.before) {
      if (old[cursor++] !== line) throw new Error("Patch base changed");
    }
    output.push(...hunk.after);
    index = hunk.end;
    hunks++;
  }
  if (!hunks) throw new Error("No complete hunks");
  output.push(...old.slice(cursor));
  return output.join("");
}

export function changedUnityLines(patch: string): { old: Set<number>; new: Set<number> } {
  const result = { old: new Set<number>(), new: new Set<number>() };
  let before = 0;
  let after = 0;
  let active = false;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      before = Number(header[1]);
      after = Number(header[2]);
      active = true;
      continue;
    }
    if (!active) continue;
    if (line.startsWith("-")) result.old.add(before++);
    else if (line.startsWith("+")) result.new.add(after++);
    else if (line.startsWith(" ")) {
      before++;
      after++;
    }
  }
  return result;
}
