import { readdir } from "node:fs/promises";
import path from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { docsHostContract } from "./host-contract.js";
import { isExcludedDocsPath } from "./path-policy.js";

type ListedPath = { kind: "file" | "directory"; path: string };

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function listPaths(input: {
  path: string;
  includeFiles: boolean;
  includeDirectories: boolean;
  limit: number;
  signal: AbortSignal;
}): Promise<{ paths: ListedPath[]; truncated: boolean }> {
  if (!path.isAbsolute(input.path)) throw new Error("Path must be absolute");

  const paths: ListedPath[] = [];
  let truncated = false;
  const append = (entry: ListedPath): boolean => {
    if (paths.length >= input.limit) {
      truncated = true;
      return false;
    }
    paths.push(entry);
    return true;
  };

  const visit = async (directory: string): Promise<void> => {
    input.signal.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      input.signal.throwIfAborted();
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(input.path, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory() && isExcludedDocsPath(relativePath)) continue;
      if (entry.isDirectory()) {
        if (input.includeDirectories && !append({ kind: "directory", path: relativePath })) return;
        await visit(fullPath);
      } else if (entry.isFile() && input.includeFiles) {
        if (!append({ kind: "file", path: relativePath })) return;
      }
    }
  };

  try {
    await visit(input.path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return { paths, truncated };
}

export default experimental_defineHostEntry({
  contract: docsHostContract,
  handlers: {
    listPaths: (input, context) => listPaths({ ...input, signal: context.signal }),
  },
});
