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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
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
  description?: string;
  priority?: string;
  fields: Map<string, { value: string; head: string | null; writtenAt: string }>;
  /** Keys the task had before a move; Tasks still answers them with the new key. */
  formerKeys?: string[];
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
  | "refuse"
  /** A Tasks from before `senderThreadId`: its strict schema refuses input that carries one. */
  | "no-sender";

const ULID = (n: number) => `01J${String(n).padStart(23, "0")}`;

export type FakeOptions = {
  bbProjects?: { id: string; name: string }[];
  tasksProjects?: TasksProject[];
  presets?: Preset[];
  /** Tasks does not answer: every call rejects. */
  tasksDown?: boolean;
  /** Push notifications is not loaded. */
  pushDown?: boolean;
  /** Plugin metadata writes reject, as when bb refuses them. */
  metadataDown?: boolean;
  /** Sending a queued message now rejects. */
  queueSendDown?: boolean;
  /** Plugin metadata writes resolve this late. */
  metadataDelayMs?: number;
  /** Another plugin holds a spawn's first message, as concurrency-limit does at its cap. */
  pluginHold?: boolean;
  /** Captain's Tasks deadline; short, so a hung call fails fast. */
  tasksDeadlineMs?: number;
  /** How often a watched banner rechecks the crew. */
  crewPollMs?: number;
  /** How long one routine maintenance item runs before Captain warns. */
  maintenanceDeadlineMs?: number;
  /** How long a routine fire waits on one bb thread call. */
  threadDeadlineMs?: number;
  /** How often a watched Drive is scanned. */
  driveScanMs?: number;
  /** How often a watched Overview rechecks Tasks. */
  tasksPollMs?: number;
};

/** One provider as bb's `providers.list` reports it, in the fields Captain reads. */
export type FakeProvider = { id: string; available: boolean; permissionModes: string[] };

/** Claude Code and Codex take every permission mode; ACP agents such as Antigravity take no `auto`. */
function defaultProviders(): FakeProvider[] {
  const all = ["accept-edits", "auto", "full"];
  return [
    { id: "claude-code", available: true, permissionModes: all },
    { id: "codex", available: true, permissionModes: all },
    { id: "acp-antigravity", available: true, permissionModes: ["accept-edits", "full"] },
  ];
}

/** The Account Pooler's `status.get` fields Captain reads; null when the pool is not loaded. */
export type FakePool = {
  routing: Record<string, boolean>;
  accounts: {
    provider: string;
    enabled: boolean;
    status: string;
    familyWeekly?: Record<string, { utilization: number; resetAt: number; status: string } | null>;
  }[];
} | null;

/** A queued row as bb lists it, with the fields Captain reads. */
type QueuedRow = {
  id: string;
  text: string;
  state: string;
  content: { type: "text"; text: string; mentions: [] }[];
  waitingOn: { kind: string; pluginId?: string; reason?: string };
};
export const queuedRow = (
  id: string,
  text: string,
  waitingOn: QueuedRow["waitingOn"],
): QueuedRow => ({
  id,
  text,
  state: waitingOn.kind === "time" ? "scheduled" : "queued",
  content: [{ type: "text", text, mentions: [] }],
  waitingOn,
});

export type FakeAutomation = {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  trigger: { triggerType: string; cron?: string; timezone?: string; runAt?: number };
  execution: { mode: string; script?: string; env?: Record<string, string> };
  runs: { id: string; trigger: "schedule" | "manual" }[];
};

