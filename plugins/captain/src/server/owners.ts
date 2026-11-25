import { crewTag } from "../contract/rpc.ts";
import { isNotFound } from "./audience.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { readProjectTasks } from "./overview.ts";
import type { Captain } from "./registry.ts";
import type { TaskOwnerSource } from "./store.ts";
import type { TasksTask } from "./tasks-client.ts";

/** An open task as the backfill reads it. */
export type TaskBrief = { id: string; key: string; description: string };

/**
 * Which Captain owns which task. Tasks records no creator, so Captain keeps
 * its own record in `task_owners`: `bb captain create` writes `created`, and
 * `bb captain dispatch` writes `dispatched`. Tasks from before that record are
 * inferred once by `backfillOwners`.
 */

/** Record that the Captain dispatched crew on a task; a task may have several owners. */
export function recordDispatched(
  deps: Pick<CommandDeps, "store" | "now">,
  captain: Pick<Captain, "threadId">,
  task: Pick<TasksTask, "id" | "key">,
): void {
  deps.store.recordTaskOwner({
    captainId: captain.threadId,
    taskId: task.id,
    taskKey: task.key,
    source: "dispatched",
    at: deps.now(),
  });
}

/**
 * Record the Captain as owner of a crew thread's tasks, where a crew role row
 * is written outside dispatch: a child attached by raw `bb tasks dispatch`.
 */
export function recordCrewTasks(
  deps: Pick<CommandDeps, "store" | "now">,
  captainId: string,
  rows: readonly { task: Pick<TasksTask, "id" | "key"> }[],
): void {
  for (const row of rows) recordDispatched(deps, { threadId: captainId }, row.task);
}

/** The first line of a brief, as `captain-brief`'s template writes it. */
const BRIEF_HEADER = /^You are a crew thread for the (.+) Captain\.?$/u;
/**
 * A follow-up's first line names the task it follows: it opens with the key,
 * as "THINGS-1 round-2 review findings …", or says "from (the) <key>", as
 * "Low follow-ups from BBP-41 …".
 */
const FOLLOW_UP = /(?:^|\b[Ff]rom\s+(?:the\s+)?)([A-Z][A-Z0-9]*-\d+)\b/u;

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/** The Captain a brief's header names, lowercased; null without the header. */
export function briefCaptainName(description: string): string | null {
  return BRIEF_HEADER.exec(firstLine(description))?.[1]?.trim().toLowerCase() ?? null;
}

/** The task key a follow-up's first line names; null when it names none. */
export function followUpOf(description: string): string | null {
  return FOLLOW_UP.exec(firstLine(description))?.[1]?.toUpperCase() ?? null;
}

/** Why the backfill gave a task its owner. */
export type OwnerRule = "recorded" | "dispatched" | "brief" | "edited" | "follow-up" | "commented";

/** One comment as the backfill reads it: Tasks' kind, its author, and the thread that wrote it. */
export type CommentAuthor = { kind: string; authorName: string; threadId: string | null };

const AGENT_AUTHOR = /^agent \((thr_[A-Za-z0-9]+)\)$/u;

export type OwnerEvidence = {
  /** Every live Captain, with the names a brief may call it: its registry name and thread title. */
  captains: { id: string; names: string[] }[];
  /** Owners already in `task_owners`. */
  recorded: { captainId: string; taskId: string; taskKey: string }[];
  /** Tasks rows of every thread in `crew_roles`, archived crew included, with its Captain. */
  dispatched: { captainId: string; taskId: string; taskKey: string }[];
  /** The open tasks of the Captains' repos, with descriptions. */
  open: TaskBrief[];
};

export type Assignment = {
  captainId: string;
  taskId: string;
  taskKey: string;
  rule: OwnerRule;
};

/**
 * Owners from the record, the crew and the brief header, the signals that
 * need no extra read. A header names a Captain only when exactly one live
 * Captain answers to that name. Returns the open tasks still without an owner,
 * which `finishOwners` decides from their comments.
 */
