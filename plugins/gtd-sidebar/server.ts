// @smsunarto/bb-plugin-gtd-sidebar backend — the snooze store.
//
// Snoozes live in the plugin's own SQLite database, never on bb's thread.
// Putting them on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes this database with it —
// see `lib/warm-start.ts` for the browser-side copy of the same rows, which is
// the one part it does not take.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
// Relative, not the `@/` alias the frontend uses: bb loads this file directly
// as a path source, so nothing rewrites tsconfig paths for it.
import { GTD_SIDEBAR_AI_SERVICE_ID, gtdSidebarHostContract } from "./lib/host-contract.ts";
import { createThreadNamer } from "./thread-namer.ts";
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
  listProviders: {
    input: z.object({}),
    output: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          logoUrl: z.string().nullable(),
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
  renameThread: {
    input: threadIdSchema,
    output: z.union([
      z.object({ ok: z.literal(true), title: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
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
});

/** Channel the frontend re-reads on. */
export const LIFECYCLE_CHANNEL = "lifecycle";

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: gtdSidebarHostContract });
  bb.experimental_aiServices.register({
    id: GTD_SIDEBAR_AI_SERVICE_ID,
    displayName: "GTD Sidebar Codex",
    kinds: ["inference"],
  });
  const settings = bb.settings.define({
    showProviderIcon: {
      type: "boolean",
      label: "Show the agent icon on each card",
      description:
        "The trailing glyph naming the agent a thread runs on. Turn it off to give the branch that space back.",
      default: true,
    },
    automaticallyNameThreads: {
      type: "boolean",
      label: "Automatically name threads",
      description: "Regenerate the title after every completed user turn.",
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

  // One thread has one lifecycle owner. RPC requests from several windows and
  // bb's thread events can arrive together, so serialize them by id.
  const lifecycleMutationTails = new Map<string, Promise<void>>();
  const serializeLifecycleMutation = <T>(
    threadId: string,
    mutation: () => T | Promise<T>,
  ): Promise<T> => {
    const previous = lifecycleMutationTails.get(threadId) ?? Promise.resolve();
    const result = previous.then(mutation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    lifecycleMutationTails.set(threadId, tail);
    void tail.then(() => {
      if (lifecycleMutationTails.get(threadId) === tail) {
        lifecycleMutationTails.delete(threadId);
      }
      return undefined;
    });
    return result;
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
    // A custom ACP provider already carries its own brand mark, so the sidebar
    // reads it from the host rather than hard-coding a second glyph per agent.
    async listProviders() {
      const providers = await bb.sdk.providers.list();
      return {
        providers: providers.map(({ id, displayName, logoUrl }) => ({
          id,
          displayName,
          logoUrl,
        })),
      };
    },
    async listLifecycle() {
      return { rows: readAll() };
    },
    renameThread({ threadId }) {
      return threadNamer.nameThread(threadId, { kind: "forced" });
    },
    async snooze({ threadId, snoozedUntil }) {
      return serializeLifecycleMutation(threadId, () => {
        write({ threadId, snoozedUntil, snoozedAt: Date.now() });
        return { ok: true };
      });
    },
    async unsnooze({ threadId }) {
      return serializeLifecycleMutation(threadId, () => {
        clear(threadId);
        return { ok: true };
      });
    },
  });

  // A deleted thread must not leave a row behind that would park a future
  // thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", ({ thread }) => {
    clear(thread.id);
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    void threadNamer.nameThread(thread.id, { kind: "automatic", lastAssistantText });
  });

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
