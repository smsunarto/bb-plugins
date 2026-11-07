import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { BbPluginApi, NewThreadRequest } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { defineCli } from "@get-bb/plugin-sdk";
import { registerBots } from "../server";
import { BOT_MIGRATIONS, createBotStore } from "../lib/bot-store";
import { BOT_COMPLETION_SETTINGS } from "../lib/completion-server";

/** The Bots server as server.ts wires it, without the one-time GTD import. */
async function plugin(bb: BbPluginApi) {
  bb.storage.migrate(bb.storage.database(), BOT_MIGRATIONS);
  const settings = bb.settings.define(BOT_COMPLETION_SETTINGS);
  bb.cli.register(
    defineCli({
      name: "bots",
      summary: "Bots",
      usageErrorExitCode: 2,
      commands: registerBots(bb, settings),
    }),
  );
}
import type { BotMetadata } from "../contract";

type Project = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["get"]>>;
export const PERSONAL_ID = "personal";
/** The execution machine's home directory; bot home projects live under `bb-bots/`. */
export const HOME = "/home/test";
/** Where a projectless bot conversation runs: its home project's checkout. */
export const homeEnvironment = {
  type: "host",
  hostId: "host-home",
  workspace: { type: "unmanaged", path: null },
} as const;
export const avatar = {
  color: "#168b75",
  shape: "round",
  expression: "curious",
  motion: "still",
} as const;
export const hash = (content: string) => createHash("sha256").update(content).digest("hex");
export function project(
  id = "project",
  hostId = "host-project",
  path = `/projects/${id}`,
): Project {
  return {
    id,
    name: `Project ${id}`,
    kind: "standard",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: `source-${id}`,
        projectId: id,
        hostId,
        path,
        type: "local_path",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}
export function request(projectId = "project"): NewThreadRequest {
  return {
    projectId,
    providerId: "pi",
    model: "test",
    reasoningLevel: "high",
    permissionMode: "accept-edits",
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
    },
    environment:
      projectId === PERSONAL_ID
        ? { type: "host", hostId: "host-home", workspace: { type: "personal" } }
        : { type: "project-default" },
    input: [
      {
        type: "text",
        text: "Review @Main",
        mentions: [
          { start: 7, end: 12, resource: { kind: "thread", label: "Main", threadId: "main" } },
        ],
      },
      { type: "localFile", path: "attachments/spec.md", name: "spec.md" },
    ],
  };
}

