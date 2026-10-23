import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { mediaArea, place } from "../../shared/media-paths.ts";
import { studioHostContract } from "../../shared/host-contract.ts";
import type { Game } from "../../shared/schema.ts";
import { projectFile } from "./paths.ts";

/**
 * A checkout and, once resolved, the host folder holding its staged media and input
 * snapshots (src/shared/media-paths.ts). Reading a media path needs the folder: it moves
 * out of the checkout when the host collects the canvas.
 */
export type Place = Pick<Game, "hostId" | "rootPath"> & { mediaDir?: string };

/** The checkout with its media folder, as the host resolves it now. */
export async function withMedia<T extends Place>(
  bb: BbPluginApi,
  game: T,
): Promise<T & { mediaDir: string }> {
  const client = bb.hosts.experimental_client({ contract: studioHostContract });
  const { dir } = await client.call(
    "mediaDir",
    { rootPath: game.rootPath },
    { hostId: game.hostId },
  );
  return { ...game, mediaDir: dir };
}

/** BB file API arguments for a canvas path, in the checkout or its media folder. */
export function fileArgs(game: Place, path: string) {
  if (mediaArea(path) && !game.mediaDir)
    throw new Error(`Resolve the game's media folder before using ${path}.`);
  const at = place(game.rootPath, game.mediaDir ?? game.rootPath, path);
  return { hostId: game.hostId, rootPath: at.root, path: projectFile(at.root, at.path) };
}

/** A canvas path's file on the game's host, for agents and file links. */
export const hostFile = (game: Place, path: string) => fileArgs(game, path).path;

/**
 * Writes a canvas file where the host keeps it. A move of the media that lands during the
 * write leaves this copy in the old folder, which the next collection moves in; until then
 * readers look in the new folder, so the file is written there too.
 */
export async function writeMedia<T>(
  bb: BbPluginApi,
  game: Place & { mediaDir: string },
  path: string,
  write: (args: ReturnType<typeof fileArgs>) => Promise<T>,
): Promise<T> {
  const written = await write(fileArgs(game, path));
  if (!mediaArea(path)) return written;
  const current = await withMedia(bb, game);
  return current.mediaDir === game.mediaDir ? written : write(fileArgs(current, path));
}
