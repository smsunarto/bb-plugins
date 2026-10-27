import { gameSchema } from "@argus-labs/game-studio-api";
import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { StudioContext } from "../lib/studio-context.ts";
import { gameForThread } from "../lib/thread-game.ts";

/** Names the thread a game is worked on from, when a request is added to that thread's composer. */
export const nameThread = defineMutation({
  input: z.object({ gameId: z.string().min(1), threadId: z.string().min(1) }).strict(),
  output: z.object({ game: gameSchema }),
  description: "Record the bb thread that works on a Game Studio game.",
  async execute(ctx: StudioContext, { gameId, threadId }) {
    const api = await ctx.studio.client();
    const game = await gameForThread(ctx.bb, api, gameId, threadId);
    if (game.threadId === threadId) return { game };
    return { game: await api.games.update(gameId, { threadId }) };
  },
});
