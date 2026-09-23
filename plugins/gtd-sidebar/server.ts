// @smsunarto/bb-plugin-gtd-sidebar backend — the snooze store.
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
import { createCollapsedThreadsStore } from "./lib/collapsed-threads.ts";
import { createThreadNester } from "./lib/nest-thread.ts";
import { threadFamilyIds } from "./lib/thread-family.ts";
import { createThreadNamer, subscribeToThreadNaming } from "./thread-namer.ts";
import { createThreadTitleInference } from "./thread-title-inference.ts";
import { RETIRED_PROJECT_MIGRATIONS } from "./lib/retired-project-migrations.ts";

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
  listNamingThreads: {
    input: z.object({}),
    output: z.array(z.string()),
  },
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
  /**
   * bb's `sidebar.collapsedThreads` preference: the families folded in the
   * built-in sidebar, shared with it and kept across reloads. bb republishes
   * `ui-preferences-changed` on every write, which the backend relays on
   * `LIFECYCLE_CHANNEL`.
   */
  listCollapsedThreads: {
    input: z.object({}),
    output: z.object({ threadIds: z.array(z.string()) }),
  },
  toggleCollapsedThread: {
    input: threadIdSchema,
    output: z.object({ threadIds: z.array(z.string()) }),
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
  /**
   * bb's own re-parent, made by dropping one row onto another (nest) or onto
   * a project header (`parentThreadId: null`, back to the top level). The
   * sidebar hears the move through bb's thread feed, so nothing is published
   * here. `reason` names the check a refused drop failed.
   */
  nestThread: {
    input: z.object({
      threadId: z.string().trim().min(1),
      parentThreadId: z.string().trim().min(1).nullable(),
    }),
    output: z.object({ ok: z.boolean(), reason: z.string().optional() }),
  },
});

/** Channel the frontend re-reads on. */
export const LIFECYCLE_CHANNEL = "lifecycle";

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: gtdSidebarHostContract });
  const settings = bb.settings.define({
    localMachineId: {
      type: "string",
      label: "Local machine",
      description: "Machine ID whose threads show no machine globe.",
      default: "",
    },
    groupThreadsByProject: {
      type: "boolean",
      label: "Group threads by project",
      description: "Organize each sidebar shelf into project groups.",
      default: true,
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
      default: false,
    },
    automaticallyNameThreads: {
      type: "boolean",
      label: "Automatically name threads",
      description:
        "Opt in to Codex inference on user prompts. Sends request context and naming rules to generate titles. Manual CLI rename remains available.",
      default: false,
    },
    mobileHaptics: {
      type: "boolean",
      label: "Enable mobile haptics",
      description: "Opt in to tactile feedback on iOS menu taps. Long-press menus work without it.",
      default: false,
    },
    gitButlerBranches: {
      type: "boolean",
      label: "Show GitButler branches",
      description:
        "Opt in to periodic host GitButler CLI reads for primary checkouts. Otherwise use BB's native branch labels.",
      default: false,
    },
  });
  const threadNamer = createThreadNamer(bb, {
    automaticallyNameThreads: async () => (await settings.get()).automaticallyNameThreads,
    inference: createThreadTitleInference(bb, host),
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [...migrations, ...RETIRED_PROJECT_MIGRATIONS]);

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

  const writeSnooze = db.prepare(
    `INSERT INTO thread_lifecycle (thread_id, snoozed_until, snoozed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at`,
  );
  const deleteSnooze = db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`);

  const clear = (threadId: string): void => {
    if (deleteSnooze.run(threadId).changes > 0) {
      bb.realtime.publish(LIFECYCLE_CHANNEL, { kind: "lifecycle", threadId });
    }
  };

  /** One page is already generous; the loop is for the account that isn't. */
  const THREAD_PAGE_SIZE = 200;

  const familyIds = (threadId: string) =>
    threadFamilyIds(
      threadId,
      (parentThreadId, offset) =>
        bb.sdk.threads.list({
          archived: false,
          includeHidden: true,
          parentThreadId,
          limit: THREAD_PAGE_SIZE,
          offset,
        }),
      THREAD_PAGE_SIZE,
    );

  const collapsedThreads = createCollapsedThreadsStore(bb.sdk.system.uiPreferences);
  const threadNester = createThreadNester(bb.sdk.threads);

  bb.rpc.register(gtdSidebarRpcContract, {
    listNamingThreads: threadNamer.listNamingThreads,
    async listCollapsedThreads() {
      return { threadIds: await collapsedThreads.list() };
    },
    async toggleCollapsedThread({ threadId }) {
      return { threadIds: await collapsedThreads.toggle(threadId) };
    },
    async listEnvironmentBranches({ environmentIds }) {
      if (!(await settings.get()).gitButlerBranches) return { environments: [] };
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
    async snooze({ threadId, snoozedUntil }) {
      const ids = await familyIds(threadId);
      const snoozedAt = Date.now();
      db.transaction(() => {
        for (const id of ids) writeSnooze.run(id, snoozedUntil, snoozedAt);
      })();
      bb.realtime.publish(LIFECYCLE_CHANNEL, { kind: "lifecycle", threadId });
      return { ok: true };
    },
    async unsnooze({ threadId }) {
      const ids = await familyIds(threadId);
      db.transaction(() => {
        for (const id of ids) deleteSnooze.run(id);
      })();
      bb.realtime.publish(LIFECYCLE_CHANNEL, { kind: "lifecycle", threadId });
      return { ok: true };
    },
    async nestThread({ threadId, parentThreadId }) {
      const result = await threadNester.nest(threadId, parentThreadId);
      if (!result.ok) {
        bb.log.warn(
          `nest thread ${threadId} under ${parentThreadId ?? "top level"} refused: ${result.reason}`,
        );
        return { ok: false, reason: result.reason };
      }
      return { ok: true };
    },
  });

  // A deleted thread must not leave a row behind that would park a future
  // thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", ({ thread }) => {
    clear(thread.id);
  });

  // A fold made in bb's own sidebar lands here through the same preference;
  // the publish is so every window re-reads it.
  bb.onDispose(
    bb.sdk.subscribe({
      event: "system:changed",
      callback: (event) => {
        if (event.changes.includes("ui-preferences-changed")) {
          bb.realtime.publish(LIFECYCLE_CHANNEL, {
            kind: "collapsed",
            preference: "sidebar.collapsedThreads",
          });
        }
      },
    }),
  );

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