/** bb Automations as Captain calls it: create, update, get, pause, resume, run, delete, list. */
export function fakeAutomations(now: () => number = Date.now) {
  const rows = new Map<string, FakeAutomation>();
  let next = 0;
  let runs = 0;
  const state = {
    rows,
    down: false,
    /** Refuse creates with this message. */
    refuseCreate: null as string | null,
    /** Called after a manual run is recorded, as the stored script would run. */
    onRun: null as null | ((row: FakeAutomation, runId: string) => Promise<void> | void),
    calls: [] as { method: string; input: unknown }[],
    /** Methods whose next call fails once. */
    failNext: new Set<string>(),
    /** While set, calls to `methods` (every call when absent) wait for `until`, as a slow Automations would. */
    gate: null as { until: Promise<void>; methods?: ReadonlySet<string> } | null,
    /** Calls started and not yet answered. */
    inFlight: 0,
  };
  const status = (row: FakeAutomation) => ({
    id: row.id,
    enabled: row.enabled,
    nextRunAt: row.enabled ? (row.trigger.runAt ?? 1_900_000_000_000) : null,
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
  });
  const find = (input: Record<string, unknown>) => {
    const row = rows.get(String(input["automationId"]));
    if (row === undefined || row.projectId !== input["projectId"])
      throw new Error("Automation not found");
    return row;
  };
  /** As the real plugin validates every trigger it is given. */
  const checkTrigger = (trigger: unknown) => {
    const runAt = (trigger as { runAt?: number } | undefined)?.runAt;
    if (runAt !== undefined && runAt <= now())
      throw new Error("One-shot run time must be in the future");
  };
  async function call(method: string, input: Record<string, unknown>): Promise<unknown> {
    state.calls.push({ method, input });
    if (state.gate !== null && (state.gate.methods?.has(method) ?? true)) {
      state.inFlight++;
      try {
        await state.gate.until;
      } finally {
        state.inFlight--;
      }
    }
    if (state.down) throw new Error("plugin automations is not running");
    if (state.failNext.has(method)) {
      state.failNext.delete(method);
      throw new Error(`${method} failed once`);
    }
    if (input["trigger"] !== undefined) checkTrigger(input["trigger"]);
    switch (method) {
      case "automations_create": {
        if (state.refuseCreate !== null) throw new Error(state.refuseCreate);
        const row: FakeAutomation = {
          id: `auto_${++next}`,
          projectId: String(input["projectId"]),
          name: String(input["name"]),
          enabled: input["enabled"] !== false,
          trigger: input["trigger"] as FakeAutomation["trigger"],
          execution: input["execution"] as FakeAutomation["execution"],
          runs: [],
        };
        rows.set(row.id, row);
        return status(row);
      }
      case "automations_update": {
        const row = find(input);
        if (input["name"] !== undefined) row.name = String(input["name"]);
        if (input["trigger"] !== undefined)
          row.trigger = input["trigger"] as FakeAutomation["trigger"];
        return status(row);
      }
      case "automations_get":
        return Object.assign(status(find(input)), { execution: find(input).execution });
      case "automations_pause":
        find(input).enabled = false;
        return status(find(input));
      case "automations_resume":
        find(input).enabled = true;
        return status(find(input));
      case "automations_delete":
        find(input);
        rows.delete(String(input["automationId"]));
        return { ok: true };
      case "automations_run": {
        const row = find(input);
        const run = { id: `arun_${++runs}`, trigger: "manual" as const };
        row.runs.push(run);
        // Like the real plugin: the script starts after the run is returned.
        setTimeout(() => void state.onRun?.(row, run.id), 0);
        return { run: { ...run, status: "running", startedAt: 1 } };
      }
      case "automations_list":
        return [...rows.values()]
          .filter((row) => row.projectId === input["projectId"])
          .map((row) => Object.assign(status(row), { execution: row.execution }));
      default:
        throw new Error(`unexpected Automations method ${method}`);
    }
  }
  return Object.assign(state, { call });
}

/**
 * Every host this test file built. After its last test each one is disposed,
 * which removes the SDK harness's storage, and its root is removed, so no
 * temp directory outlives the run.
 */
