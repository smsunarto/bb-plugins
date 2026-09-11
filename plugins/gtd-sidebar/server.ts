// @smsunarto/bb-plugin-gtd-sidebar backend — the snooze store and the
// Settled shelf's read of bb's archive.
//
// Snoozes live in the plugin's own SQLite database, never on bb's thread.
// Putting them on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes this database with it.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
// Relative, not the `@/` alias the frontend uses: bb loads this file directly
// as a path source, so nothing rewrites tsconfig paths for it.
import { gtdSidebarHostContract } from "./lib/host-contract.ts";
import { isWithinSettledWindow } from "./lib/settled-threads.ts";
import { createThreadNamer, subscribeToThreadNaming } from "./thread-namer.ts";
import { createThreadTitleInference } from "./thread-title-inference.ts";

// Append-only: bb applies these by position, so the retired `settled_at` and
// `archived_thread_ids` columns stay declared and simply go unread.
const migrations = [
  `CREATE TABLE IF NOT EXISTS thread_lifecycle (
     thread_id      TEXT PRIMARY KEY,
     settled_at     INTEGER,
     snoozed_until  INTEGER,
     snoozed_at     INTEGER
   )`,
  `ALTER TABLE thread_lifecycle ADD COLUMN archived_thread_ids TEXT`,
  `DELETE FROM thread_lifecycle WHERE snoozed_until IS NULL`,
];

export interface StoredLifecycleRow {
  threadId: string;
  snoozedUntil: number | null;
  snoozedAt: number | null;
}

interface LifecycleDbRow {
  thread_id: string;
  snoozed_until: number | null;
  snoozed_at: number | null;
}

const threadIdSchema = z.object({ threadId: z.string().trim().min(1) });

