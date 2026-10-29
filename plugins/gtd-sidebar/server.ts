// @smsunarto/bb-plugin-gtd-sidebar backend — the snooze store.
//
// Snoozes live in the plugin's own SQLite database, never on bb's thread.
// Putting them on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes this database with it.
import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
// Relative, not the `@/` alias the frontend uses: bb loads this file directly
// as a path source, so nothing rewrites tsconfig paths for it.
import { gtdSidebarHostContract } from "./lib/host-contract.ts";
import type { ThreadLifecycleRow } from "./lib/lifecycle.ts";
import { createMachineVisibilityStore } from "./lib/machine-visibility-store.ts";
import { createCollapsedThreadsStore } from "./lib/collapsed-threads.ts";
import { createThreadNester } from "./lib/nest-thread.ts";
import { threadFamilyIds } from "./lib/thread-family.ts";
import { createThreadNamer, subscribeToThreadNaming } from "./thread-namer.ts";
import { createThreadTitleInference } from "./thread-title-inference.ts";
import { RETIRED_PROJECT_MIGRATIONS } from "./lib/retired-project-migrations.ts";
import { GTD_TAGS, gtdSidebarRpcContract } from "./lib/rpc-contract.ts";

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

/** One row of the `readAll` SELECT, whose WHERE makes both times non-null. */
interface LifecycleDbRow {
  thread_id: string;
  snoozed_until: number;
  snoozed_at: number;
}

