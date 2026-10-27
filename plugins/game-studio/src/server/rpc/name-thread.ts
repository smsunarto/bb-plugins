import { gameSchema } from "@argus-labs/game-studio-api";
import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { StudioContext } from "../lib/studio-context.ts";
import { gameForThread, threadPlace } from "../lib/thread-game.ts";

/**
 * Names the thread a game is worked on from, when a request is added to that thread's composer.
 * A game not yet connected to a checkout takes this thread's: bb is the only client that knows
 * where a thread runs, and the studio accepts a checkout from bb alone.
 */
export const nameThread = defineMutation({
  input: z.object({ gameId: z.string().min(1), threadId: z.string().min(1) }).strict(),
  output: z.object({ game: gameSchema }),
  description: "Record the bb thread, and its checkout, that work on a Game Studio game.",
  async execute(ctx: StudioContext, { gameId, threadId }) {
    const api = await ctx.studio.client();
    const game = await gameForThread(ctx.bb, api, gameId, threadId);
    const place = game.checkout ? null : await threadPlace(ctx.bb, threadId);
    const checkout =
      place?.hostId && place.path && place.projectId
        ? { projectId: place.projectId, hostId: place.hostId, rootPath: place.path }
        : undefined;
    if (game.threadId === threadId && !checkout) return { game };
    return {
      game: await api.games.update(gameId, { threadId, ...(checkout ? { checkout } : {}) }),
    };
  },
});