export async function backend(initialProjects: Project[] = [project()]) {
  const projects = [...initialProjects];
  const personal = { ...project(PERSONAL_ID), kind: "personal" as const, sources: [] };
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const files = new Map<string, string>();
  const homeFolders = new Set<string>();
  const offline = new Set<string>();
  const initialConfigurations: {
    threadId: string;
    instructions: string | null;
    tools: string[];
  }[] = [];
  const key = (hostId: string | undefined, path: string) => `${hostId}:${path}`;
  const put = (hostId: string, path: string, content: string) =>
    files.set(key(hostId, path), content);
  const get = (hostId: string, path: string) => files.get(key(hostId, path));
  let sequence = 0;
  let failSpawn = false;
  const automations = fakeAutomations();
  const sent: { threadId: string; text: string; mode: string }[] = [];
  let host = createFakePluginHost({
    pluginId: "bots",
    agentSkillIds: ["bots"],
    sdk: {
      projects: {
        list: async (args) => (args?.includePersonal ? [...projects, personal] : projects),
        get: async ({ projectId }) => {
          const found = [...projects, personal].find((p) => p.id === projectId);
          if (!found) throw new Error("Project missing");
          return found;
        },
        // Only a bot's home project, in its own folder under ~/bb-bots.
        create: async ({ name, source }) => {
          if (source?.type !== "local_path" || !source.path.startsWith(`${HOME}/bb-bots/`))
            throw new Error("Private bot state must never create backing projects");
          const created = {
            ...project(`home-${projects.length}`, source.hostId, source.path),
            name,
            createdAt: Date.now(),
          };
          projects.push(created);
          return created;
        },
        update: async () => {
          throw new Error("The bot must not rename projects");
        },
      },
      hosts: {
        list: async () => [
          {
            id: "host-home",
            name: "Execution machine",
            status: offline.has("host-home") ? "disconnected" : "connected",
          },
        ],
        // The machine's home and the bot home folders under it; nothing else.
        directory: async ({ path }) => {
          if (path === undefined) return { directory: HOME, parent: "/home", entries: [] };
          if (homeFolders.has(path)) return { directory: path, parent: dirname(path), entries: [] };
          if (path.startsWith(`${HOME}/bb-bots/`)) throw new Error(`ENOENT: no such file ${path}`);
          throw new Error("Bot state must not depend on an execution directory");
        },
      },
      files: {
        mkdir: async ({ path }) => {
          if (!path.startsWith(`${HOME}/bb-bots/`))
            throw new Error("Never create state directories on execution hosts");
          homeFolders.add(path);
          return {} as never;
        },
        read: async ({ hostId, path }) => {
          if (hostId && offline.has(hostId)) throw new Error("Host offline");
          const content = files.get(key(hostId, path));
          if (content === undefined) throw new Error(`ENOENT: ${path}`);
          return {
            content,
            contentEncoding: "utf8",
            sha256: hash(content),
            sizeBytes: Buffer.byteLength(content),
          };
        },
        write: async () => {
          throw new Error("Never write bot state to project/execution-host files");
        },
      },
      plugins: {
        callRpc: async ({ pluginId, method, input, outputSchema }) => {
          if (pluginId !== "automations") throw new Error(`No plugin ${pluginId}`);
          return outputSchema.parse(automations.call(method, input));
        },
      },
      threads: {
        send: async ({ threadId, mode, input }) => {
          const block = input[0];
          sent.push({ threadId, mode, text: block?.type === "text" ? block.text : "" });
          return { delivery: "sent" } as never;
        },
        list: async ({
          projectId,
          parentThreadId,
          archived = false,
          offset = 0,
          limit = 100,
        } = {}) =>
          [...threads.values()]
            .filter(
              (t) =>
                (!projectId || t.projectId === projectId) &&
                (!parentThreadId || t.parentThreadId === parentThreadId) &&
                Boolean(t.archivedAt) === archived,
            )
            .slice(offset, offset + limit),
        get: async ({ threadId }) => {
          const found = threads.get(threadId);
          if (!found) throw new Error("Thread missing");
          return found;
        },
        spawn: async (args) => {
          if (failSpawn) throw new Error("Spawn failed");
          const value = makeThreadResponse({
            id: `thread-${++sequence}`,
            projectId: args.projectId,
            originPluginId: host.bb.pluginId,
            parentThreadId: args.parentThreadId ?? null,
            createdAt: Date.now(),
          });
          threads.set(value.id, value);
          const created = await host.harness.behavior.emitThreadEvent("thread.created", {
            thread: value,
          });
          if (created.errors.length) throw created.errors[0];
          if (!args.sendAt) {
            const blocks = "input" in args ? args.input! : [];
            await host.harness.inspection.registrations.hooks["message.dispatch"]!(
              makeMessageDispatchHookContext({
                thread: value,
                project: { id: args.projectId },
                input: { blocks, text: "" },
                originPluginId: host.bb.pluginId,
                origin: "plugin",
              }),
            );
            const config = await host.harness.behavior.resolveAgentConfiguration(
              makePluginAgentConfigurationContext({
                thread: { id: value.id },
                project: {
                  id: args.projectId,
                  kind: args.projectId === PERSONAL_ID ? "personal" : "standard",
                },
              }),
            );
            initialConfigurations.push({
              threadId: value.id,
              instructions: config.instructions,
              tools: config.tools.map((tool) => tool.name),
            });
          }
          return value;
        },
      },
    },
  });
  await plugin(host.bb);
  let store = createBotStore(host.bb);
  return {
    projects,
    threads,
    automations,
    sent,
    files,
    offline,
    put,
    get,
    initialConfigurations,
    get bb() {
      return host.bb;
    },
    get harness() {
      return host.harness;
    },
    get store() {
      return store;
    },
    stateDirectory(botId: string) {
      return join(dirname(store.databasePath), "state", botId);
    },
    seedLegacy(value: unknown) {
      const parsed = value as { id: string };
      host.bb.storage
        .database()
        .prepare("INSERT OR REPLACE INTO bots(id,data) VALUES (?,?)")
        .run(parsed.id, JSON.stringify(value));
    },
    setFailSpawn(value: boolean) {
      failSpawn = value;
    },
    async reload() {
      host = await host.harness.lifecycle.reload(plugin);
      store = createBotStore(host.bb);
    },
    async create(name = "Atlas", linkedProjectIds = ["project"]) {
      return (await host.harness.behavior.callRpc("bot_create", {
        name,
        role: "Research",
        hostId: "host-home",
        avatar,
        sectionId: null,
        linkedProjectIds,
        soul: `You are ${name}.`,
      })) as BotMetadata;
    },
  };
}

