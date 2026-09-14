import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, relative, sep } from "node:path";
import { z } from "zod";

export const SHARED_DIRECTORY_MAX_REPOSITORIES = 32;
export const SHARED_DIRECTORY_MAX_PATH_LENGTH = 4_096;

const inspectedPathSchema = z.object({
  requestedPath: z.string(),
  canonicalPath: z.string().nullable(),
  kind: z.enum(["directory", "file", "missing", "error"]),
  message: z.string().nullable(),
});

export const inspectSharedDirectoryInputSchema = z.object({
  repositoryPaths: z
    .array(z.string().trim().min(1).max(SHARED_DIRECTORY_MAX_PATH_LENGTH))
    .min(2)
    .max(SHARED_DIRECTORY_MAX_REPOSITORIES),
  rootPath: z.string().trim().min(1).max(SHARED_DIRECTORY_MAX_PATH_LENGTH).optional(),
});

export const inspectSharedDirectoryOutputSchema = z.object({
  homePath: z.string(),
  filesystemRootPath: z.string(),
  suggestedRootPath: z.string().nullable(),
  repositories: z.array(inspectedPathSchema),
  root: inspectedPathSchema.nullable(),
  rootContainsRepositories: z.array(z.boolean()),
});

export type InspectSharedDirectoryInput = z.infer<typeof inspectSharedDirectoryInputSchema>;
export type InspectSharedDirectoryOutput = z.infer<typeof inspectSharedDirectoryOutputSchema>;

export const sharedDirectoryHostContract = {
  inspectSharedDirectory: {
    input: inspectSharedDirectoryInputSchema,
    output: inspectSharedDirectoryOutputSchema,
  },
} as const;

function isContained(rootPath: string, childPath: string): boolean {
  const remainder = relative(rootPath, childPath);
  return (
    remainder === "" ||
    (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
  );
}

function commonAncestor(paths: readonly string[]): string | null {
  const first = paths[0];
  if (first === undefined) return null;
  let candidate = first;
  for (const path of paths.slice(1)) {
    while (!isContained(candidate, path)) {
      const parent = dirname(candidate);
      if (parent === candidate) return parent;
      candidate = parent;
    }
  }
  return candidate;
}

async function inspectPath(requestedPath: string): Promise<z.infer<typeof inspectedPathSchema>> {
  if (!isAbsolute(requestedPath)) {
    return {
      requestedPath,
      canonicalPath: null,
      kind: "error",
      message: "path must be absolute",
    };
  }
  try {
    const canonicalPath = await realpath(requestedPath);
    const metadata = await stat(canonicalPath);
    return {
      requestedPath,
      canonicalPath,
      kind: metadata.isDirectory() ? "directory" : "file",
      message: null,
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;
    return {
      requestedPath,
      canonicalPath: null,
      kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Runs inside bb.host so realpath/stat use the selected machine's filesystem. */
export async function inspectSharedDirectory(
  input: InspectSharedDirectoryInput,
): Promise<InspectSharedDirectoryOutput> {
  const repositories = await Promise.all(input.repositoryPaths.map(inspectPath));
  const canonicalRepositories = repositories.flatMap((entry) =>
    entry.kind === "directory" && entry.canonicalPath !== null ? [entry.canonicalPath] : [],
  );
  const suggestedRootPath =
    canonicalRepositories.length === repositories.length
      ? commonAncestor(canonicalRepositories)
      : null;
  const root = input.rootPath === undefined ? null : await inspectPath(input.rootPath);
  const canonicalHome = await realpath(homedir()).catch(() => homedir());
  const firstCanonical = canonicalRepositories[0] ?? root?.canonicalPath ?? canonicalHome;
  const effectiveRootPath = root?.canonicalPath ?? suggestedRootPath;
  return {
    homePath: canonicalHome,
    filesystemRootPath: parse(firstCanonical).root,
    suggestedRootPath,
    repositories,
    root,
    rootContainsRepositories: repositories.map(
      (entry) =>
        effectiveRootPath !== null &&
        entry.canonicalPath !== null &&
        isContained(effectiveRootPath, entry.canonicalPath),
    ),
  };
}