export const gtdSidebarRpcContract = defineRpcContract({
  listEnvironmentBranches: {
    input: z.object({ environmentIds: z.array(z.string().trim().min(1)).max(100) }),
    output: z.object({
      environments: z.array(
        z.object({
          environmentId: z.string(),
          label: z.string(),
        }),
      ),
    }),
  },
  listLifecycle: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({
          threadId: z.string(),
          snoozedUntil: z.number().nullable(),
          snoozedAt: z.number().nullable(),
        }),
      ),
    }),
  },
  // The Settled shelf's rows. bb's sidebar view is built from queries pinned
  // to `archived: false`, so an archived thread never reaches the frontend
  // through the host. It comes through here instead, and only for the last
  // day: see `SETTLED_WINDOW_MS`. Fields are deliberately loose (`status`,
  // `originKind` as plain strings) so a new bb value degrades in the mapper
  // rather than failing output validation and blanking the shelf.
  listSettledThreads: {
    input: z.object({}),
    output: z.object({
      threads: z.array(
        z.object({
          id: z.string(),
          settledAt: z.number(),
          projectId: z.string(),
          title: z.string().nullable(),
          titleFallback: z.string().nullable(),
          parentThreadId: z.string().nullable(),
          sectionId: z.string().nullable(),
          originKind: z.string().nullable(),
          originPluginId: z.string().nullable(),
          providerId: z.string(),
          status: z.string(),
          hasPendingInteraction: z.boolean(),
          isPinned: z.boolean(),
          activity: z.object({
            workflows: z.number(),
            backgroundAgents: z.number(),
            backgroundCommands: z.number(),
            planMode: z.number(),
            goals: z.number(),
          }),
          createdAt: z.number(),
          updatedAt: z.number(),
          lastReadAt: z.number().nullable(),
          latestAttentionAt: z.number(),
        }),
      ),
    }),
  },
  snooze: {
    input: z.object({
      threadId: z.string().trim().min(1),
      // Absolute wake time, so a snooze means the same thing on every device.
      snoozedUntil: z.number().int().positive(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  unsnooze: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  /** bb's unarchive. The thread comes back through the host's own view. */
  unsettle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
});

/** Channel the frontend re-reads on. */
export const LIFECYCLE_CHANNEL = "lifecycle";

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: gtdSidebarHostContract });
  const settings = bb.settings.define({
    localMachineId: {
      type: "string",
      label: "Local machine",
      description: "Machine ID whose threads show no machine globe.",
      default: "",
    },
    compactThreads: {
      type: "boolean",
      label: "Compact thread rows",
      description:
        "Show desktop threads on one line. Subthreads and mobile rows always use compact rows.",
      default: false,
    },
    showProviderIcon: {
      type: "boolean",
      label: "Show agent icons",
      description:
        "Show icons on two-line cards. Compact rows use tooltips; mobile rows use the long-press menu.",
      default: true,
    },
    automaticallyNameThreads: {
      type: "boolean",
      label: "Automatically name threads",
      description: "Name new threads and rename only when you start different work.",
      default: true,
    },
  });
  const threadNamer = createThreadNamer(bb, {
    automaticallyNameThreads: async () => (await settings.get()).automaticallyNameThreads,
    inference: createThreadTitleInference(bb),
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const readAll = (): StoredLifecycleRow[] =>
    (
      db
        .prepare(`SELECT thread_id, snoozed_until, snoozed_at FROM thread_lifecycle`)
        .all() as LifecycleDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
    }));

  const write = (row: StoredLifecycleRow): void => {
    db.prepare(
      `INSERT INTO thread_lifecycle (thread_id, snoozed_until, snoozed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at`,
    ).run(row.threadId, row.snoozedUntil, row.snoozedAt);
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId: row.threadId });
  };

  const clear = (threadId: string): void => {
    db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(threadId);
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
  };

  /** One page is already generous; the loop is for the account that isn't. */
  const ARCHIVED_PAGE_SIZE = 200;
  const ARCHIVED_PAGE_LIMIT = 50;

  const listArchivedThreads = async () => {
    const collected = [];
    for (let page = 0; page < ARCHIVED_PAGE_LIMIT; page++) {
      const rows = await bb.sdk.threads.list({
        archived: true,
        limit: ARCHIVED_PAGE_SIZE,
        offset: page * ARCHIVED_PAGE_SIZE,
      });
      collected.push(...rows);
      if (rows.length < ARCHIVED_PAGE_SIZE) break;
    }
    return collected;
  };

  bb.rpc.register(gtdSidebarRpcContract, {
    async listEnvironmentBranches({ environmentIds }) {
      const environments = await Promise.all(
        [...new Set(environmentIds)].map(async (environmentId) => {
          try {
            const environment = await bb.sdk.environments.get({ environmentId });
            // GitButler owns the primary checkout. Linked worktrees keep their
            // real Git branch and must not inherit the primary workspace's
            // virtual branches. `branchName` is not a guard here: bb records it
            // when an environment is created, so it can predate GitButler.
            if (!environment.isGitRepo || environment.isWorktree || environment.path === null) {
              return null;
            }

            const summary = await host.call(
              "branchSummary",
              { cwd: environment.path },
              { hostId: environment.hostId },
            );
            if (summary.label === null) return null;
            return {
              environmentId,
              label: summary.label,
            };
          } catch {
            // The card keeps bb's own branch label when the environment or its
            // host is unavailable. A sidebar enhancement must not blank rows.
            return null;
          }
        }),
      );
      return { environments: environments.filter((environment) => environment !== null) };
    },
    async listLifecycle() {
      return { rows: readAll() };
    },
    /**
     * bb's archived threads from the last day, whoever archived them: the
     * shelf is a view of bb's archive, so a thread archived from bb's own
     * sidebar sits on it too. One archived longer ago keeps its archive and
     * simply stops being drawn.
     *
     * The window is applied here as well as on the frontend. The frontend's is
     * the live one — it re-cuts on its own clock, so a row ages off screen
     * without a refetch — and this one keeps the response proportional to the
     * shelf instead of to the whole archive.
     */
    async listSettledThreads() {
      const now = Date.now();
      const archived = await listArchivedThreads();
      return {
        threads: archived.flatMap((thread) => {
          if (thread.archivedAt === null || !isWithinSettledWindow(thread.archivedAt, now)) {
            return [];
          }
          return [
            {
              id: thread.id,
              settledAt: thread.archivedAt,
              projectId: thread.projectId,
              title: thread.title,
              titleFallback: thread.titleFallback,
              parentThreadId: thread.parentThreadId,
              sectionId: thread.sectionId,
              originKind: thread.originKind,
              originPluginId: thread.originPluginId,
              providerId: thread.providerId,
              status: thread.status,
              hasPendingInteraction: thread.hasPendingInteraction,
              isPinned: thread.pinnedAt !== null,
              activity: {
                workflows: thread.activity.activeWorkflowCount,
                backgroundAgents: thread.activity.activeBackgroundAgentCount,
                backgroundCommands: thread.activity.activeBackgroundCommandCount,
                planMode: thread.activity.activePlanModeCount,
                goals: thread.activity.activeGoalCount,
              },
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              lastReadAt: thread.lastReadAt,
              latestAttentionAt: thread.latestAttentionAt,
            },
          ];
        }),
      };
    },
    async unsettle({ threadId }) {
      try {
        await bb.sdk.threads.unarchive({ threadId });
      } catch (error) {
        // Unarchiving reaches the thread's host, which can be offline. The row
        // stays on the shelf, which is where the thread still is.
        bb.log.warn(`unarchive failed for thread ${threadId}: ${String(error)}`);
        return { ok: false };
      }
      // bb has no unarchive event, so the shelf learns the row is gone here.
      bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
      return { ok: true };
    },
    // Synchronous SQLite writes: two windows racing on one thread still land
    // in order, so nothing here needs serializing.
    snooze({ threadId, snoozedUntil }) {
      write({ threadId, snoozedUntil, snoozedAt: Date.now() });
      return { ok: true };
    },
    unsnooze({ threadId }) {
      clear(threadId);
      return { ok: true };
    },
  });

  // A deleted thread must not leave a row behind that would park a future
  // thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", ({ thread }) => {
    clear(thread.id);
  });

  // Settle is bb's archive, made through the host action on the frontend, so
  // the shelf hears about it from bb's event rather than from an RPC here.
  // Cascade archives fire this once per child, and every publish is cheap.
  bb.events.on("thread.archived", ({ thread }) => {
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId: thread.id });
  });

  subscribeToThreadNaming(bb, threadNamer);

  bb.cli.register({
    name: "gtd-sidebar",
    summary: "Manage GTD Sidebar threads.",
    commands: [
      {
        name: "rename",
        summary: "Generate a new title for a thread.",
        usage: "bb gtd-sidebar rename [<threadId>]",
      },
    ],
    async run(argv, context) {
      const [command, ...args] = argv;
      if (command !== "rename") {
        return {
          exitCode: 2,
          stderr: `Unknown subcommand "${command ?? ""}". Use "bb gtd-sidebar rename [<threadId>]".\n`,
        };
      }

      const threadId = args[0] ?? context.threadId;
      if (threadId === undefined) {
        return {
          exitCode: 2,
          stderr: "Pass a thread id or run this command from a thread.\n",
        };
      }

      const result = await threadNamer.nameThread(threadId, { kind: "forced" });
      return result.ok
        ? { exitCode: 0, stdout: `${result.title}\n` }
        : { exitCode: 1, stderr: `${result.error}\n` };
    },
  });
}