/** An in-memory stand-in for the automations plugin's RPC. */
export function fakeAutomations() {
  type Row = {
    id: string;
    projectId: string;
    name: string;
    enabled: boolean;
    trigger: { triggerType: string; cron: string; timezone: string };
    execution: { env?: Record<string, string>; script?: string };
    createdByThreadId?: string;
    runs: { id: string; status: "succeeded"; trigger: "manual" }[];
  };
  const rows = new Map<string, Row>();
  let next = 0;
  let unavailable = false;
  const status = (row: Row) => ({
    id: row.id,
    enabled: row.enabled,
    nextRunAt: row.enabled ? 1_900_000_000_000 : null,
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    runCount: row.runs.length,
  });
  const find = (input: { projectId: string; automationId: string }) => {
    const row = rows.get(input.automationId);
    if (!row || row.projectId !== input.projectId) throw new Error("Automation not found");
    return row;
  };
  return {
    rows,
    /** Called when a manual run fires the routine, like the stored script would. */
    onRun: null as null | ((row: Row) => Promise<void>),
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    call(method: string, raw: unknown): unknown {
      if (unavailable) throw new Error("Plugin automations is not running");
      const input = raw as Record<string, unknown> & { projectId: string; automationId: string };
      switch (method) {
        case "automations_create": {
          const row = {
            ...(input as unknown as Omit<Row, "id" | "runs">),
            id: `auto-${++next}`,
            runs: [],
          } as Row;
          rows.set(row.id, row);
          return status(row);
        }
        case "automations_update": {
          const row = find(input);
          Object.assign(row, { name: input.name, trigger: input.trigger });
          return status(row);
        }
        case "automations_get":
          return status(find(input));
        case "automations_pause":
          find(input).enabled = false;
          return status(find(input));
        case "automations_resume":
          find(input).enabled = true;
          return status(find(input));
        case "automations_delete":
          find(input);
          rows.delete(input.automationId);
          return { ok: true };
        case "automations_run": {
          const row = find(input);
          const run = {
            id: `run-${row.runs.length + 1}`,
            status: "succeeded" as const,
            trigger: "manual" as const,
          };
          row.runs.push(run);
          return {
            run: {
              ...run,
              error: null,
              skipReason: null,
              output: null,
              startedAt: 1,
              finishedAt: 2,
            },
          };
        }
        case "automations_runs":
          return {
            runs: find(input).runs.map((run) =>
              Object.assign({}, run, {
                error: null,
                skipReason: null,
                output: null,
                startedAt: 1,
                finishedAt: 2,
              }),
            ),
          };
        default:
          throw new Error(`Unknown method ${method}`);
      }
    },
  };
}