export function startOwners(evidence: OwnerEvidence): {
  assignments: Assignment[];
  unowned: TaskBrief[];
} {
  const byName = new Map<string, Set<string>>();
  for (const captain of evidence.captains) {
    for (const name of captain.names) {
      const key = name.trim().toLowerCase();
      if (key === "") continue;
      byName.set(key, (byName.get(key) ?? new Set()).add(captain.id));
    }
  }
  const assignments: Assignment[] = [];
  const add = (assignment: Assignment) => {
    if (
      !assignments.some(
        (each) => each.captainId === assignment.captainId && each.taskId === assignment.taskId,
      )
    )
      assignments.push(assignment);
  };
  for (const row of evidence.recorded) add({ ...row, rule: "recorded" });
  for (const row of evidence.dispatched) add({ ...row, rule: "dispatched" });
  for (const task of evidence.open) {
    const name = briefCaptainName(task.description);
    const named = name === null ? undefined : byName.get(name);
    if (named?.size === 1) {
      add({ captainId: [...named][0] ?? "", taskId: task.id, taskKey: task.key, rule: "brief" });
    }
  }
  const owned = new Set(assignments.map((each) => each.taskId));
  return { assignments, unowned: evidence.open.filter((task) => !owned.has(task.id)) };
}

/**
 * The last signals, for open tasks nothing else placed, strongest first. A
 * Tasks system line written from a Captain's thread, such as "Priority changed
 * to Low by agent (thr_…)", names that Captain: Captains edit the tasks they
 * file. Then a follow-up goes to the owners of the task it follows, whichever
 * rule placed that task. Last, a task a Captain's own thread commented on,
 * such as a decision task its asks point at, goes to that Captain. A comment
 * counts only here, as a last resort, since a Captain may comment on
 * another's task.
 */
export function finishOwners(
  evidence: OwnerEvidence,
  started: ReturnType<typeof startOwners>,
  authorsOf: ReadonlyMap<string, readonly CommentAuthor[]>,
): { assignments: Assignment[]; unowned: TaskBrief[] } {
  const captainIds = new Set(evidence.captains.map((captain) => captain.id));
  const commentsOf = (task: TaskBrief) => authorsOf.get(task.id) ?? [];
  const assignments = [...started.assignments];
  const place = (task: TaskBrief, owners: ReadonlySet<string>, rule: OwnerRule): boolean => {
    for (const captainId of owners) {
      assignments.push({ captainId, taskId: task.id, taskKey: task.key, rule });
    }
    return owners.size > 0;
  };
  const left = started.unowned.filter(
    (task) => !place(task, captainsIn(commentsOf(task), captainIds, editorOf), "edited"),
  );
  const ownersOfKey = new Map<string, Set<string>>();
  const own = (taskKey: string, captainId: string) =>
    ownersOfKey.set(taskKey, (ownersOfKey.get(taskKey) ?? new Set()).add(captainId));
  for (const each of assignments) own(each.taskKey, each.captainId);
  // A follow-up of a follow-up is placed once its parent is: repeat to a fixed point.
  const followUps = (tasks: readonly TaskBrief[]): TaskBrief[] => {
    let pending = [...tasks];
    for (let placed = true; placed;) {
      placed = false;
      pending = pending.filter((task) => {
        const parent = followUpOf(task.description);
        const followed =
          parent === null || parent === task.key ? undefined : ownersOfKey.get(parent);
        if (followed === undefined || !place(task, followed, "follow-up")) return true;
        for (const captainId of followed) own(task.key, captainId);
        placed = true;
        return false;
      });
    }
    return pending;
  };
  const byComment = (task: TaskBrief): boolean => {
    const commenters = captainsIn(commentsOf(task), captainIds, commenterOf);
    for (const captainId of commenters) own(task.key, captainId);
    return place(task, commenters, "commented");
  };
  const unowned = commentTier(followUps(left), byComment, followUps);
  return { assignments, unowned };
}

/**
 * Place tasks by comment, keeping follow-up above comment: a follow-up whose
 * parent is still open and unplaced waits for it, so a parent a comment places
 * passes its owners on before the follow-up's own commenters count. Each round
 * places or settles every task that is not waiting, so the loop ends; only
 * follow-ups that wait on each other in a loop are left, and a comment decides
 * those. Returns the tasks nothing placed.
 */
function commentTier(
  tasks: readonly TaskBrief[],
  byComment: (task: TaskBrief) => boolean,
  followUps: (tasks: readonly TaskBrief[]) => TaskBrief[],
): TaskBrief[] {
  let pending = [...tasks];
  const settled = new Set<string>();
  const waiting = (task: TaskBrief, open: ReadonlySet<string>) => {
    const parent = followUpOf(task.description);
    return parent !== null && parent !== task.key && open.has(parent);
  };
  for (;;) {
    const open = new Set(pending.filter((task) => !settled.has(task.key)).map((task) => task.key));
    const ready = pending.filter((task) => !settled.has(task.key) && !waiting(task, open));
    if (ready.length === 0) break;
    const placed = new Set(ready.filter(byComment).map((task) => task.key));
    for (const task of ready) if (!placed.has(task.key)) settled.add(task.key);
    pending = followUps(pending.filter((task) => !placed.has(task.key)));
  }
  return followUps(pending.filter((task) => settled.has(task.key) || !byComment(task)));
}

