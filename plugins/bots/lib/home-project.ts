import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract.ts";
import { nextTimestamp, type BotStore } from "./bot-store.ts";
import { createWorkProject } from "./project-creation.ts";

/** Parent folder, on the bot's machine, of every bot's home folder. */
export const HOME_ROOT = "~/bb-bots";

type HomeRequest = { requestId: string; hostId: string; name: string; path: string };
const requestKey = (botId: string) => `home-project:${botId}`;

/** `~/bb-bots/<name>-<id suffix>`: readable, and unique even when two bots share a name. */
export function homePath(bot: Pick<BotMetadata, "id" | "name">) {
  const slug = bot.name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  const suffix = bot.id.replace(/^bot_/u, "").slice(0, 6);
  return `${HOME_ROOT}/${slug ? `${slug}-` : ""}${suffix}`;
}

/** The bot's home folder and the machine it is on: where its home project was created. */
export function homeFolder(
  store: Pick<BotStore, "state">,
  bot: Pick<BotMetadata, "id" | "name" | "hostId">,
) {
  const request = store.state<HomeRequest>(requestKey(bot.id));
  return request
    ? { path: request.path, hostId: request.hostId }
    : { path: homePath(bot), hostId: bot.hostId };
}

/**
 * The bot's home project, created on its machine when it has none or its
 * project was deleted. Projectless conversations run in it instead of BB's
 * shared Personal workspace, so each bot keeps its own folder and environment.
 * Callers serialize this with project creation.
 */
export async function ensureHomeProject(
  bb: BbPluginApi,
  store: BotStore,
  botId: string,
): Promise<string> {
  const bot = store.require(botId);
  const projects = await bb.sdk.projects.list();
  if (bot.homeProjectId && projects.some((project) => project.id === bot.homeProjectId))
    return bot.homeProjectId;
  let request = store.state<HomeRequest>(requestKey(botId));
  // A deleted home or a machine change starts a fresh create request; retries reuse it.
  if (bot.homeProjectId) {
    store.mutate(botId, (current) => ({
      ...current,
      homeProjectId: null,
      updatedAt: nextTimestamp(current.updatedAt),
    }));
    request = null;
  }
  if (!request || request.hostId !== bot.hostId) {
    request = { requestId: randomUUID(), hostId: bot.hostId, name: bot.name, path: homePath(bot) };
    store.setState(requestKey(botId), request);
  }
  const project = await createWorkProject(bb, store, request);
  store.mutate(botId, (current) => ({
    ...current,
    homeProjectId: project.id,
    updatedAt: nextTimestamp(current.updatedAt),
  }));
  return project.id;
}
