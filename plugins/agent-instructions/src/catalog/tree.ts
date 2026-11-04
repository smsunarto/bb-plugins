import { createHash } from "node:crypto";

/** Hash of every file's path, mode, and content: the name of the skill's immutable tree. */
export function treeSha(files: readonly { path: string; executable: boolean; sha256: string }[]) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1)))
    hash.update(`${file.path}\0${file.executable ? 1 : 0}\0${file.sha256}\n`);
  return hash.digest("hex");
}
