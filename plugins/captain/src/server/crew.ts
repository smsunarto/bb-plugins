import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CommandDeps } from "./commands/deps.ts";
import { Refusal, type Blocker } from "./output.ts";
import type { Captain } from "./registry.ts";
import { roleOfPreset, type Role } from "./roles.ts";
import { NOTICE, type CrewRole, type CrewRule } from "./store.ts";
import { TasksError, type CrewRow, type TasksTask } from "./tasks-client.ts";

/**
 * A Captain's crew is bb's children of the Captain thread, nothing more. This
 * module reads them once and joins their Tasks rows and Captain's role record,
 * so every command derives from the same shape.
 */

export type ListedThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

export type CrewThread = {
  thread: ListedThread;
  /** Captain's `crew_roles` row, the authoritative role and report-due record. */
  crewRole: CrewRole | null;
  /** The row's role, else the role the attached preset names. */
  role: Role | null;
  /** The thread's task attachments, latest first. */
  rows: CrewRow[];
  /**
   * When a background-check pass first saw the thread idle with background
   * commands running under its current report-due mark; the 30-minute
   * command allowance counts from here.
   */
  commandSeenAt: number | null;
};

const PAGE = 200;

/** Every child of the Captain, live or archived, in pages. */
export async function listChildren(
  bb: Pick<BbPluginApi, "sdk">,
  captainId: string,
  archived: boolean,
  signal?: AbortSignal,
): Promise<ListedThread[]> {
  const threads: ListedThread[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await bb.sdk.threads.list({
      parentThreadId: captainId,
      archived,
      includeHidden: true,
      limit: PAGE,
      offset,
      ...(signal === undefined ? {} : { signal }),
    });
    threads.push(...page);
    if (page.length < PAGE) return threads;
  }
}

/** Join threads with their Tasks rows and role. Threads on no task keep empty `rows`. */
export function joinCrew(
  deps: Pick<CommandDeps, "store">,
  threads: readonly ListedThread[],
  rows: readonly CrewRow[],
): CrewThread[] {
  const byThread = new Map<string, CrewRow[]>();
  for (const row of rows) {
    const list = byThread.get(row.threadId) ?? [];
    list.push(row);
    byThread.set(row.threadId, list);
  }
  return threads.map((thread) => {
    const own = (byThread.get(thread.id) ?? []).sort((a, b) =>
      b.attachedAt.localeCompare(a.attachedAt),
    );
    const crewRole = deps.store.crewRole(thread.id);
    const preset = own[0]?.presetName;
    const due = crewRole?.reportDueSince ?? null;
    return {
      thread,
      crewRole,
      role: crewRole?.role ?? (preset === undefined ? null : roleOfPreset(preset)),
      rows: own,
      commandSeenAt: due === null ? null : deps.store.noticeSeenAt(NOTICE.command(thread.id, due)),
    };
  });
}

/** The Captain's live crew: one `threads.list` walk and one `crewSnapshot`. */
export async function readCrew(
  deps: Pick<CommandDeps, "bb" | "store" | "tasks">,
  captainId: string,
): Promise<CrewThread[]> {
  const threads = await listChildren(deps.bb, captainId, false);
  const rows = await deps.tasks.crewSnapshot(threads.map((thread) => thread.id));
  return joinCrew(deps, threads, rows);
}

/** Tasks' live statuses of a thread still at work on its task. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "working", "idle"]);

/** Live crew threads on a task, optionally with one role, latest attached first. */
export function crewOnTask(
  crew: readonly CrewThread[],
  taskKey: string,
  role?: Role,
): (CrewThread & { row: CrewRow })[] {
  return crew
    .flatMap((member) => {
      const row = member.rows.find((entry) => entry.task.key === taskKey);
      return row === undefined || !LIVE_STATUSES.has(row.liveStatus) ? [] : [{ ...member, row }];
    })
    .filter((member) => role === undefined || member.role === role)
    .sort((a, b) => b.row.attachedAt.localeCompare(a.row.attachedAt));
}

export const TASKS_FIX = "bb plugin list; enable it with bb plugin enable scott-tasks";

/** A Tasks failure as a blocker, for commands that refuse rather than half-act. */
export function tasksBlocker(error: TasksError): Blocker {
  return { reason: error.message, fix: TASKS_FIX };
}

/** Run a Tasks read; a Tasks failure becomes a whole-command refusal. */
export async function tasksOrRefuse<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof TasksError) throw new Refusal([tasksBlocker(error)]);
    throw error;
  }
}

/** A task key's project prefix: keys are `<PREFIX>-<number>` and prefixes hold no dash. */
export function taskPrefix(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
}

/**
 * Resolve a task key the Captain may act on: it exists and lives in one of the
 * Captain's repos' Tasks projects. Keys are case-insensitive.
 */
