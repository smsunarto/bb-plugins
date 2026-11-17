/**
 * A fake bb for Captain's tests: the SDK harness, a real thread-storage
 * directory on disk, and in-memory stand-ins for the Tasks and push RPCs that
 * record what they were sent. Not imported by the server.
 */
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { start } from "./server.ts";

export const SERVER_HOST = "host_server";
export const MAC_HOST = "host_mac";

const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

/** The manifest skill names, read from each SKILL.md's frontmatter as bb reads them. */
export function manifestSkillIds(): string[] {
  return readdirSync(SKILLS_DIR)
    .filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
    .map((entry) => {
      const text = readFileSync(join(SKILLS_DIR, entry, "SKILL.md"), "utf8");
      const name = /^name:\s*(.+)$/mu.exec(text)?.[1]?.trim();
      if (name === undefined) throw new Error(`skills/${entry}/SKILL.md has no name`);
      return name;
    });
}

type TasksProject = { id: string; name: string; prefix: string; linkedBbProjectId: string | null };
type Preset = { id: string; name: string } & Record<string, unknown>;
type Thread = ReturnType<typeof makeThreadResponse>;

export type FakeOptions = {
  bbProjects?: { id: string; name: string }[];
  tasksProjects?: TasksProject[];
  presets?: Preset[];
  /** Tasks does not answer: every call rejects. */
  tasksDown?: boolean;
  /** Push notifications is not loaded. */
  pushDown?: boolean;
};

export async function captainHost(options: FakeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "captain-test-"));
  const storageRoot = join(root, "thread-storage");
  const captainsDir = join(root, "Captains");
  const bbProjects = options.bbProjects ?? [
    { id: "proj_plugins", name: "bb-plugins" },
    { id: "proj_rampage", name: "rampage" },
  ];
  const tasks = {
    projects: [...(options.tasksProjects ?? [])],
    presets: [...(options.presets ?? [])],
    calls: [] as { method: string; input: unknown }[],
  };
  const pushes: unknown[] = [];
  const threads = new Map<string, Thread>();
  let serial = 0;

  function tasksRpc(method: string, input: Record<string, unknown>): unknown {
    tasks.calls.push({ method, input });
    if (options.tasksDown === true) throw new Error("plugin scott-tasks is not loaded");
    switch (method) {
      case "listProjects":
        return { projects: tasks.projects };
      case "createProject": {
        const project = {
          id: `tp_${++serial}`,
          name: String(input["name"]),
          prefix: String(input["prefix"]),
          linkedBbProjectId: (input["linkedBbProjectId"] as string | null) ?? null,
        };
        tasks.projects.push(project);
        return { project };
      }
      case "updateProject": {
        const project = tasks.projects.find((entry) => entry.id === input["projectId"]);
        if (project === undefined) throw new Error("project not found");
        project.linkedBbProjectId = input["linkedBbProjectId"] as string;
        return { project };
      }
      case "listPresets":
        return { presets: tasks.presets };
      case "createPreset": {
        const preset = { id: `pr_${++serial}`, ...input } as Preset;
        tasks.presets.push(preset);
        return { preset };
      }
      default:
        throw new Error(`unexpected Tasks method ${method}`);
    }
  }

  const host = createFakePluginHost({
    pluginId: "captain",
    agentSkillIds: manifestSkillIds(),
    sdk: {
      system: { config: async () => ({ primaryHostId: SERVER_HOST }) as never },
      hosts: {
        get: async ({ hostId }) => ({
          ...makeHostResponse({ id: hostId }),
          connectMachineId: null,
          threadStorageRootPath: hostId === SERVER_HOST ? storageRoot : null,
        }),
      },
      projects: {
        list: async () => bbProjects as never,
        create: async (args) =>
          ({
            id: "proj_captains",
            name: args.name,
            sources: [{ ...args.source, id: "src_1", isDefault: true }],
          }) as never,
      },
      threads: {
        spawn: async (args) => {
          const thread = makeThreadResponse({
            id: `thr_captain${++serial}`,
            projectId: args.projectId,
            title: args.title ?? null,
          });
          threads.set(thread.id, thread);
          return thread as never;
        },
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (thread === undefined) throw new Error(`thread ${threadId} not found`);
          return thread as never;
        },
        list: async (args = {}) =>
          [...threads.values()].filter(
            (thread) =>
              (args.parentThreadId === undefined ||
                thread.parentThreadId === args.parentThreadId) &&
              (args.archived === undefined || (thread.archivedAt !== null) === args.archived),
          ) as never,
        update: async ({ threadId, ...patch }) => {
          const thread = threads.get(threadId);
          if (thread === undefined) throw new Error(`thread ${threadId} not found`);
          const next = { ...thread, ...patch } as Thread;
          threads.set(threadId, next);
          return next as never;
        },
        archive: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (thread !== undefined) threads.set(threadId, { ...thread, archivedAt: 5_000 });
          return { ok: true } as never;
        },
      },
      environments: { get: async () => ({ id: "env_mac", hostId: MAC_HOST }) as never },
      files: {
        read: async ({ path }) =>
          ({ content: readFileSync(path, "utf8"), contentEncoding: "utf8" }) as never,
      },
      plugins: {
        callRpc: async (args: {
          pluginId: string;
          method: string;
          input?: unknown;
          outputSchema: z.ZodType<unknown>;
        }) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          if (args.pluginId === "scott-tasks")
            return args.outputSchema.parse(tasksRpc(args.method, input));
          if (args.pluginId === "push-notifications") {
            if (options.pushDown === true)
              throw new Error("plugin push-notifications is not loaded");
            pushes.push({ method: args.method, input });
            return args.outputSchema.parse({ own: input["level"], ancestorCap: null });
          }
          throw new Error(`unexpected plugin ${args.pluginId}`);
        },
      },
    },
  });
  const server = await start(host.bb, { captainsDir, now: () => 1_000 });
  await server.ready;

  /** Add a thread to the fake bb, such as a crew child of a Captain. */
  function addThread(overrides: Partial<Thread> & { id: string }): Thread {
    const thread = makeThreadResponse(overrides);
    threads.set(thread.id, thread);
    return thread;
  }

  return { ...host, server, tasks, pushes, threads, addThread, storageRoot, captainsDir, root };
}

export type CaptainHost = Awaited<ReturnType<typeof captainHost>>;

/** Run `bb captain new` and return the new Captain's thread id. */
export async function newCaptain(
  host: CaptainHost,
  args: string[] = ["--name", "Plugins", "--repo", "bb-plugins"],
): Promise<string> {
  const result = await host.harness.behavior.runCli(["new", ...args, "--json"]);
  if (result.exitCode !== 0)
    throw new Error(`captain new failed: ${result.stdout}${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { results: { id: string }[] };
  const id = parsed.results[0]?.id;
  if (id === undefined) throw new Error("captain new printed no id");
  return id;
}