const built: { root: string; dispose(): Promise<void> }[] = [];
afterAll(async () => {
  for (const { root, dispose } of built.splice(0)) {
    await dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function captainHost(options: FakeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "captain-test-"));
  // Registered before anything can throw; `dispose` is bound once the fake host exists.
  const entry: (typeof built)[number] = { root, dispose: async () => undefined };
  built.push(entry);
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
    /** Methods that fail while listed; `listTasks:<projectId>` fails one project's list. */
    failing: new Set<string>(),
    staleTaskPages: 0,
    /** `createTask` creates the task, then answers only after Captain's deadline. */
    createTaskHangs: false,
  };
  const pushes: { method: string; input: unknown }[] = [];
  /** Messages sent into threads, in order, with the sender exactly as the send passed it. */
  const sent: { threadId: string; text: string; mode: string; senderThreadId?: string }[] = [];
  /** Permission mode per thread, as `threads.defaultExecutionOptions` reports it; `full` when unset. */
  const permissionModes = new Map<string, "accept-edits" | "auto" | "full">();
  /** Threads whose sends fail. */
  const sendFails = new Set<string>();
  const interactions = new Map<string, unknown[]>();
  /** The Account Pooler as `status.get` reports it; no routing by default, so every rung is eligible. */
  const pool: { status: FakePool } = { status: { routing: {}, accounts: [] } };
  /** bb's provider-retry decision per thread; absent reads as no decision. */
  const retryDecisions = new Map<string, unknown>();
  /** Thread events per thread, oldest first, as `threads.events.list` serves them. */
  const events = new Map<string, { type: string; createdAt: number; data: unknown }[]>();
  /** Threads whose archive fails. */
  const archiveFails = new Set<string>();
  const threads = new Map<string, Thread>();
  /** `providers.models` calls, and how many of the next ones fail. */
  const providerModels = { calls: 0, fails: 0 };
  /**
   * bb's providers as `providers.list` serves them per machine: `byHost` when
   * it names the machine, else `value`; null makes the read fail.
   */
  const providerList: {
    value: FakeProvider[] | null;
    byHost: Record<string, FakeProvider[] | null>;
    reads: (string | undefined)[];
  } = { value: defaultProviders(), byHost: {}, reads: [] };
  /** Each bb project's source machines, as `projects.get` serves them; every project lives on the server by default. */
  const projectSources = new Map<string, { hostId: string; isDefault: boolean }[]>();
  /** Machines `hosts.list` reports as connected. */
  const connectedHosts = new Set<string>([SERVER_HOST]);
  /** bb reads that fail while listed: `hosts.list`, `projects.get`. */
  const sdkFailing = new Set<string>();
  /** How many times each of those reads ran. */
  const sdkReads = { hostsList: 0, projectsGet: 0 };
  /** The parent of every `threads.list` read, in order, to count crew polls. */
  const threadLists: (string | undefined)[] = [];
  /** While `gate` is set, Tasks' `crewSnapshot` waits for it. */
  const crewSnapshotHold: {
    gate: Promise<void> | null;
    afterCapture: Promise<void> | null;
  } = { gate: null, afterCapture: null };
  /** Each `interactions.list` call's thread, in order. */
  const interactionReads: string[] = [];
  /** Thread metadata by `<threadId> <pluginId>`, as other plugins read it. */
  const metadata = new Map<string, Record<string, unknown>>();
  /** Messages held by a spawn's `sendAt`, until sent now. */
  const queued = new Map<string, QueuedRow[]>();
  /** Threads with a turn running: a `queue-if-active` send to one is queued. */
  const busy = new Set<string>();
  /** While set, `threads.get` or `threads.send` waits for it, as a slow bb would. */
  const threadHolds: { get: Promise<void> | null; send: Promise<void> | null } = {
    get: null,
    send: null,
  };
  const automations = fakeAutomations(() => clock);
  /** Each send-now, with whether the thread was marked and registered by then. */
  const released: { threadId: string; marked: boolean; registered: boolean }[] = [];
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
      description: task.description,
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
    if (tasks.delegateMode === "no-sender" && "senderThreadId" in input) {
      throw Object.assign(new Error("HTTP 400: rpc input validation failed"), {
        code: "invalid_input",
      });
    }
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
    if (tasks.failing.has(method) || tasks.failing.has(`${method}:${String(input["projectId"])}`)) {
      throw new Error(`${method} is failing`);
    }
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
        // Tasks' presets.name is unique.
        if (tasks.presets.some((entry) => entry.name === input["name"]))
          throw new Error("SqliteError: UNIQUE constraint failed: presets.name");
        const preset = { id: `pr_${++serial}`, ...input } as Preset;
        tasks.presets.push(preset);
        return { preset };
      }
      case "updatePreset": {
        const preset = tasks.presets.find((entry) => entry.id === input["presetId"]);
        if (preset === undefined) throw new Error("preset not found");
        const { presetId: _id, ...patch } = input;
        Object.assign(preset, patch);
        return { preset };
      }
      case "getTask": {
        const task = tasks.tasks.find((entry) => entry.id === input["taskId"]);
        return { task: task === undefined ? null : snapshotTask(task) };
      }
      case "getTaskByKey": {
        const key = String(input["taskKey"]);
        const task =
          tasks.tasks.find((entry) => entry.key === key) ??
          tasks.tasks.find((entry) => entry.formerKeys?.includes(key) === true);
        return { task: task === undefined ? null : snapshotTask(task) };
      }
      case "listTasks": {
        if (input["cursor"] !== undefined && tasks.staleTaskPages > 0) {
          tasks.staleTaskPages -= 1;
          throw Object.assign(
            new Error(
              "HTTP 500: task-list data changed after this cursor was issued; restart pagination without --cursor",
            ),
            { code: "handler_error" },
          );
        }
        const project = tasks.projects.find((entry) => entry.id === input["projectId"]);
        const statuses = input["statuses"] as string[] | undefined;
        const search = input["search"] as string | undefined;
        const matching = tasks.tasks
          .filter((task) => project !== undefined && task.key.startsWith(`${project.prefix}-`))
          .filter((task) => statuses === undefined || statuses.includes(task.status))
          .filter(
            (task) =>
              search === undefined || `${task.title}\n${task.description ?? ""}`.includes(search),
          );
        // The cursor is the next page's offset, as opaque to Captain as Tasks' own.
        const start = Number(input["cursor"] ?? 0);
        const end = start + Number(input["limit"] ?? 100);
        return {
          tasks: matching.slice(start, end).map(snapshotTask),
          nextCursor: end < matching.length ? String(end) : null,
        };
      }
      case "listTaskThreads":
        return {
          taskThreads: tasks.taskThreads
            .filter((row) => row.taskId === input["taskId"])
            .map(({ threadId, liveStatus }) => ({ threadId, liveStatus })),
        };
      case "createTask": {
        const project = tasks.projects.find((entry) => entry.id === input["projectId"]);
        if (project === undefined) return { ok: false, error: { message: "project not found" } };
        const number =
          tasks.tasks.filter((task) => task.key.startsWith(`${project.prefix}-`)).length + 1;
        const task = addTask(`${project.prefix}-${number}`, {
          title: String(input["title"]),
          description: String(input["description"] ?? ""),
          status: (input["status"] as string | undefined) ?? "backlog",
          priority: (input["priority"] as string | undefined) ?? "none",
        });
        if (tasks.createTaskHangs) {
          await new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason as Error));
          });
        }
        return { ok: true, task: snapshotTask(task) };
      }
      case "updateTask": {
        const task = taskById(input["taskId"]);
        if (typeof input["status"] === "string") task.status = input["status"];
        task.updatedAt = iso();
        return { ok: true, task: snapshotTask(task) };
      }
      case "delegate":
        return await delegate(input, signal);
      case "taskFields": {
        const ids = input["taskIds"] as string[];
        return {
          tasks: tasks.tasks
            .filter((task) => ids.includes(task.id))
            .map((task) => ({
              taskId: task.id,
              fields: [...task.fields].map(([key, { value, head, writtenAt }]) => ({
                key,
                value,
                head,
                writtenAt,
              })),
            })),
        };
      }
      case "taskThreadsAttach":
        attach(
          taskById(input["taskId"]).id,
          String(input["threadId"]),
          String(input["presetName"]),
        );
        return { threadId: input["threadId"] };
      case "crewSnapshot": {
        if (crewSnapshotHold.gate !== null) await crewSnapshotHold.gate;
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
        if (crewSnapshotHold.afterCapture !== null) await crewSnapshotHold.afterCapture;
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
    dataDir: root,
    agentSkillIds: manifestSkillIds(),
    sdk: {
      system: { config: async () => ({ primaryHostId: SERVER_HOST }) as never },
      providers: {
        list: async (args) => {
          const hostId = args?.hostId;
          providerList.reads.push(hostId);
          const list =
            hostId !== undefined && Object.hasOwn(providerList.byHost, hostId)
              ? (providerList.byHost[hostId] ?? null)
              : providerList.value;
          if (list === null) throw new Error("provider list unavailable");
          return list.map((provider) => ({
            id: provider.id,
            available: provider.available,
            capabilities: { permissionModes: provider.permissionModes },
          })) as never;
        },
        models: async () => {
          providerModels.calls += 1;
          if (providerModels.fails > 0) {
            providerModels.fails -= 1;
            throw new Error("provider catalog unavailable");
          }
          return {
            models: [{ model: "claude-opus-5-5", displayName: "Claude Opus 5.5" }],
          } as never;
        },
      },
      hosts: {
        list: async () => {
          sdkReads.hostsList += 1;
          if (sdkFailing.has("hosts.list")) throw new Error("hosts.list timed out");
          return [SERVER_HOST, "host_mac"].map((id) => ({
            id,
            status: connectedHosts.has(id) ? "connected" : "disconnected",
          })) as never;
        },
        get: async ({ hostId }) => ({
          ...makeHostResponse({ id: hostId }),
          connectMachineId: null,
          threadStorageRootPath: hostId === SERVER_HOST ? storageRoot : null,
        }),
      },
      projects: {
        list: async () => bbProjects as never,
        get: async ({ projectId }) => {
          sdkReads.projectsGet += 1;
          if (sdkFailing.has("projects.get")) throw new Error("projects.get timed out");
          return {
            id: projectId,
            name: projectId,
            kind: "standard",
            sources: projectSources.get(projectId) ?? [{ hostId: SERVER_HOST, isDefault: true }],
          } as never;
        },
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
          if (args.sendAt !== undefined) {
            const waitingOn: { kind: string; pluginId?: string; reason?: string } =
              options.pluginHold === true
                ? { kind: "plugin", pluginId: "concurrency-limit", reason: "at its cap" }
                : { kind: "time" };
            queued.set(thread.id, [queuedRow(`qm_${++serial}`, args.prompt ?? "", waitingOn)]);
          }
          return thread as never;
        },
        queuedMessages: {
          list: async ({ threadId }) => (queued.get(threadId) ?? []) as never,
          send: async ({ threadId, queuedMessageId }) => {
            if (options.queueSendDown === true) throw new Error("queued message is claimed");
            const rows = queued.get(threadId) ?? [];
            const row = rows.find((entry) => entry.id === queuedMessageId);
            if (row === undefined) throw new Error(`queued message ${queuedMessageId} not found`);
            queued.set(
              threadId,
              rows.filter((entry) => entry !== row),
            );
            released.push({
              threadId,
              marked: metadata.has(`${threadId} genui`),
              registered: server.registry.get(threadId) !== null,
            });
            return { ok: true, delivery: "sent" } as never;
          },
        },
        get: async ({ threadId }) => {
          await threadHolds.get;
          const thread = threads.get(threadId);
          // As bb answers a thread it no longer has: HTTP 404.
          if (thread === undefined)
            throw Object.assign(new Error(`thread ${threadId} not found`), { status: 404 });
          return thread as never;
        },
        send: async (args) => {
          // Held before the write, as a slow bb is: the message lands when released.
          await threadHolds.send;
          if (sendFails.has(args.threadId)) throw new Error(`thread ${args.threadId} is busy`);
          const [part] = args.input;
          const text = part !== undefined && part.type === "text" ? part.text : "";
          sent.push({
            threadId: args.threadId,
            text,
            mode: args.mode,
            senderThreadId: args.senderThreadId,
          });
          if (args.mode === "queue-if-active" && busy.has(args.threadId)) {
            const row = queuedRow(`qm_${++serial}`, text, { kind: "turn" });
            queued.set(args.threadId, [...(queued.get(args.threadId) ?? []), row]);
            return { ok: true, delivery: "queued", queuedMessage: row } as never;
          }
          return { ok: true, delivery: "sent" } as never;
        },
        interactions: {
          list: async ({ threadId }) => {
            interactionReads.push(threadId);
            return (interactions.get(threadId) ?? []) as never;
          },
        },
        defaultExecutionOptions: async ({ threadId }) =>
          ({
            model: "claude-opus-5-5",
            permissionMode: permissionModes.get(threadId) ?? "full",
            reasoningLevel: "high",
            serviceTier: "default",
            source: "client/thread/start",
          }) as never,
        list: async (args = {}) => {
          threadLists.push(args.parentThreadId ?? undefined);
          return [...threads.values()].filter(
            (thread) =>
              (args.parentThreadId === undefined ||
                thread.parentThreadId === args.parentThreadId) &&
              (args.archived === undefined || (thread.archivedAt !== null) === args.archived),
          ) as never;
        },
        update: async ({ threadId, ...patch }) => {
          const thread = threads.get(threadId);
          if (thread === undefined) throw new Error(`thread ${threadId} not found`);
          const next = { ...thread, ...patch } as Thread;
          threads.set(threadId, next);
          return next as never;
        },
        updatePluginMetadata: async ({ threadId, pluginId, set = {} }) => {
          if (options.metadataDown === true) throw new Error("metadata write refused");
          if (options.metadataDelayMs !== undefined)
            await new Promise((resolve) => setTimeout(resolve, options.metadataDelayMs));
          if (!threads.has(threadId))
            throw Object.assign(new Error(`thread ${threadId} not found`), { status: 404 });
          const key = `${threadId} ${pluginId}`;
          const next = { ...metadata.get(key), ...set };
          metadata.set(key, next);
          return next as never;
        },
        events: {
          list: async ({
            threadId,
            types,
            order,
          }: {
            threadId: string;
            types?: readonly string[];
            order?: "asc" | "desc";
          }) => {
            const rows = (events.get(threadId) ?? [])
              .filter((event) => types === undefined || types.includes(event.type))
              .map((event, index) =>
                Object.assign({ id: `evt_${index}`, threadId, seq: index }, event),
              );
            return (order === "desc" ? rows.reverse() : rows) as never;
          },
        } as never,
        archive: async ({ threadId }) => {
          if (archiveFails.has(threadId)) throw new Error(`archive of ${threadId} failed`);
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
          if (args.pluginId === "automations")
            return args.outputSchema.parse(await automations.call(args.method, input));
          if (args.pluginId === "scott-tasks")
            return args.outputSchema.parse(await tasksRpc(args.method, input, args.signal));
          if (args.pluginId === "account-pool") {
            if (pool.status === null) throw new Error("plugin account-pool is not loaded");
            return args.outputSchema.parse({ accepting: true, ...pool.status });
          }
          if (args.pluginId === "provider-retry")
            return args.outputSchema.parse(retryDecisions.get(String(input["threadId"])) ?? null);
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
  /** The host a reload made current, whose `bb.log` the reloaded plugin writes to. */
  let current = host;
  // Bound before startup, so a start that throws still has its fake host disposed.
  entry.dispose = () => current.harness.lifecycle.dispose();
  const startOptions = {
    captainsDir,
    now: () => clock,
    tasksDeadlineMs: options.tasksDeadlineMs ?? 500,
    ...(options.maintenanceDeadlineMs === undefined
      ? {}
      : { maintenanceDeadlineMs: options.maintenanceDeadlineMs }),
    ...(options.threadDeadlineMs === undefined
      ? {}
      : { threadDeadlineMs: options.threadDeadlineMs }),
    crewPollMs: options.crewPollMs ?? 20,
    driveScanMs: options.driveScanMs ?? 40,
    tasksPollMs: options.tasksPollMs ?? 40,
  };
  let server = await start(host.bb, startOptions);
  await server.ready;
  await server.fieldsReady;
  await server.audienceReady;
  await server.ownersReady;

  /**
   * Reload the plugin as `bb plugin reload` does: same data.db, new instance.
   * The CLI harness stays bound to the first instance, so drive the reloaded
   * one through `server`.
   */
  async function reload(duringGap?: () => Promise<void>): Promise<void> {
    if (duringGap !== undefined) {
      // The watcher can unload Captain before it builds and starts the replacement.
      current = await current.harness.lifecycle.reload(() => {});
      await duringGap();
    }
    current = await current.harness.lifecycle.reload(async (bb) => {
      server = await start(bb, startOptions);
      await server.ready;
      await server.audienceReady;
    });
  }
  /** Every `bb.log` line of the current plugin instance. */
  const logs = () => current.harness.inspection.logEntries;
  /** Call an RPC on the current plugin instance, the reloaded one after `reload`. */
  const callRpc = (method: string, input: unknown) =>
    current.harness.behavior.callRpc(method, input);

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
    get server() {
      return server;
    },
    reload,
    tasks,
    pushes,
    sent,
    sendFails,
    permissionModes,
    interactions,
    pool,
    retryDecisions,
    events,
    archiveFails,
    threads,
    threadLists,
    providerModels,
    providerList,
    projectSources,
    connectedHosts,
    sdkFailing,
    sdkReads,
    crewSnapshotHold,
    interactionReads,
    metadata,
    queued,
    busy,
    threadHolds,
    automations,
    /** The Captain's turn ends: its first queued message starts the next turn. */
    drainQueue(threadId: string) {
      const [, ...rest] = queued.get(threadId) ?? [];
      queued.set(threadId, rest);
    },
    released,
    logs,
    callRpc,
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
