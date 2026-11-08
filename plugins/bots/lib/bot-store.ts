import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { metadataSchema, sectionSchema, type BotMetadata, type BotSection } from "../contract.ts";

/**
 * The bot tables. bb applies one list per database by position, so this list
 * stays append-only. GTD Sidebar keeps a frozen copy for its retired tables.
 */
export const BOT_MIGRATIONS = [
  "CREATE TABLE bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE bot_threads (thread_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id))",
  "CREATE TABLE bot_state (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE bot_starts (token TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), created_at INTEGER NOT NULL)",
  "CREATE TABLE bot_project_owners (project_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, assigned_at INTEGER NOT NULL)",
  "CREATE INDEX bot_project_owners_by_bot ON bot_project_owners(bot_id)",
  "ALTER TABLE bot_starts ADD COLUMN project_id TEXT",
  "CREATE TABLE thread_completion (thread_id TEXT PRIMARY KEY, completed_at INTEGER, reopened_at INTEGER)",
  // A user's explicit "No bot": stops parent/fork inheritance at this thread.
  "CREATE TABLE thread_detached (thread_id TEXT PRIMARY KEY, detached_at INTEGER NOT NULL)",
  // Routines: a bot's scheduled instructions; Automations runs each one's schedule.
  "CREATE TABLE bot_routines (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, data TEXT NOT NULL)",
  "CREATE INDEX bot_routines_by_bot ON bot_routines(bot_id)",
];

/** Prefixes of the `bot_state` keys a bot owns, each stored as `<prefix>:<bot id>`. */
const BOT_STATE_KEYS = [
  "legacy-state",
  "legacy-record",
  "home-project",
  "last-message",
  "private-state-warning",
];

/** A stored bot row, minus fields bots no longer have: role and the launch preset's starter prompt. */
function storedRow(data: string): unknown {
  const parsed: unknown = JSON.parse(data);
  if (!parsed || typeof parsed !== "object") return parsed;
  const { role: _role, ...rest } = parsed as Record<string, unknown>;
  const preset = rest.launchPreset;
  if (preset && typeof preset === "object" && "initialPrompt" in preset) {
    const { initialPrompt: _prompt, ...launchPreset } = preset as Record<string, unknown>;
    rest.launchPreset = launchPreset;
  }
  return rest;
}

