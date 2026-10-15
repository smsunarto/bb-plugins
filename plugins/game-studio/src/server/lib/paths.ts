import { posix, win32 } from "node:path";

export function pathTools(root: string): typeof posix {
  return win32.isAbsolute(root) && !posix.isAbsolute(root) ? win32 : posix;
}

export function absoluteRoot(root: string): string {
  if (root.includes("\0") || (!posix.isAbsolute(root) && !win32.isAbsolute(root))) {
    throw new Error("Choose an absolute directory on the selected machine.");
  }
  const paths = pathTools(root);
  const normalized = paths.normalize(root);
  if (normalized === paths.parse(normalized).root) {
    throw new Error("Choose a game directory below the filesystem root.");
  }
  return normalized.replace(/[\\/]+$/, "");
}

export function relativeFile(path: string): string {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.includes(":") ||
    posix.isAbsolute(path)
  ) {
    throw new Error("File paths must be relative to the game directory.");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("File paths cannot contain empty, dot, or parent segments.");
  }
  return path;
}

export function projectFile(root: string, relative: string): string {
  const path = relativeFile(relative);
  return pathTools(root).join(root, ...path.split("/"));
}
