// Vendored from dev.fast local-vcs/src/test-fixtures/notes-write-worker.ts @4ecc570 (MIT).
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { writeNote } from "../notes.ts";

const [rootPath, ref, commit, content, barrierPath, readyPath] =
  process.argv.slice(2);

if (!rootPath || !ref || !commit || !content || !barrierPath || !readyPath) {
  throw new Error(
    "Usage: notes-write-worker <root> <ref> <commit> <content> <barrier> <ready>",
  );
}

writeFileSync(readyPath, "ready");

while (!existsSync(barrierPath)) {
  await sleep(10);
}

await writeNote({ commit, content, ref, rootPath });