/** Expects `BOT_MIGRATIONS` to have run on the plugin database. */
export function createBotStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  const legacySchema = metadataSchema
    .omit({ stateReady: true, homeProjectId: true })
    .extend({ homePath: z.string(), homeProjectId: z.string().nullable() })
    .strict();
  const raw = (id: string) =>
    db.prepare("SELECT data FROM bots WHERE id = ?").get(id) as { data: string } | undefined;
  function decode(data: string): BotMetadata {
    const parsed = storedRow(data);
    // Rows saved before bots got home projects again name the field legacyHomeProjectId.
    if (parsed && typeof parsed === "object" && "legacyHomeProjectId" in parsed) {
      const { legacyHomeProjectId, ...rest } = parsed as Record<string, unknown>;
      const renamed = metadataSchema.safeParse({ ...rest, homeProjectId: legacyHomeProjectId });
      if (renamed.success) return renamed.data;
    }
    const current = metadataSchema.safeParse(parsed);
    if (current.success) return current.data;
    const { homePath: _path, homeProjectId, ...legacy } = legacySchema.parse(parsed);
    return { ...legacy, homeProjectId, stateReady: false };
  }
  const get = (id: string): BotMetadata | null => {
    const row = raw(id);
    return row ? decode(row.data) : null;
  };
  const list = (): BotMetadata[] =>
    (db.prepare("SELECT data FROM bots").all() as { data: string }[])
      .map((row) => decode(row.data))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const save = (bot: BotMetadata) =>
    db
      .transaction(() => {
        const value = metadataSchema.parse(bot);
        const previous = raw(bot.id);
        if (previous) {
          const legacy = legacySchema.safeParse(storedRow(previous.data));
          if (legacy.success) {
            if (!state(`legacy-state:${bot.id}`))
              setState(`legacy-state:${bot.id}`, {
                hostId: legacy.data.hostId,
                path: legacy.data.homePath,
                homeProjectId: legacy.data.homeProjectId,
              });
            if (!state(`legacy-record:${bot.id}`)) setState(`legacy-record:${bot.id}`, legacy.data);
          }
        }
        db.prepare(
          "INSERT INTO bots(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        ).run(value.id, JSON.stringify(value));
        return value;
      })
      .immediate();
  const state = <T>(key: string): T | null => {
    const row = db.prepare("SELECT data FROM bot_state WHERE key = ?").get(key) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  };
  const setState = (key: string, value: unknown) => {
    db.prepare(
      "INSERT INTO bot_state(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
    ).run(key, JSON.stringify(value));
  };
  const owner = (threadId: string): string | null =>
    (
      db.prepare("SELECT bot_id FROM bot_threads WHERE thread_id = ?").get(threadId) as
        | { bot_id: string }
        | undefined
    )?.bot_id ?? null;
  const bind = (threadId: string, botId: string) => {
    if (!get(botId)) throw new Error("Bot no longer exists");
    const existing = owner(threadId);
    if (existing && existing !== botId)
      throw new Error("Conversation already belongs to another bot");
    db.prepare("INSERT OR IGNORE INTO bot_threads(thread_id,bot_id) VALUES (?,?)").run(
      threadId,
      botId,
    );
    db.prepare("DELETE FROM thread_detached WHERE thread_id = ?").run(threadId);
  };
  const detached = (threadId: string) =>
    db.prepare("SELECT 1 FROM thread_detached WHERE thread_id = ?").get(threadId) !== undefined;
  const ownerQuery =
    "SELECT p.project_id AS projectId, p.bot_id AS botId, p.assigned_at AS assignedAt FROM bot_project_owners p JOIN bots b ON b.id = p.bot_id WHERE EXISTS (SELECT 1 FROM json_each(b.data, '$.linkedProjectIds') j WHERE j.value = p.project_id)";
  const rawProjectOwner = (projectId: string) =>
    db
      .prepare("SELECT bot_id AS botId FROM bot_project_owners WHERE project_id = ?")
      .get(projectId) as { botId: string } | undefined;
  const projectOwner = (projectId: string) =>
    db.prepare(`${ownerQuery} AND p.project_id = ?`).get(projectId) as ProjectOwnership | undefined;
  const projectOwners = () =>
    db.prepare(`${ownerQuery} ORDER BY p.project_id`).all() as ProjectOwnership[];
  const ownedProjects = (botId: string) =>
    (
      db
        .prepare(`${ownerQuery} AND p.bot_id = ? ORDER BY p.project_id`)
        .all(botId) as ProjectOwnership[]
    ).map((entry) => entry.projectId);
  function saveWithProjects(bot: BotMetadata, desiredOwners?: string[]) {
    return db
      .transaction(() => {
        const previous = db
          .prepare(
            "SELECT project_id AS projectId, assigned_at AS assignedAt FROM bot_project_owners WHERE bot_id = ?",
          )
          .all(bot.id) as { projectId: string; assignedAt: number }[];
        const validPrevious = new Set(ownedProjects(bot.id));
        const desired =
          desiredOwners ?? [...validPrevious].filter((id) => bot.linkedProjectIds.includes(id));
        if (
          new Set(desired).size !== desired.length ||
          desired.some((id) => !bot.linkedProjectIds.includes(id))
        )
          throw new Error("Every owned project must be linked exactly once");
        for (const projectId of desired) {
          const current = rawProjectOwner(projectId);
          if (current && current.botId !== bot.id)
            throw new Error(
              `Project already owned by ${get(current.botId)?.name ?? current.botId}. Release that ownership first.`,
            );
        }
        const value = save(bot);
        db.prepare("DELETE FROM bot_project_owners WHERE bot_id = ?").run(bot.id);
        const insert = db.prepare(
          "INSERT INTO bot_project_owners(project_id,bot_id,assigned_at) VALUES (?,?,?)",
        );
        for (const projectId of desired)
          insert.run(
            projectId,
            bot.id,
            previous.find((entry) => entry.projectId === projectId && validPrevious.has(projectId))
              ?.assignedAt ?? Date.now(),
          );
        return value;
      })
      .immediate();
  }
  return {
    get,
    list,
    save,
    state,
    setState,
    owner,
    bind,
    detached,
    projectOwner,
    detachedIds: () =>
      (
        db
          .prepare("SELECT thread_id AS threadId FROM thread_detached ORDER BY thread_id")
          .all() as { threadId: string }[]
      ).map((row) => row.threadId),
    /**
     * The user's explicit choice of bot for a conversation (and the descendants that
     * moved with it). Moving or detaching is only ever this deliberate action; routing
     * never steals. Null detaches the conversation so it no longer inherits a bot.
     */
    reassign(
      threadId: string,
      threadIds: readonly string[],
      botId: string | null,
      projectId: string | null,
    ) {
      return db
        .transaction(() => {
          const target = botId ? get(botId) : null;
          if (botId && !target) throw new Error("Bot no longer exists");
          const moving = new Set([threadId, ...threadIds]);
          const previous = new Set(
            [...moving].map(owner).filter((id): id is string => Boolean(id) && id !== botId),
          );
          for (const id of previous) {
            const bot = get(id);
            if (!bot?.threadOrder?.some((entry) => moving.has(entry))) continue;
            save({
              ...bot,
              threadOrder: bot.threadOrder.filter((entry) => !moving.has(entry)),
              updatedAt: nextTimestamp(bot.updatedAt),
            });
          }
          const remove = db.prepare("DELETE FROM bot_threads WHERE thread_id = ?");
          for (const id of moving) remove.run(id);
          let joined = false;
          if (target) {
            joined = projectId !== null && !target.linkedProjectIds.includes(projectId);
            if (joined)
              saveWithProjects({
                ...target,
                linkedProjectIds: [...target.linkedProjectIds, projectId!],
                updatedAt: nextTimestamp(target.updatedAt),
              });
            for (const id of moving) bind(id, target.id);
          } else {
            db.prepare(
              "INSERT INTO thread_detached(thread_id,detached_at) VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET detached_at=excluded.detached_at",
            ).run(threadId, Date.now());
            const undetach = db.prepare("DELETE FROM thread_detached WHERE thread_id = ?");
            for (const id of threadIds) if (id !== threadId) undetach.run(id);
          }
          return { joined, previous: [...previous] };
        })
        .immediate();
    },
    projectOwners,
    ownedProjects,
    saveWithProjects,
    changeProjectRole(id: string, projectId: string, action: "join" | "leave" | "own" | "release") {
      return db
        .transaction(() => {
          const bot = get(id);
          if (!bot) throw new Error("Bot no longer exists");
          const currentOwner = rawProjectOwner(projectId);
          if (action === "own" && currentOwner && currentOwner.botId !== id)
            throw new Error(
              `Project already owned by ${get(currentOwner.botId)?.name ?? currentOwner.botId}. Release that ownership first.`,
            );
          if (action === "release" && currentOwner && currentOwner.botId !== id)
            throw new Error("Only this project's owner can release ownership");
          const linked = new Set(bot.linkedProjectIds);
          const owned = new Set(ownedProjects(id));
          if (action === "join" || action === "own") linked.add(projectId);
          if (action === "leave") {
            linked.delete(projectId);
            owned.delete(projectId);
          }
          if (action === "own") owned.add(projectId);
          if (action === "release") owned.delete(projectId);
          const releasing =
            (action === "leave" || action === "release") && currentOwner?.botId === id;
          const changed =
            releasing ||
            JSON.stringify([...linked]) !== JSON.stringify(bot.linkedProjectIds) ||
            JSON.stringify([...owned].sort()) !== JSON.stringify(ownedProjects(id).sort());
          if (!changed) return { bot, changed: false };
          return {
            bot: saveWithProjects(
              { ...bot, linkedProjectIds: [...linked], updatedAt: nextTimestamp(bot.updatedAt) },
              [...owned],
            ),
            changed: true,
          };
        })
        .immediate();
    },
    mutateWithProjects(
      id: string,
      update: (current: BotMetadata) => BotMetadata,
      desiredOwners?: string[],
    ): BotMetadata {
      return db
        .transaction(() => {
          const current = get(id);
          if (!current) throw new Error("Bot no longer exists");
          return saveWithProjects(update(current), desiredOwners);
        })
        .immediate();
    },
    adoptInherited(
      threadId: string,
      botId: string,
      projectId: string | null,
      placeFirst = false,
      appendAfter?: string[],
      placeBefore?: string,
    ) {
      return db
        .transaction(() => {
          const existing = owner(threadId);
          if (existing) return { botId: existing, changed: false, joined: false };
          const bot = get(botId);
          if (!bot) throw new Error("Bot no longer exists");
          const joined = projectId !== null && !bot.linkedProjectIds.includes(projectId);
          const order = (bot.threadOrder ?? []).filter((id) => id !== threadId);
          const beforeIndex = placeBefore ? order.indexOf(placeBefore) : -1;
          if (joined || placeFirst || appendAfter || beforeIndex >= 0)
            saveWithProjects({
              ...bot,
              linkedProjectIds: joined
                ? [...bot.linkedProjectIds, projectId!]
                : bot.linkedProjectIds,
              ...(placeFirst
                ? {
                    threadOrder: [
                      threadId,
                      ...(bot.threadOrder ?? []).filter((id) => id !== threadId),
                    ],
                  }
                : {}),
              ...(beforeIndex >= 0
                ? {
                    threadOrder: [
                      ...order.slice(0, beforeIndex),
                      threadId,
                      ...order.slice(beforeIndex),
                    ],
                  }
                : {}),
              ...(appendAfter
                ? {
                    threadOrder: [
                      ...new Set(
                        [...(bot.threadOrder ?? []), ...appendAfter].filter(
                          (id) => id !== threadId,
                        ),
                      ),
                      threadId,
                    ],
                  }
                : {}),
              updatedAt: nextTimestamp(bot.updatedAt),
            });
          bind(threadId, botId);
          return { botId, changed: true, joined };
        })
        .immediate();
    },
    bindProjectDefault(threadId: string, projectId: string, createdAt: number): string | null {
      return db
        .transaction(() => {
          if (owner(threadId)) return owner(threadId);
          const project = projectOwner(projectId);
          // Treat the claim's entire millisecond conservatively: a pre-existing
          // pending thread can share its timestamp with the ownership change.
          if (!project || createdAt <= project.assignedAt) return null;
          bind(threadId, project.botId);
          return project.botId;
        })
        .immediate();
    },
    databasePath: db.name,
    legacySource(id: string): LegacyBotStateSource | null {
      const stored = state<LegacyBotStateSource>(`legacy-state:${id}`);
      if (stored) return stored;
      const row = raw(id);
      if (!row) return null;
      const legacy = legacySchema.safeParse(storedRow(row.data));
      return legacy.success
        ? {
            hostId: legacy.data.hostId,
            path: legacy.data.homePath,
            homeProjectId: legacy.data.homeProjectId,
          }
        : null;
    },
    mutate(id: string, update: (current: BotMetadata) => BotMetadata): BotMetadata {
      return db
        .transaction(() => {
          const current = get(id);
          if (!current) throw new Error("Bot no longer exists");
          return save(update(current));
        })
        .immediate();
    },
    /**
     * Forgets the bot: its row and everything keyed by it. Its conversations stay
     * in bb, unassigned. Deleting a bot that is already gone changes nothing.
     */
    remove(id: string) {
      db.transaction(() => {
        for (const table of ["bot_threads", "bot_starts", "bot_project_owners", "bot_routines"])
          db.prepare(`DELETE FROM ${table} WHERE bot_id = ?`).run(id);
        const remove = db.prepare("DELETE FROM bot_state WHERE key = ?");
        for (const prefix of BOT_STATE_KEYS) remove.run(`${prefix}:${id}`);
        db.prepare("DELETE FROM bots WHERE id = ?").run(id);
      }).immediate();
    },
    require(id: string) {
      const bot = get(id);
      if (!bot) throw new Error("Bot no longer exists");
      return bot;
    },
    saveAll(bots: BotMetadata[]) {
      db.transaction(() => {
        bots.forEach(save);
      })();
    },
    bindings(): { threadId: string; botId: string }[] {
      return db
        .prepare(
          "SELECT thread_id AS threadId, bot_id AS botId FROM bot_threads ORDER BY thread_id",
        )
        .all() as { threadId: string; botId: string }[];
    },
    sections(): BotSection[] {
      return (state<unknown[]>("sections") ?? [])
        .map((value) => sectionSchema.parse(value))
        .sort((a, b) => a.order - b.order);
    },
    saveSections(sections: BotSection[]) {
      setState(
        "sections",
        sections.map((value) => sectionSchema.parse(value)),
      );
    },
    stageStart(token: string, botId: string, projectId: string) {
      db.prepare("INSERT INTO bot_starts(token,bot_id,created_at,project_id) VALUES (?,?,?,?)").run(
        token,
        botId,
        Date.now(),
        projectId,
      );
    },
    pendingStartContext(token: string): { botId: string; projectId: string | null } | null {
      return (
        (db
          .prepare(
            "SELECT bot_id AS botId, project_id AS projectId FROM bot_starts WHERE token = ?",
          )
          .get(token) as { botId: string; projectId: string | null } | undefined) ?? null
      );
    },
    pendingStart(token: string): string | null {
      return (
        (
          db.prepare("SELECT bot_id FROM bot_starts WHERE token = ?").get(token) as
            | { bot_id: string }
            | undefined
        )?.bot_id ?? null
      );
    },
    finishStart(token: string, threadId: string) {
      db.transaction(() => {
        const botId = this.pendingStart(token);
        if (!botId) throw new Error("Unknown bot conversation start");
        bind(threadId, botId);
        db.prepare("DELETE FROM bot_starts WHERE token = ?").run(token);
      })();
    },
    cancelStart(token: string) {
      db.prepare("DELETE FROM bot_starts WHERE token = ?").run(token);
    },
  };
}
export interface ProjectOwnership {
  projectId: string;
  botId: string;
  assignedAt: number;
}
export interface LegacyBotStateSource {
  hostId: string;
  path: string;
  homeProjectId: string | null;
}
export type BotStore = ReturnType<typeof createBotStore>;
export function nextTimestamp(previous: number) {
  return Math.max(Date.now(), previous + 1);
}
export const EMPTY_HASHES: BotMetadata["stateHashes"] = {
  "SOUL.md": null,
  "AGENTS.md": null,
  "MEMORY.md": null,
  "settings.json": null,
};
