import {
  GIT_DIFF_FILE_BREAK_REGEX,
  UNIFIED_DIFF_FILE_BREAK_REGEX,
  getSingularPatch,
} from "@pierre/diffs";

export function relativeEmbedPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\\\0\r\n]/u.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Keep original patch text. Pierre supplies identity, rename metadata and validation. */
export function splitPatchFiles(text: string) {
  const source = text.replaceAll("\r\n", "\n");
  const git = source.split(GIT_DIFF_FILE_BREAK_REGEX);
  const chunks = git.some((chunk) => chunk.startsWith("diff --git"))
    ? git.filter((chunk) => chunk.startsWith("diff --git"))
    : source.split(UNIFIED_DIFF_FILE_BREAK_REGEX).filter((chunk) => chunk.startsWith("--- "));
  if (!chunks.length && source.trim()) throw new Error("No unified file patches found.");
  return chunks.map((patch) => {
    const file = getSingularPatch(patch);
    if (!relativeEmbedPath(file.name) || (file.prevName && !relativeEmbedPath(file.prevName)))
      throw new Error("Patch paths must stay inside the workspace.");
    return { path: file.name, previousPath: file.prevName, patch, hunks: file.hunks.length };
  });
}
