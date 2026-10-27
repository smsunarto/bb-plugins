import { NODE_MENTION_PROVIDER, nodeMentionRef } from "@argus-labs/game-studio-api";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { StudioClient } from "./studio-client.ts";

/*
 * `@` a canvas node in the composer. The studio searches its boards and describes the node;
 * this narrows the menu to the games connected to the composer's project and attaches the
 * output image the studio hands back.
 */

const SEARCH_WAIT_MS = 1200;
const RESOLVE_WAIT_MS = 4000;

function timed<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms.`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export function registerNodeMention(bb: BbPluginApi, studio: StudioClient): () => void {
  bb.ui.registerMentionProvider({
    id: NODE_MENTION_PROVIDER,
    label: "Game Studio nodes",
    async search(ctx) {
      let api: Awaited<ReturnType<StudioClient["client"]>>;
      try {
        api = await studio.client();
      } catch {
        return [];
      }
      const [{ items }, { games }] = await Promise.all([
        timed(api.canvas.searchNodes({ q: ctx.query }), SEARCH_WAIT_MS, "Searching the canvas"),
        timed(api.games.list(), SEARCH_WAIT_MS, "Listing games"),
      ]);
      // A composer in a project sees the games connected to that project, and the unconnected ones.
      const place = { projectId: ctx.projectId ?? null, hostId: null, path: null };
      const visible = new Set(
        games
          .filter((game) => !ctx.projectId || !game.checkout || game.checkout.projectId === place.projectId)
          .map((game) => game.id),
      );
      return items
        .filter((item) => visible.has(item.ref.gameId))
        .map(({ id, title, subtitle, icon }) => ({ id, title, subtitle, icon }));
    },
    async resolve(itemId) {
      const parsed = nodeMentionRef.safeParse(
        (() => {
          try {
            return JSON.parse(itemId);
          } catch {
            return null;
          }
        })(),
      );
      if (!parsed.success)
        throw new Error("This Game Studio node reference is invalid. Mention the node again.");
      const ref = parsed.data;
      const api = await studio.client();
      const { context, image } = await timed(
        api.canvas.nodeContext(ref.gameId, ref.boardId, ref.nodeId),
        RESOLVE_WAIT_MS,
        "Reading the canvas",
      );
      if (!image) return { context };
      return {
        context,
        experimental_images: [
          {
            type: "image",
            url: `data:${image.mime};base64,${image.base64}`,
            context: `Output of node ${ref.nodeId}`,
          },
        ],
      };
    },
  });
  return () => {};
}