/** The Captain whose thread wrote a Tasks system line, such as a priority change. */
const editorOf = (comment: CommentAuthor): string | undefined =>
  comment.kind === "system" ? AGENT_AUTHOR.exec(comment.authorName)?.[1] : undefined;

/** The thread that wrote a comment of any kind. */
const commenterOf = (comment: CommentAuthor): string | undefined =>
  comment.threadId ?? AGENT_AUTHOR.exec(comment.authorName)?.[1];

function captainsIn(
  comments: readonly CommentAuthor[],
  captainIds: ReadonlySet<string>,
  writer: (comment: CommentAuthor) => string | undefined,
): Set<string> {
  return new Set(
    comments.flatMap((comment) => {
      const id = writer(comment);
      return id !== undefined && captainIds.has(id) ? [id] : [];
    }),
  );
}

const SOURCE_OF: Record<OwnerRule, TaskOwnerSource> = {
  recorded: "inferred",
  dispatched: "dispatched",
  brief: "inferred",
  edited: "inferred",
  commented: "inferred",
  "follow-up": "inferred",
};

/** Comment reads in flight at once. */
const COMMENT_READS = 4;
/** A failed backfill is retried after this delay, doubling per failure up to the cap. */
export const BACKFILL_RETRY_MS = 30_000;
const BACKFILL_RETRY_MAX_MS = 10 * 60_000;

export type BackfillDeps = Pick<CommandDeps, "bb" | "store" | "tasks" | "now">;

export type BackfillResult = {
  /** Every project was read and every comment read answered: the backfill is marked done. */
  complete: boolean;
  /** Owners written by this run, by rule. */
  counts: Partial<Record<OwnerRule, number>>;
  /** Open tasks nothing placed. */
  unowned: string[];
  /** Projects whose open tasks could not be read; their tasks wait for the next run. */
  unreadable: string[];
};

/** A Captain title read that has not answered by then fails the run, which is retried. */
export const TITLE_DEADLINE_MS = 10_000;

export type BackfillOptions = { titleDeadlineMs?: number };

/**
 * Infer owners for every live Captain's tasks. Owners placed by crew are
 * written first, before any title read; owners placed by a brief header are
 * written before any comment is read, so a later failure keeps both. Each
 * project is read on its own: an unreadable one leaves the run incomplete, not
 * empty. A failed comment read stops the other readers and rejects. Only a
 * complete run marks the backfill done; every other outcome is retried, and
 * owners already recorded stay as they are.
 */
export async function backfillOwners(
  deps: BackfillDeps,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const captains = deps.store.liveCaptains();
  const at = deps.now();
  const counts: BackfillResult["counts"] = {};
  const written = new Set<string>();
  const record = (assignments: readonly Assignment[]) => {
    for (const each of assignments) {
      const key = `${each.captainId} ${each.taskId}`;
      if (each.rule === "recorded" || written.has(key)) continue;
      written.add(key);
      deps.store.recordTaskOwner({
        captainId: each.captainId,
        taskId: each.taskId,
        taskKey: each.taskKey,
        source: SOURCE_OF[each.rule],
        at,
      });
      counts[each.rule] = (counts[each.rule] ?? 0) + 1;
    }
  };
  const crewOf = new Map<string, string>();
  for (const captain of captains) {
    for (const threadId of deps.store.crewThreadIdsOf(captain.threadId)) {
      crewOf.set(threadId, captain.threadId);
    }
  }
  const rows = await deps.tasks.crewSnapshot([...crewOf.keys()]);
  const dispatched = rows.flatMap((row) => {
    const captainId = crewOf.get(row.threadId);
    return captainId === undefined
      ? []
      : [{ captainId, taskId: row.task.id, taskKey: row.task.key }];
  });
  record(dispatched.map((row) => ({ ...row, rule: "dispatched" as const })));
  const deadlineMs = options.titleDeadlineMs ?? TITLE_DEADLINE_MS;
  const titles = await Promise.all(
    captains.map((captain) => captainTitle(deps, captain.threadId, deadlineMs)),
  );
  const prefixes = new Set(
    captains.flatMap((captain) => captain.repos.map((repo) => repo.tasksProjectKey)),
  );
  const projects = (await deps.tasks.listProjects()).filter((project) =>
    prefixes.has(project.prefix),
  );
  const reads = await Promise.allSettled(
    projects.map((project) => readProjectTasks(deps, project.id)),
  );
  const unreadable = projects.flatMap((project, index) =>
    reads[index]?.status === "fulfilled" ? [] : [project.prefix],
  );
  const evidence: OwnerEvidence = {
    captains: captains.map((captain, index) => ({
      id: captain.threadId,
      names: [captain.name, titles[index] ?? ""],
    })),
    recorded: deps.store.allTaskOwners(),
    dispatched,
    open: reads.flatMap((read) =>
      read.status === "fulfilled"
        ? read.value.tasks.map((task) => ({
            id: task.id,
            key: task.key,
            description: task.description ?? "",
          }))
        : [],
    ),
  };
  const started = startOwners(evidence);
  record(started.assignments);
  const authorsOf = await readAuthors(deps, started.unowned);
  const finished = finishOwners(evidence, started, authorsOf);
  record(finished.assignments.slice(started.assignments.length));
  const result: BackfillResult = {
    complete: unreadable.length === 0,
    counts,
    unowned: finished.unowned.map((task) => task.key),
    unreadable,
  };
  if (result.complete) deps.store.setTaskOwnerBackfilled(at);
  deps.bb.log.info(`task owners backfilled: ${JSON.stringify(result)}`);
  return result;
}

