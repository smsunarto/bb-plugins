/*
 * Staged media and input snapshots keep their canvas paths, `canvas/staging/…` and
 * `canvas/inputs/…`, everywhere a canvas names them: boards, the catalog, job records and
 * tool inputs. Their files live in the game's media folder, outside the checkout, as
 * `staging/…` and `inputs/…`. A checkout not yet moved keeps them in its own `canvas`
 * folder, which is then its media folder.
 */

/** The media part of a canvas path: its area and the path below it, or null for checkout files. */
export function mediaArea(path: string): { area: "staging" | "inputs"; rest: string } | null {
  const match = /^canvas\/(staging|inputs)(?:\/(.+))?$/.exec(path);
  return match ? { area: match[1] as "staging" | "inputs", rest: match[2] ?? "" } : null;
}

/** Where a canvas path lives: in the media folder for staged media and snapshots, else the checkout. */
export function place(
  rootPath: string,
  mediaDir: string,
  path: string,
): { root: string; path: string } {
  const media = mediaArea(path);
  if (!media) return { root: rootPath, path };
  return { root: mediaDir, path: media.rest ? `${media.area}/${media.rest}` : media.area };
}

/** A game's preview lease: the checkout's base URL, and its media folder's. */
export type Preview = { baseUrl: string; mediaBaseUrl?: string | undefined };

/** A canvas file's preview URL, from the lease's checkout or media base. */
export function previewUrl(lease: Preview, path: string) {
  const media = mediaArea(path);
  const [base, relative] =
    media && lease.mediaBaseUrl
      ? [lease.mediaBaseUrl, `${media.area}/${media.rest}`]
      : [lease.baseUrl, path];
  return `${base.replace(/\/$/, "")}/${relative.split("/").map(encodeURIComponent).join("/")}`;
}
