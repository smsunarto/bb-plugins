import type { Game, GameStudioClient } from "@argus-labs/game-studio-api";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/*
 * What a bb thread has to do with a game is this plugin's business, not the studio's. A game
 * connected to a checkout is worked on from threads in that checkout; the studio records the
 * thread id the plugin passes and never checks it.
 */

const normalize = (path: string) => {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^(?:[A-Za-z]:\/|\/\/)/.test(value) ? value.toLowerCase() : value;
};

/** Where a thread runs, when it runs somewhere. */
export async function threadPlace(bb: BbPluginApi, threadId: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  if (!thread.environmentId) return { projectId: thread.projectId, hostId: null, path: null };
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  return {
    projectId: thread.projectId,
    hostId: environment.hostId ?? null,
    path: environment.path ?? null,
  };
}

/** Whether a thread works in the game's checkout; a game without one is open to any thread. */
export function sameCheckout(
  game: Game,
  place: { projectId: string | null; hostId: string | null; path: string | null },
) {
  const checkout = game.checkout;
  if (!checkout) return true;
  return (
    place.projectId === checkout.projectId &&
    place.hostId === checkout.hostId &&
    !!place.path &&
    normalize(place.path) === normalize(checkout.rootPath)
  );
}

/** The game, after checking the thread may act on it. */
export async function gameForThread(
  bb: BbPluginApi,
  api: GameStudioClient,
  gameId: string,
  threadId: string,
): Promise<Game> {
  const { games } = await api.games.list();
  const game = games.find((entry) => entry.id === gameId);
  if (!game) throw new Error("This game is not registered in Game Studio.");
  if (game.checkout && !sameCheckout(game, await threadPlace(bb, threadId)))
    throw new Error("Use a thread in the game's bb project and checkout.");
  return game;
}

/** The game a thread works on: the one connected to its checkout, else the one naming the thread. */
export async function threadGame(
  bb: BbPluginApi,
  api: GameStudioClient,
  threadId: string,
): Promise<Game | null> {
  const { games } = await api.games.list();
  const named = games.find((game) => game.threadId === threadId);
  if (named) return named;
  const place = await threadPlace(bb, threadId);
  return games.find((game) => game.checkout && sameCheckout(game, place)) ?? null;
}
