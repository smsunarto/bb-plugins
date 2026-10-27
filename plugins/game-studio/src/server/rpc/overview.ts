import { gameSchema } from "@argus-labs/game-studio-api";
import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { StudioContext } from "../lib/studio-context.ts";

/** What the app needs to embed the studio and name the game a thread works on. */
export const overview = defineQuery({
  input: z.object({}).strict(),
  output: z.object({
    studioUrl: z.string(),
    /** Null until the plugin's Access settings are filled in; the app then shows what to set. */
    games: z.array(gameSchema).nullable(),
    error: z.string().nullable(),
  }),
  async execute(ctx: StudioContext) {
    const studioUrl = await ctx.studio.url();
    try {
      const api = await ctx.studio.client();
      return { studioUrl, games: (await api.games.list()).games, error: null };
    } catch (error) {
      return {
        studioUrl,
        games: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
