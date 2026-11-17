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
/** A bb thread row with the list-only fields Captain reads. */
type Thread = ReturnType<typeof makeThreadResponse> & {
  hasPendingInteraction: boolean;
  environmentIsWorktree: boolean | null;
  environmentBranchName: string | null;
  activity: {
    activeBackgroundAgentCount: number;
    activeBackgroundCommandCount: number;
    activePlanModeCount: number;
    activeWorkflowCount: number;
  };
};

export type FakeTask = {
  id: string;
  key: string;
  title: string;
  status: string;
  updatedAt: string;
  fields: Map<string, { value: string; head: string | null; writtenAt: string }>;
};
export type FakeTaskThread = {
  taskId: string;
  threadId: string;
  presetName: string;
  liveStatus: string;
  attachedAt: string;
  updatedAt: string;
};
export type FakeComment = {
  id: string;
  taskId: string;
  body: string;
  authorName: string;
  source: string | undefined;
  threadId: string | undefined;
  /** Posted with `--notify-parent`: the crew report. */
  notifyParent: boolean;
  delivery: { state: string; reason?: string };
  createdAt: string;
};
/** How the fake Tasks answers `delegate`. */
export type DelegateMode =
  | "ok"
  /** Spawns and attaches, then never answers. */
  | "hang"
  /** Spawns, never attaches, never answers. */
  | "hang-unattached"
  | "refuse";

const ULID = (n: number) => `01J${String(n).padStart(23, "0")}`;

export type FakeOptions = {
  bbProjects?: { id: string; name: string }[];
  tasksProjects?: TasksProject[];
  presets?: Preset[];
  /** Tasks does not answer: every call rejects. */
  tasksDown?: boolean;
  /** Push notifications is not loaded. */
  pushDown?: boolean;
  /** Captain's Tasks deadline; short, so a hung call fails fast. */
  tasksDeadlineMs?: number;
};

