// Where a path a spec names opens in BB's file preview. It follows the rule
// data-source.ts reads by, so a file a spec can show is a file it can open:
// `$BB_THREAD_STORAGE/…` and absolute paths inside the thread storage open in
// the storage; relative paths and absolute paths inside the workspace open in
// the workspace; absolute paths in the host's /tmp open on the host; any
// other absolute path opens nothing.

/** The prefix a spec uses for the thread's storage, where agents write artifacts. */
export const THREAD_STORAGE_PREFIX = "$BB_THREAD_STORAGE/";

export type FileOpenTarget =
  | { readonly kind: "thread-storage"; readonly path: string }
  | { readonly kind: "workspace"; readonly path: string }
  | { readonly kind: "host"; readonly path: string };

/** The thread's absolute roots; null when it has none (or they are not needed). */
export interface FileRoots {
  readonly storage: string | null;
  readonly workspace: string | null;
}

const TEMP_ROOTS = ["/tmp", "/private/tmp"];

/** An absolute POSIX path with `.` and `..` resolved, or null when `..` climbs above `/`. */
function normalizeAbsolute(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return `/${parts.join("/")}`;
}

/** `target` relative to `root` when it lies strictly inside it, else null. */
function inside(root: string | null, target: string): string | null {
  const base = root === null ? null : normalizeAbsolute(root);
  if (base === null) return null;
  const prefix = base === "/" ? "/" : `${base}/`;
  return target.length > prefix.length && target.startsWith(prefix) ? target.slice(prefix.length) : null;
}

/** Where `requested` opens, or null when it is an absolute path outside every root a spec may read. */
export function fileOpenTarget(requested: string, roots: FileRoots): FileOpenTarget | null {
  if (requested.startsWith(THREAD_STORAGE_PREFIX)) {
    return { kind: "thread-storage", path: requested.slice(THREAD_STORAGE_PREFIX.length) };
  }
  if (!requested.startsWith("/")) return { kind: "workspace", path: requested };
  const target = normalizeAbsolute(requested);
  if (target === null) return null;
  const inStorage = inside(roots.storage, target);
  if (inStorage !== null) return { kind: "thread-storage", path: inStorage };
  const inWorkspace = inside(roots.workspace, target);
  if (inWorkspace !== null) return { kind: "workspace", path: inWorkspace };
  if (TEMP_ROOTS.some((root) => inside(root, target) !== null)) return { kind: "host", path: target };
  return null;
}
