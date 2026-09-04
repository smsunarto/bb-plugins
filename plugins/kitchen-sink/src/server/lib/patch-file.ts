import {
  FILENAME_HEADER_REGEX,
  FILENAME_HEADER_REGEX_GIT,
  GIT_DIFF_FILE_BREAK_REGEX,
  UNIFIED_DIFF_FILE_BREAK_REGEX,
} from "@pierre/diffs";

export type PatchFile = { path: string; patch: string };

function headerPath(line: string): string | null {
  const git = FILENAME_HEADER_REGEX_GIT.exec(line);
  if (git !== null) return git[2] ?? null;
  const plain = FILENAME_HEADER_REGEX.exec(line);
  if (plain === null) return null;
  const path = plain[2] ?? "";
  return path === "/dev/null" ? null : path;
}

function filePath(chunk: string): string | null {
  const lines = chunk.split("\n");
  const added = lines.find((line) => line.startsWith("+++ "));
  const removed = lines.find((line) => line.startsWith("--- "));
  const fromHeaders = (added && headerPath(added)) || (removed && headerPath(removed)) || null;
  if (fromHeaders !== null) return fromHeaders;
  const git = /^diff --git a\/(.+?) b\/(.+)$/mu.exec(chunk);
  return git?.[2] ?? null;
}

/**
 * Split a unified patch into one entry per file. Git patches split on their
 * `diff --git` headers; plain unified patches split on `--- ` file headers.
 * Leading commit metadata and chunks without a hunk are dropped.
 */
export function splitPatchFiles(text: string): PatchFile[] {
  const source = text.replaceAll("\r\n", "\n");
  const gitChunks = source.split(GIT_DIFF_FILE_BREAK_REGEX);
  const chunks = gitChunks.some((chunk) => chunk.startsWith("diff --git"))
    ? gitChunks.filter((chunk) => chunk.startsWith("diff --git"))
    : source.split(UNIFIED_DIFF_FILE_BREAK_REGEX).filter((chunk) => chunk.startsWith("--- "));
  const files: PatchFile[] = [];
  for (const chunk of chunks) {
    if (!/^@@ /mu.test(chunk)) continue;
    const path = filePath(chunk);
    if (path === null) continue;
    const patch = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
    files.push({ path, patch });
  }
  return files;
}