export async function resolveTask(
  deps: Pick<CommandDeps, "tasks">,
  captain: Captain,
  address: string,
): Promise<{ task: TasksTask } | { blocker: Blocker }> {
  const key = address.trim().toUpperCase();
  const task = await deps.tasks.getTaskByKey(key);
  if (task === null) {
    return { blocker: { reason: `no task ${key}`, fix: "bb tasks list" } };
  }
  const keys = captain.repos.map((repo) => repo.tasksProjectKey);
  if (!keys.includes(taskPrefix(task.key))) {
    return {
      blocker: {
        reason: `${task.key} is not in this Captain's repos (${keys.join(", ")})`,
        fix: `bb captain repo add <project> --tasks ${taskPrefix(task.key)}`,
      },
    };
  }
  return { task };
}

/** The task's owned-field values, read from the task itself, with or without crew. */
export async function taskFields(
  deps: Pick<CommandDeps, "tasks">,
  task: Pick<TasksTask, "id">,
): Promise<Map<string, { value: string; head: string | null }>> {
  const fields = new Map<string, { value: string; head: string | null }>();
  for (const field of await deps.tasks.taskFields(task.id)) {
    fields.set(field.key, { value: field.value, head: field.head });
  }
  return fields;
}

/** Send one message into a thread, steering a running turn or starting one. */
export async function steer(
  bb: Pick<BbPluginApi, "sdk">,
  threadId: string,
  text: string,
): Promise<void> {
  await bb.sdk.threads.send({
    threadId,
    input: [{ type: "text", text, mentions: [] }],
    mode: "steer-if-active",
  });
}

/** A rule as one CREW.md list item; later lines indent under the dash. */
export function ruleLine(text: string): string {
  return `- ${text.replace(/\n/gu, "\n  ")}`;
}

/**
 * Send a crew thread one message topped with every CREW.md rule it has not
 * received: a running session keeps the instructions it started with, so a
 * rule added since reaches it only this way. The rules are marked received
 * only after the send succeeds. `told` is a rule the body itself carries, so
 * the top block leaves it out. Resolves to how many rules the block carried.
 */
export async function steerCrew(
  deps: Pick<CommandDeps, "bb" | "store" | "files">,
  captain: Pick<Captain, "threadId" | "name">,
  threadId: string,
  body: string,
  told?: CrewRule,
): Promise<number> {
  const unseen = deps.store
    .unseenRules(captain.threadId, threadId)
    .filter((rule) => rule.id !== told?.id);
  const text =
    unseen.length === 0
      ? body
      : `${deps.files.read("rules-unseen", {
          captain: JSON.stringify(captain.name),
          rules: unseen.map((rule) => ruleLine(rule.text)).join("\n"),
        })}\n\n---\n\n${body}`;
  await steer(deps.bb, threadId, text);
  // The highest id this send carried, not the newest now: a rule added meanwhile stays unseen.
  deps.store.markRulesSeen(threadId, Math.max(told?.id ?? 0, ...unseen.map((rule) => rule.id)));
  return unseen.length;
}

/** bb statuses of a thread with a turn running or about to run. */
export function isActive(status: string): boolean {
  return (
    status === "active" || status === "starting" || status === "pending" || status === "stopping"
  );
}

type Interaction = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["interactions"]["list"]>
>[number];

/** One pending interaction of a blocked thread, as status and the banner show it. */
export type Pending = { id: string; kind: string; note: string; createdAt: number };

/** Pending interactions of the blocked threads, one call each, in parallel. */
export async function readInteractions(
  deps: Pick<CommandDeps, "bb" | "now">,
  threadIds: readonly string[],
): Promise<Map<string, Pending[]>> {
  const entries = await Promise.all(
    threadIds.map(async (threadId): Promise<[string, Pending[]]> => {
      try {
        const list = await deps.bb.sdk.threads.interactions.list({ threadId });
        return [
          threadId,
          list
            .filter((interaction) => interaction.status === "pending")
            .map((interaction) => ({
              id: interaction.id,
              kind: (interaction.payload as { kind: string }).kind,
              note: describeInteraction(interaction),
              createdAt: interaction.createdAt,
            })),
        ];
      } catch (error) {
        return [
          threadId,
          [
            {
              id: threadId,
              kind: "unknown",
              note: `interactions unreadable: ${(error as Error).message}`,
              createdAt: deps.now(),
            },
          ],
        ];
      }
    }),
  );
  return new Map(entries);
}

/** One short line for a pending interaction, such as `approval: command` or a form's title. */
export function describeInteraction(interaction: Interaction): string {
  const payload = interaction.payload as {
    kind: string;
    title?: unknown;
    subject?: { kind?: unknown };
  };
  if (payload.kind === "approval" && typeof payload.subject?.kind === "string") {
    return `approval: ${payload.subject.kind.replace(/_/gu, " ")}`;
  }
  if (typeof payload.title === "string" && payload.title.trim() !== "") return payload.title.trim();
  return payload.kind.replace(/_/gu, " ");
}
