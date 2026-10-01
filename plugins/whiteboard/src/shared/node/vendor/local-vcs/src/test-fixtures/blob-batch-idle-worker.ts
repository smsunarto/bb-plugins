// Vendored from dev.fast local-vcs/src/test-fixtures/blob-batch-idle-worker.ts @4ecc570 (MIT).
import { createBlobBatchReader } from "../index.ts";

const [rootPath, commit, relativePath] = process.argv.slice(2);

if (!rootPath || !commit || !relativePath) {
  throw new Error(
    "Usage: blob-batch-idle-worker <root-path> <commit> <relative-path>",
  );
}

const reader = createBlobBatchReader({ rootPath, kind: "git" });

const blob = await reader.read(commit, relativePath);

if (blob === null) throw new Error(`No blob at ${commit}:${relativePath}`);

process.stdout.write(blob);

// No close(): the idle process must not keep the host alive.
