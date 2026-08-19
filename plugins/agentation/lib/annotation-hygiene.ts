// Cleanup applied to an annotation between the toolbar and the store.
//
// Kept apart from `toolbar.ts` so it carries no browser or SDK imports and can
// be tested directly.

import type { Annotation } from "./afs.ts";

/**
 * Whether a `sourceFile` points at source rather than a served bundle.
 *
 * The toolbar recovers a source path from React's debug info when a dev build
 * provides one. bb ships a production build, so the lookup falls back to the
 * script URL the frame came from — for anything a plugin drew that is the
 * plugin's own `app.js`, which reads like an answer and is not one. An absent
 * field costs an agent nothing; a wrong one sends it to the wrong file.
 */
export function usableSourceFile(sourceFile: string | undefined): boolean {
  if (!sourceFile) return false;
  if (/^[a-z]+:\/\//i.test(sourceFile)) return false;
  return !/(^|\/)(api|assets)\//.test(sourceFile);
}

export function withoutBundleSource(annotation: Annotation): Annotation {
  if (usableSourceFile(annotation.sourceFile)) return annotation;
  const cleaned: Record<string, unknown> = { ...annotation };
  delete cleaned.sourceFile;
  return cleaned as unknown as Annotation;
}

/**
 * Local annotations the server has never accepted.
 *
 * An id missing from the server's list means one of two opposite things, and
 * getting them backwards either destroys feedback or resurrects deleted
 * feedback:
 *
 *   never sent   — typed just before a reload, or stranded by a failed push.
 *                  Keep it and send it.
 *   sent, gone   — deleted from the review panel. Drop it.
 *
 * `synced` is the set of ids the server has acknowledged for this page, which
 * is what tells the two apart. `knownToServer` must be built from the server's
 * complete list, not just its open annotations: a resolved annotation is still
 * known, and treating it as never-sent would put every resolved marker back.
 */
export function selectOrphans<T extends { id: string }>(
  local: readonly T[],
  knownToServer: ReadonlySet<string>,
  synced: ReadonlySet<string>,
): T[] {
  return local.filter((item) => !knownToServer.has(item.id) && !synced.has(item.id));
}