/** The host's 5 s limit on `but status`, plus the trip to and from the machine. */
const BRANCH_SUMMARY_TIMEOUT_MS = 8_000;
/** How often the backend checks thread-list for folds made in bb's sidebar. */
const FOLD_CHECK_MS = 2_000;
/** The slowest check while thread-list keeps failing. */
const FOLD_CHECK_MAX_MS = 30_000;

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: gtdSidebarHostContract });
  const settings = bb.settings.define({
    localMachineId: {
      type: "string",
      label: "Local machine",
      description: "Machine ID whose threads show no machine globe. Empty uses bb's primary host.",
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

  // The columns stay nullable because migrations are append-only, so the
  // read drops any row an older build left with one time missing.
  const readAll = (): ThreadLifecycleRow[] =>
    (
      db
        .prepare(
          `SELECT thread_id, snoozed_until, snoozed_at FROM thread_lifecycle
             WHERE snoozed_until IS NOT NULL AND snoozed_at IS NOT NULL`,
        )
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
      bb.rpc.experimental_invalidate([GTD_TAGS.lifecycle]);
    }
  };

  // Snooze and wake run one at a time in arrival order. Each reads the family
  // before it writes, so an Undo that follows its snooze could otherwise
  // finish first and leave the thread parked.
  let lifecycleWrites: Promise<unknown> = Promise.resolve();
  const serializeLifecycle = <T>(write: () => Promise<T>): Promise<T> => {
    const result = lifecycleWrites.then(write);
    lifecycleWrites = result.catch(() => {});
    return result;
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

  // Every thread-list call stops when the plugin unloads, so a hung one cannot
  // outlive it.
  const foldsLifetime = new AbortController();
  bb.onDispose(() => foldsLifetime.abort());
  const collapsedThreads = createCollapsedThreadsStore(bb.sdk.plugins, {
    defaults: bb.storage.kv,
    signal: foldsLifetime.signal,
    // Whichever call saw the change, a window's fold or the check below,
    // every window re-reads.
    onChange: () => bb.rpc.experimental_invalidate([GTD_TAGS.collapsed]),
  });
  const threadNester = createThreadNester(bb.sdk.threads);
  const machineVisibility = createMachineVisibilityStore(bb.storage.kv);

  bb.rpc.register(
    gtdSidebarRpcContract,
    {
      listNamingThreads: threadNamer.listNamingThreads,
      listMachineVisibility: async () => ({ hiddenMachineIds: await machineVisibility.read() }),
      changeMachineVisibility: async (change) => ({
        hiddenMachineIds: await machineVisibility.change(change),
      }),
      async listCollapsedThreads({ familyIds }) {
        return { threadIds: await collapsedThreads.list(familyIds) };
      },
      async setThreadCollapsed({ threadId, collapsed }) {
        return { threadIds: await collapsedThreads.set(threadId, collapsed) };
      },
      async listEnvironmentBranches({ environmentIds }) {
        if (!(await settings.get()).gitButlerBranches) return { environments: [] };
        // Environments live on every machine, and the answer waits for the
        // slowest. A disconnected machine is skipped, and a connected one that
        // stalls is cut off just past the host's own 5 s limit on `but`.
        const connected = new Set(
          (await bb.sdk.hosts.list())
            .filter((machine) => machine.status === "connected")
            .map((machine) => machine.id),
        );
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
              if (!connected.has(environment.hostId)) return null;

              const summary = await host.call(
                "branchSummary",
                { cwd: environment.path },
                { hostId: environment.hostId, timeoutMs: BRANCH_SUMMARY_TIMEOUT_MS },
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
      // The contract's `invalidates` refreshes every window's lifecycle read.
      snooze: ({ threadId, snoozedUntil }) =>
        serializeLifecycle(async () => {
          const ids = await familyIds(threadId);
          const snoozedAt = Date.now();
          db.transaction(() => {
            for (const id of ids) writeSnooze.run(id, snoozedUntil, snoozedAt);
          })();
          return { ok: true, rows: readAll() };
        }),
      unsnooze: ({ threadId }) =>
        serializeLifecycle(async () => {
          const ids = await familyIds(threadId);
          db.transaction(() => {
            for (const id of ids) deleteSnooze.run(id);
          })();
          return { ok: true, rows: readAll() };
        }),
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
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Snooze, fold, nest, and label threads for the GTD Sidebar, an action-oriented sidebar that groups threads by who can act next.",
    },
  );

  // A deleted thread must not leave a row behind that would park a future
  // thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", async ({ thread }) => {
    clear(thread.id);
    try {
      await collapsedThreads.remove(thread.id);
    } catch (error) {
      bb.log.warn(`cannot remove deleted thread fold: ${String(error)}`);
    }
  });

  // thread-list publishes its own `preferences` channel. SDK 0.6.75 still
  // subscribes only to the current plugin's signals (`useRealtime` takes no
  // plugin id, and `bb.realtime` only publishes), thread-list's
  // `listPreferences` declares no tags a cross-plugin query could refresh
  // on, and `collapsedThreads` is not one of bb's synced UI preferences. So
  // check on the server rather than adding WAN polling in every window; the
  // store invalidates the fold read when something changed.
  // Checks never overlap. While thread-list cannot answer (turned off, missing,
  // or hung) they back off to 30 s, and only the outage and the recovery log.
  let foldTimer: ReturnType<typeof setTimeout> | undefined;
  let foldCheckDelay = FOLD_CHECK_MS;
  let foldsUnreadable = false;
  const checkFolds = async () => {
    try {
      await collapsedThreads.read();
      if (foldsUnreadable) bb.log.info("thread-list folds are readable again");
      foldsUnreadable = false;
      foldCheckDelay = FOLD_CHECK_MS;
    } catch (error) {
      if (foldsLifetime.signal.aborted) return;
      if (!foldsUnreadable) {
        bb.log.warn(
          `cannot read thread-list folds, checking less often until it answers: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      foldsUnreadable = true;
      foldCheckDelay = Math.min(foldCheckDelay * 2, FOLD_CHECK_MAX_MS);
    }
    if (foldsLifetime.signal.aborted) return;
    foldTimer = setTimeout(() => void checkFolds(), foldCheckDelay);
    foldTimer.unref?.();
  };
  void checkFolds();
  bb.onDispose(() => clearTimeout(foldTimer));

  subscribeToThreadNaming(bb, threadNamer);

  bb.cli.register(
    defineCli({
      name: "gtd-sidebar",
      summary: "Manage GTD Sidebar threads.",
      usageErrorExitCode: 2,
      commands: {
        rename: cliCommand({
          summary: "Generate a new title for a thread.",
          positionals: [
            {
              name: "threadId",
              description: "Thread to rename; defaults to the thread this command runs from.",
            },
          ],
          async run({ positionals }, context) {
            const threadId = positionals.threadId ?? context.threadId;
            if (threadId === undefined) {
              throw new PluginCliError("Pass a thread id or run this command from a thread.", {
                code: "missing_thread",
                exitCode: 2,
              });
            }
            const result = await threadNamer.nameThread(threadId, { kind: "forced" });
            if (!result.ok) throw new PluginCliError(result.error, { code: "rename_failed" });
            return { exitCode: 0, stdout: `${result.title}\n` };
          },
        }),
      },
    }),
  );
}