export async function captainHost(options: FakeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "captain-test-"));
  const storageRoot = join(root, "thread-storage");
  const captainsDir = join(root, "Captains");
  const bbProjects = options.bbProjects ?? [
    { id: "proj_plugins", name: "bb-plugins" },
    { id: "proj_rampage", name: "rampage" },
  ];
  let clock = 1_000;
  const iso = () => new Date(clock).toISOString();
  const tasks = {
    projects: [...(options.tasksProjects ?? [])],
    presets: [...(options.presets ?? [])],
    calls: [] as { method: string; input: unknown }[],
    tasks: [] as FakeTask[],
    taskThreads: [] as FakeTaskThread[],
    comments: [] as FakeComment[],
    fieldDefinitions: new Map<string, string[]>(),
    delegateMode: "ok" as DelegateMode,
    /** Runs after the spawn, before Tasks answers: where bb builds the first session. */
    onSpawn: undefined as ((threadId: string) => Promise<void> | void) | undefined,
    down: options.tasksDown === true,
  };
  const pushes: { method: string; input: unknown }[] = [];
  /** Messages sent into threads, in order. */
  const sent: { threadId: string; text: string; mode: string }[] = [];
  /** Threads whose sends fail. */
  const sendFails = new Set<string>();
  const interactions = new Map<string, unknown[]>();
  const threads = new Map<string, Thread>();
  let serial = 0;

  function withListFields(
    thread: ReturnType<typeof makeThreadResponse>,
    extra: Partial<Thread> = {},
  ): Thread {
    return {
      hasPendingInteraction: false,
      environmentIsWorktree: null,
      environmentBranchName: null,
      activity: {
        activeBackgroundAgentCount: 0,
        activeBackgroundCommandCount: 0,
        activePlanModeCount: 0,
        activeWorkflowCount: 0,
      },
      ...thread,
      ...extra,
    } as Thread;
  }

  function taskById(id: unknown): FakeTask {
    const task = tasks.tasks.find((entry) => entry.id === id);
    if (task === undefined) throw new Error(`Task not found: ${String(id)}`);
    return task;
  }

  function attach(taskId: string, threadId: string, presetName: string): void {
    const existing = tasks.taskThreads.find(
      (row) => row.taskId === taskId && row.threadId === threadId,
    );
    if (existing !== undefined) {
      existing.presetName = presetName;
      existing.updatedAt = iso();
      return;
    }
    tasks.taskThreads.push({
      taskId,
      threadId,
      presetName,
      liveStatus: "starting",
      attachedAt: iso(),
      updatedAt: iso(),
    });
  }

  function snapshotTask(task: FakeTask) {
    return {
      id: task.id,
      key: task.key,
      title: task.title,
      status: task.status,
      statusChangedAt: task.updatedAt,
      updatedAt: task.updatedAt,
    };
  }

  async function delegate(input: Record<string, unknown>, signal: AbortSignal | undefined) {
    const task = taskById(input["taskId"]);
    const preset = tasks.presets.find((entry) => entry.id === input["presetId"]);
    if (preset === undefined) throw new Error("preset not found");
    if (tasks.delegateMode === "refuse") throw new Error("spawn refused: model not available");
    const number = ++serial;
    const thread = withListFields(
      makeThreadResponse({
        id: `thr_crew${number}`,
        projectId: "proj_plugins",
        title: `${task.key} · ${task.title}`,
        status: "starting",
        parentThreadId: (input["parentThreadId"] as string | undefined) ?? null,
        parentNotifications:
          (input["parentNotifications"] as Thread["parentNotifications"] | undefined) ?? "auto",
        createdAt: clock,
        updatedAt: clock,
      }),
      {
        environmentIsWorktree: preset["environmentKind"] === "new-worktree",
        environmentBranchName:
          preset["environmentKind"] === "new-worktree"
            ? `crew/${task.key.toLowerCase()}-${number}`
            : "main",
      },
    );
    threads.set(thread.id, thread);
    await tasks.onSpawn?.(thread.id);
    if (tasks.delegateMode !== "hang-unattached") {
      attach(task.id, thread.id, preset.name);
      if (task.status === "backlog" || task.status === "todo") task.status = "in_progress";
    }
    if (tasks.delegateMode === "hang" || tasks.delegateMode === "hang-unattached") {
      await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason as Error));
      });
    }
    return { threadId: thread.id };
  }

  async function tasksRpc(
    method: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    tasks.calls.push({ method, input });
    if (tasks.down) throw new Error("plugin scott-tasks is not loaded");
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
      case "getTaskByKey": {
        const task = tasks.tasks.find((entry) => entry.key === input["taskKey"]);
        return { task: task === undefined ? null : snapshotTask(task) };
      }
      case "updateTask": {
        const task = taskById(input["taskId"]);
        if (typeof input["status"] === "string") task.status = input["status"];
        task.updatedAt = iso();
        return { ok: true, task: snapshotTask(task) };
      }
      case "delegate":
        return await delegate(input, signal);
      case "taskThreadsAttach":
        attach(
          taskById(input["taskId"]).id,
          String(input["threadId"]),
          String(input["presetName"]),
        );
        return { threadId: input["threadId"] };
      case "crewSnapshot": {
        const ids = new Set(input["threadIds"] as string[]);
        const rows = tasks.taskThreads
          .filter((row) => ids.has(row.threadId))
          .map((row) => {
            const task = taskById(row.taskId);
            const report = tasks.comments.findLast(
              (comment) => comment.notifyParent && comment.threadId === row.threadId,
            );
            return {
              threadId: row.threadId,
              presetName: row.presetName,
              liveStatus: row.liveStatus,
              liveStatusChangedAt: row.updatedAt,
              attachedAt: row.attachedAt,
              updatedAt: row.updatedAt,
              task: snapshotTask(task),
              parentTask: null,
              fields: [...task.fields].map(([key, { value, head, writtenAt }]) => ({
                key,
                value,
                head,
                writtenAt,
              })),
              lastNotifyingComment:
                report === undefined
                  ? null
                  : { id: report.id, createdAt: report.createdAt, delivery: report.delivery },
            };
          });
        return { rows };
      }
      case "defineField":
        tasks.fieldDefinitions.set(String(input["key"]), input["values"] as string[]);
        return { field: { key: input["key"] } };
      case "setField": {
        const task = taskById(input["taskId"]);
        const key = String(input["key"]);
        const values = tasks.fieldDefinitions.get(key);
        if (values === undefined) throw new Error(`field_not_found: ${key}`);
        if (!values.includes(String(input["value"]))) throw new Error("field_value_not_allowed");
        const field = {
          value: String(input["value"]),
          head: (input["head"] as string | null) ?? null,
          writtenAt: iso(),
        };
        task.fields.set(key, field);
        task.updatedAt = iso();
        return { field: { key, ...field }, taskUpdatedAt: task.updatedAt };
      }
      case "createComment": {
        const comment: FakeComment = {
          id: ULID(++serial),
          taskId: taskById(input["taskId"]).id,
          body: String(input["body"]),
          authorName: (input["author"] as string | undefined) ?? "You",
          source: input["source"] as string | undefined,
          threadId: input["threadId"] as string | undefined,
          notifyParent: false,
          delivery: { state: "delivered" },
          createdAt: iso(),
        };
        tasks.comments.push(comment);
        return { comment: { id: comment.id } };
      }
      case "listComments":
        return {
          comments: tasks.comments.filter((comment) => comment.taskId === input["taskId"]),
        };
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
          const thread = withListFields(
            makeThreadResponse({
              id: `thr_captain${++serial}`,
              projectId: args.projectId,
              title: args.title ?? null,
            }),
          );
          threads.set(thread.id, thread);
          return thread as never;
        },
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (thread === undefined) throw new Error(`thread ${threadId} not found`);
          return thread as never;
        },
        send: async (args) => {
          if (sendFails.has(args.threadId)) throw new Error(`thread ${args.threadId} is busy`);
          const [part] = args.input;
          sent.push({
            threadId: args.threadId,
            text: part !== undefined && part.type === "text" ? part.text : "",
            mode: args.mode,
          });
          return {} as never;
        },
        interactions: {
          list: async ({ threadId }) => (interactions.get(threadId) ?? []) as never,
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
          signal?: AbortSignal;
        }) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          if (args.pluginId === "scott-tasks")
            return args.outputSchema.parse(await tasksRpc(args.method, input, args.signal));
          if (args.pluginId === "push-notifications") {
            if (options.pushDown === true)
              throw new Error("plugin push-notifications is not loaded");
            pushes.push({ method: args.method, input });
            return args.outputSchema.parse(
              args.method === "notifications.send"
                ? { ok: true, channels: ["web"] }
                : { own: input["level"], ancestorCap: null },
            );
          }
          throw new Error(`unexpected plugin ${args.pluginId}`);
        },
      },
    },
  });
  const server = await start(host.bb, {
    captainsDir,
    now: () => clock,
    tasksDeadlineMs: options.tasksDeadlineMs ?? 500,
  });
  await server.ready;
  await server.fieldsReady;

  /** Add a thread to the fake bb, such as a crew child of a Captain. */
  function addThread(overrides: Partial<Thread> & { id: string }): Thread {
    const {
      hasPendingInteraction,
      environmentIsWorktree,
      environmentBranchName,
      activity,
      ...rest
    } = overrides;
    const thread = withListFields(makeThreadResponse(rest), {
      ...(hasPendingInteraction === undefined ? {} : { hasPendingInteraction }),
      ...(environmentIsWorktree === undefined ? {} : { environmentIsWorktree }),
      ...(environmentBranchName === undefined ? {} : { environmentBranchName }),
      ...(activity === undefined ? {} : { activity }),
    });
    threads.set(thread.id, thread);
    return thread;
  }

  /** Patch a thread in the fake bb, such as its status. */
  function updateThread(threadId: string, patch: Partial<Thread>): Thread {
    const thread = threads.get(threadId);
    if (thread === undefined) throw new Error(`no thread ${threadId}`);
    const next = { ...thread, ...patch };
    threads.set(threadId, next);
    return next;
  }

  /** Add a task to the fake Tasks, in a project by its key prefix. */
  function addTask(key: string, overrides: Partial<Omit<FakeTask, "key">> = {}): FakeTask {
    const task: FakeTask = {
      id: ULID(++serial),
      key,
      title: `Task ${key}`,
      status: "todo",
      updatedAt: iso(),
      fields: new Map(),
      ...overrides,
    };
    tasks.tasks.push(task);
    return task;
  }

  /** A crew thread's notifying comment: its report. */
  function report(taskKey: string, threadId: string, body = "Final: done"): FakeComment {
    const task = tasks.tasks.find((entry) => entry.key === taskKey);
    if (task === undefined) throw new Error(`no task ${taskKey}`);
    const comment: FakeComment = {
      id: ULID(++serial),
      taskId: task.id,
      body,
      authorName: "agent",
      source: "agent",
      threadId,
      notifyParent: true,
      delivery: { state: "delivered" },
      createdAt: iso(),
    };
    tasks.comments.push(comment);
    return comment;
  }

  return {
    ...host,
    server,
    tasks,
    pushes,
    sent,
    sendFails,
    interactions,
    threads,
    addThread,
    updateThread,
    addTask,
    attach,
    report,
    now: () => clock,
    setNow(at: number) {
      clock = at;
    },
    storageRoot,
    captainsDir,
    root,
  };
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
