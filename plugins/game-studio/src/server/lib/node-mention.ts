import type { BbPluginApi, PluginMentionItem } from "@get-bb/plugin-sdk";
import { NODE_MENTION_PROVIDER, nodeMentionRef } from "../../shared/node-mention.ts";
import { nodeInputs } from "../../shared/recipes.ts";
import type { Asset, Board, CanvasNode, Game, Workspace } from "../../shared/schema.ts";
import { fileArgs, withMedia } from "./media.ts";
import { listGames, loadWorkspace } from "./studio.ts";

/*
 * `@` a canvas node in the composer. The menu searches the boards of the games in the
 * composer's project; a game whose host is slow or away contributes nothing rather than
 * holding the menu. Sending resolves the node from its saved board, with its output image
 * when it has one, so the agent reads what the person is pointing at.
 */

const SEARCH_WAIT_MS = 1200;
const WORKSPACE_TTL_MS = 10_000;
const RESOLVE_WAIT_MS = 4000;
const IMAGE_BYTES_MAX = 4 * 1024 * 1024;
const TEXT_MAX = 2000;
const ITEMS_MAX = 25;

const icons: Record<CanvasNode["type"], string> = {
  text: "Type",
  image: "Image",
  video: "Video",
  asset: "Music",
  "model-3d": "Box",
  "animate-3d": "Box",
  agent: "Bot",
  document: "FileText",
  table: "Table",
};
const mimes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const title = (node: Pick<CanvasNode, "title" | "type">) => node.title || node.type;
/** The board's name as the index lists it; the board file carries none of its own. */
const nameOf = (workspace: Pick<Workspace, "index">, board: Pick<Board, "id" | "name">) =>
  workspace.index.boards.find(({ id }) => id === board.id)?.name || board.name || board.id;
const clip = (text: string) =>
  text.length > TEXT_MAX
    ? `${text.slice(0, TEXT_MAX)}… [${text.length - TEXT_MAX} more characters]`
    : text;

function timed<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms.`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The node's chosen output asset, when its catalog entry still exists. */
function outputOf(node: CanvasNode, assets: Asset[]): Asset | undefined {
  const id = typeof node.data.assetId === "string" ? node.data.assetId : "";
  return id ? assets.find((asset) => asset.id === id) : undefined;
}

function describeNode(
  game: Game,
  board: Board,
  boardName: string,
  revision: string,
  node: CanvasNode,
  assets: Asset[],
) {
  const kindOf = (id: string) => board.nodes.find((other) => other.id === id)?.type;
  const nameOf = (id: string) => {
    const other = board.nodes.find((candidate) => candidate.id === id);
    return other ? `“${title(other)}” (${other.id})` : id;
  };
  const lines = [
    `Game Studio node “${title(node)}” (${node.type}) on board “${boardName}” of game “${game.name}”.`,
    `gameId: ${game.id} · boardId: ${board.id} · nodeId: ${node.id} · board revision: ${revision}`,
  ];
  if (node.description) lines.push(`Description: ${clip(node.description)}`);
  for (const key of ["text", "instruction", "prompt", "criteria"])
    if (typeof node.data[key] === "string" && node.data[key].trim())
      lines.push(`${key[0]!.toUpperCase()}${key.slice(1)}: ${clip(node.data[key].trim())}`);
  if (typeof node.data.recipe === "string") lines.push(`Recipe: ${node.data.recipe}`);
  const inputs = nodeInputs(node, kindOf)
    .filter(({ refs }) => refs.length)
    .map(
      ({ port, refs }) =>
        `${port.label}: ${refs
          .map((ref) =>
            ref.type === "node"
              ? nameOf(String(ref.nodeId))
              : `library asset ${String(ref.assetId)}`,
          )
          .join(", ")}`,
    );
  if (inputs.length) lines.push(`Inputs — ${inputs.join("; ")}`);
  const output = outputOf(node, assets);
  lines.push(output ? `Output: ${output.path} (${output.type})` : "Output: none yet");
  lines.push(
    `Read it in full with game_studio_canvas_context {gameId, boardId, nodeIds:["${node.id}"]}; edit it with game_studio_canvas_edit using the board revision above.`,
  );
  return lines.join("\n");
}

/** Registers the provider; returns what unregisters its cache. */
export function registerNodeMention(bb: BbPluginApi): () => void {
  const cached = new Map<string, { at: number; workspace: Promise<Workspace> }>();
  const workspaceOf = (game: Game) => {
    const held = cached.get(game.id);
    if (held && Date.now() - held.at < WORKSPACE_TTL_MS) return held.workspace;
    const workspace = loadWorkspace(bb, game.id);
    cached.set(game.id, { at: Date.now(), workspace });
    workspace.catch(() => cached.delete(game.id));
    return workspace;
  };
  bb.ui.registerMentionProvider({
    id: NODE_MENTION_PROVIDER,
    label: "Game Studio nodes",
    async search(ctx) {
      const query = ctx.query.trim().toLowerCase();
      const games = (await listGames(bb)).filter(
        (game) => !ctx.projectId || game.projectId === ctx.projectId,
      );
      const read = await Promise.allSettled(
        games.map((game) => timed(workspaceOf(game), SEARCH_WAIT_MS, "Reading the canvas")),
      );
      const items: (PluginMentionItem & { rank: number })[] = [];
      read.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const game = games[index]!;
        for (const { board } of result.value.boards) {
          const boardName = nameOf(result.value, board);
          for (const node of board.nodes) {
            const name = title(node);
            const haystack = `${name} ${node.id} ${node.type}`.toLowerCase();
            if (query && !haystack.includes(query)) continue;
            items.push({
              id: JSON.stringify({ gameId: game.id, boardId: board.id, nodeId: node.id }),
              title: name,
              subtitle: `${game.name} · ${boardName}`,
              icon: icons[node.type],
              rank: query && name.toLowerCase().startsWith(query) ? 0 : 1,
            });
          }
        }
      });
      return items
        .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
        .slice(0, ITEMS_MAX)
        .map(({ rank: _rank, ...item }) => item);
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
      const workspace = await timed(
        loadWorkspace(bb, ref.gameId),
        RESOLVE_WAIT_MS,
        "Reading the canvas",
      );
      const selected = workspace.boards.find(({ board }) => board.id === ref.boardId);
      const node = selected?.board.nodes.find((node) => node.id === ref.nodeId);
      if (!selected || !node)
        throw new Error("This canvas node no longer exists. Mention the node again.");
      const context = describeNode(
        workspace.game,
        selected.board,
        nameOf(workspace, selected.board),
        selected.revision,
        node,
        workspace.assets,
      );
      const output = outputOf(node, workspace.assets);
      const mime =
        output?.type === "image" ? mimes[output.path.split(".").pop()!.toLowerCase()] : undefined;
      if (!output || !mime) return { context };
      try {
        const game = await timed(
          withMedia(bb, workspace.game),
          RESOLVE_WAIT_MS,
          "Finding the media",
        );
        const file = await timed(
          bb.sdk.files.read(fileArgs(game, output.path)),
          RESOLVE_WAIT_MS,
          "Reading the output",
        );
        if (file.contentEncoding !== "base64" || file.sizeBytes > IMAGE_BYTES_MAX)
          return { context };
        return {
          context,
          experimental_images: [
            {
              type: "image",
              url: `data:${mime};base64,${file.content}`,
              context: `Output of “${title(node)}”`,
            },
          ],
        };
      } catch (error) {
        bb.log.warn(
          `canvas node mention: output image of ${node.id} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { context };
      }
    },
  });
  return () => cached.clear();
}