/**
 * A Captain's thread title, which a brief may name it by. A thread bb no longer
 * has gives no title, as title.ts treats it; any other failure, a missed
 * deadline included, rejects so the run is retried.
 */
async function captainTitle(
  deps: Pick<CommandDeps, "bb">,
  threadId: string,
  deadlineMs: number,
): Promise<string> {
  const signal = AbortSignal.timeout(deadlineMs);
  // Raced too, so a read that ignores the signal still cannot hold the run open.
  const late = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () =>
      reject(new Error(`bb did not answer for thread ${threadId} in ${deadlineMs / 1000}s`)),
    );
  });
  late.catch(() => undefined);
  try {
    const thread = await Promise.race([deps.bb.sdk.threads.get({ threadId, signal }), late]);
    return thread.title ?? "";
  } catch (error) {
    if (isNotFound(error)) return "";
    throw error;
  }
}

/** Each task's comments, `COMMENT_READS` at a time; the first failure stops every reader. */
async function readAuthors(
  deps: Pick<CommandDeps, "tasks">,
  tasks: readonly TaskBrief[],
): Promise<Map<string, CommentAuthor[]>> {
  const authorsOf = new Map<string, CommentAuthor[]>();
  const queue = [...tasks];
  let failed = false;
  await Promise.all(
    Array.from({ length: COMMENT_READS }, async () => {
      for (let task = queue.shift(); task !== undefined && !failed; task = queue.shift()) {
        try {
          authorsOf.set(task.id, await deps.tasks.listComments(task.id));
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return authorsOf;
}

/** Where the backfill stands, as the Overview labels it. */
export type OwnersState = "ready" | "pending" | "failed";

/**
 * The backfill, one run at a time, not again once it is marked done. A failed
 * or incomplete run is retried on the next `ensure` after a delay that doubles
 * per failure. Each run ends by refreshing every Captain's tasks read, since
 * it may have written owners even when it failed.
 */
export function createOwnerBackfill(deps: BackfillDeps, options: BackfillOptions = {}) {
  let running: Promise<void> | null = null;
  let failures = 0;
  let retryAt = 0;
  const run = async () => {
    try {
      const result = await backfillOwners(deps, options);
      if (!result.complete) {
        throw new Error(`open tasks unreadable in ${result.unreadable.join(", ")}`);
      }
      failures = 0;
    } catch (error) {
      failures += 1;
      retryAt =
        deps.now() + Math.min(BACKFILL_RETRY_MAX_MS, BACKFILL_RETRY_MS * 2 ** (failures - 1));
      deps.bb.log.warn(`task owner backfill failed: ${(error as Error).message}`);
    } finally {
      running = null;
      const tags = deps.store.liveCaptains().map((captain) => crewTag(captain.threadId));
      if (tags.length > 0) deps.bb.rpc.experimental_invalidate(tags);
    }
  };
  return {
    state(): OwnersState {
      if (deps.store.taskOwnerBackfilled()) return "ready";
      return running !== null || failures === 0 ? "pending" : "failed";
    },
    /** Start a run when one is due; resolves once that run settles, at once while waiting to retry. */
    ensure(): Promise<void> {
      if (deps.store.taskOwnerBackfilled()) return Promise.resolve();
      if (running !== null) return running;
      if (failures > 0 && deps.now() < retryAt) return Promise.resolve();
      running = run();
      return running;
    },
  };
}

export type OwnerBackfill = ReturnType<typeof createOwnerBackfill>;
