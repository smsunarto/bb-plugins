import { instructionFiles } from "@bb-plugins/instructions";
import type { BotMetadata } from "../contract.ts";
import type { BotStore } from "./bot-store.ts";

const files = instructionFiles(import.meta.url);

type Project = { id: string; name: string; kind: "personal" | "standard" };
export type BotProjectContext = {
  id: string;
  name: string;
  role: "owner" | "member" | "unjoined" | "personal" | "legacy-home";
  ownerBotId: string | null;
  ownerName: string | null;
};

/** Read-only: membership and durable thread bindings are independent. */
export function botProjectContext(
  bot: BotMetadata,
  project: Project,
  store: BotStore,
): BotProjectContext {
  const base = { id: project.id, name: project.name, ownerBotId: null, ownerName: null };
  if (project.kind === "personal") return { ...base, role: "personal" };
  if (store.list().some((entry) => entry.legacyHomeProjectId === project.id))
    return { ...base, role: "legacy-home" };
  const owner = store.projectOwner(project.id);
  return {
    ...base,
    role:
      owner?.botId === bot.id
        ? "owner"
        : bot.linkedProjectIds.includes(project.id)
          ? "member"
          : "unjoined",
    ownerBotId: owner?.botId ?? null,
    ownerName: owner ? (store.get(owner.botId)?.name ?? "Unavailable bot") : null,
  };
}

const label = (value: string, limit: number) =>
  // oxlint-disable-next-line no-control-regex -- strips terminal control characters from names
  JSON.stringify(value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit));
export function projectContextInstructions(project: BotProjectContext): string {
  if (project.role === "personal" || project.role === "legacy-home")
    return files.read(`bots/project/${project.role}`);
  const where = { name: label(project.name, 60), id: label(project.id, 80) };
  if (project.role === "owner") return files.read("bots/project/owner", where);
  return files.read("bots/project/other", {
    ...where,
    membership: files.read(`bots/project/${project.role}`),
    ownership: project.ownerBotId
      ? files.read("bots/project/owned-by", {
          name: label(project.ownerName!, 60),
          id: label(project.ownerBotId, 80),
        })
      : files.read("bots/project/unowned"),
  });
}
