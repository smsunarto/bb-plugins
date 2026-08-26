// @smsunarto/bb-plugin-gtd-sidebar backend — the settled / snoozed store.
//
// This state lives in the plugin's own SQLite database, never on bb's thread.
// Putting it on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes this database with it —
// see `lib/warm-start.ts` for the browser-side copy of the same rows, which is
// the one part it does not take.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
// Relative, not the `@/` alias the frontend uses: bb loads this file directly
// as a path source, so nothing rewrites tsconfig paths for it.
import { parseArchivedThreadIds } from "./lib/lifecycle.ts";
import { isWithinSettledWindow } from "./lib/settled-threads.ts";
import { gitButlerHostContract } from "./lib/gitbutler.ts";
import { createGhRunner, githubGraphql, githubRestJson, resolveGhPath } from "./lib/gh-cli.ts";
import { formatAgentWakeMessage, canonicalPullRequestUrl } from "./lib/pr-watch.ts";
import { pollSnoozedPullRequests, type StoredPrWatch } from "./lib/pr-watch-run.ts";
import {
  parseRestPull,
  parseRestPulls,
  parseRestRateLimit,
  type CachedPullRow,
  type RestPull,
} from "./lib/pr-index.ts";
import { resolveThreadPullRequests } from "./lib/pr-index-run.ts";
import { upsertBrowserTab, type InAppBrowserTab } from "./lib/open-in-app-browser.ts";

const migrations = [
  `CREATE TABLE IF NOT EXISTS thread_lifecycle (
     thread_id      TEXT PRIMARY KEY,
     settled_at     INTEGER,
     snoozed_until  INTEGER,
     snoozed_at     INTEGER
   )`,
  // bb's archive cascades to child threads and reports every id it took.
  // Without them, un-settling gives the parent back and leaves its children
  // archived for good.
  `ALTER TABLE thread_lifecycle ADD COLUMN archived_thread_ids TEXT`,
  `CREATE TABLE IF NOT EXISTS snoozed_pr_watch (
     thread_id       TEXT PRIMARY KEY,
     pr_url          TEXT NOT NULL,
     snapshot_json   TEXT,
     last_polled_at  INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS thread_pr_index (
     environment_id  TEXT PRIMARY KEY,
     owner           TEXT,
     repo            TEXT,
     number          INTEGER,
     title           TEXT,
     url             TEXT,
     state           TEXT,
     attention       TEXT,
     fetched_at      INTEGER NOT NULL
   )`,
];
const PR_WATCH_RATE_LIMIT_KEY = "pr-watch:rate-limit";

export interface StoredLifecycleRow {
  threadId: string;
  settledAt: number | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
  /** Every id the settle's archive took, this thread's own included. */
  archivedThreadIds: string[];
}

interface LifecycleDbRow {
  thread_id: string;
  settled_at: number | null;
  snoozed_until: number | null;
  snoozed_at: number | null;
  archived_thread_ids: string | null;
}

const threadIdSchema = z.object({ threadId: z.string().trim().min(1) });

function asPersistedBrowserTab(
  candidate: {
    environmentId?: unknown;
    id: string;
    kind: string;
    title?: unknown;
    url?: string;
  },
  fallback: InAppBrowserTab,
): InAppBrowserTab {
  if (candidate.kind !== "browser" || typeof candidate.url !== "string") return fallback;
  const title = candidate.title;
  const environmentId = candidate.environmentId;
  return {
    environmentId:
      typeof environmentId === "string" || environmentId === null
        ? environmentId
        : fallback.environmentId,
    id: candidate.id,
    kind: "browser",
    title: typeof title === "string" && title.length > 0 ? title : fallback.title,
    url: candidate.url,
  };
}

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
          settledAt: z.number().nullable(),
          snoozedUntil: z.number().nullable(),
          snoozedAt: z.number().nullable(),
        }),
      ),
    }),
  },
  // The settled shelf's own rows. bb's sidebar view is built from queries
  // pinned to `archived: false`, so a settled — and therefore archived —
  // thread never reaches the frontend through the host. It comes through here
  // instead, and only for the last day: see `SETTLED_WINDOW_MS`. Fields are
  // deliberately loose (`status`, `originKind` as plain strings) so a new bb
  // value degrades in the mapper rather than failing output validation and
  // blanking the shelf.
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
  settle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  unsettle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  snooze: {
    input: z.object({
      threadId: z.string().trim().min(1),
      // Absolute wake time, so a snooze means the same thing on every device.
      snoozedUntil: z.number().int().positive(),
      // Optional. The hourly GitHub watch uses it so the first poll does not
      // have to call `gh pr view` for a thread the card already identified.
      pullRequestUrl: z.string().url().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  unsnooze: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  listThreadPullRequests: {
    input: z
      .object({
        threads: z
          .array(
            z
              .object({
                threadId: z.string().trim().min(1),
                environmentId: z.string().trim().min(1).nullable(),
                branchName: z.string().nullable(),
                title: z.string(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
    output: z.object({
      pullRequests: z.array(
        z.object({
          threadId: z.string(),
          number: z.number().int().positive(),
          title: z.string(),
          url: z.string(),
          state: z.string(),
          attention: z.string(),
          source: z.enum(["rest", "cache", "title"]),
        }),
      ),
    }),
  },
  logPrDebug: {
    input: z
      .object({
        threadId: z.string().trim().min(1),
        environmentId: z.string().nullable(),
        isLoading: z.boolean(),
        hasPullRequest: z.boolean(),
        number: z.number().int().positive().nullable(),
        state: z.string().nullable(),
        attention: z.string().nullable(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  // Persist a browser tab on the thread so the host's panel reconcile does
  // not wipe the localStorage reveal the card writes on click.
  openThreadBrowserTab: {
    input: z
      .object({
        threadId: z.string().trim().min(1),
        tab: z
          .object({
            environmentId: z.string().min(1).nullable(),
            id: z.string().min(1),
            kind: z.literal("browser"),
            title: z.string().min(1).nullable(),
            url: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    output: z
      .object({
        tab: z
          .object({
            environmentId: z.string().min(1).nullable(),
            id: z.string().min(1),
            kind: z.literal("browser"),
            title: z.string().min(1).nullable(),
            url: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
  },
});

/** Channel the frontend re-reads on. */
export const LIFECYCLE_CHANNEL = "lifecycle";

export default function plugin(bb: BbPluginApi) {
  const gitButlerHost = bb.hosts.experimental_client({ contract: gitButlerHostContract });
  // Declared, never read here. The card is the only consumer and it reads the
  // value through `useSettings()`, so this exists to put the toggle in the
  // plugin's settings form and give it its default.
  bb.settings.define({
    showProviderIcon: {
      type: "boolean",
      label: "Show the agent icon on each card",
      description:
        "The trailing glyph naming the agent a thread runs on. Turn it off to give the branch that space back.",
      default: true,
    },
    debugPullRequests: {
      type: "boolean",
      label: "Debug GitHub PR badges",
      description:
        "Show the lookup source (rest, cache, title) next to each PR number. Off unless you are diagnosing a missing badge.",
      default: false,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const shutdown = new AbortController();
  bb.onDispose(() => shutdown.abort());
  let resolvedGhPath: string | null | undefined;
  const restPullsInFlight = new Map<string, Promise<ReturnType<typeof parseRestPulls>>>();
  const restPullGetInFlight = new Map<string, Promise<RestPull | null>>();

  const readAll = (): StoredLifecycleRow[] =>
    (
      db
        .prepare(
          `SELECT thread_id, settled_at, snoozed_until, snoozed_at,
                  archived_thread_ids
             FROM thread_lifecycle`,
        )
        .all() as LifecycleDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      settledAt: row.settled_at,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
      archivedThreadIds: parseArchivedThreadIds(row.archived_thread_ids),
    }));

  const readOne = (threadId: string): StoredLifecycleRow | undefined => {
    const row = db
      .prepare(
        `SELECT thread_id, settled_at, snoozed_until, snoozed_at,
                archived_thread_ids
           FROM thread_lifecycle
          WHERE thread_id = ?`,
      )
      .get(threadId) as LifecycleDbRow | undefined;
    if (row === undefined) return undefined;
    return {
      threadId: row.thread_id,
      settledAt: row.settled_at,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
      archivedThreadIds: parseArchivedThreadIds(row.archived_thread_ids),
    };
  };

  const write = (row: StoredLifecycleRow): void => {
    db.prepare(
      `INSERT INTO thread_lifecycle
         (thread_id, settled_at, snoozed_until, snoozed_at, archived_thread_ids)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at,
         archived_thread_ids = excluded.archived_thread_ids`,
    ).run(
      row.threadId,
      row.settledAt,
      row.snoozedUntil,
      row.snoozedAt,
      row.archivedThreadIds.length === 0 ? null : JSON.stringify(row.archivedThreadIds),
    );
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId: row.threadId });
  };

  const clear = (threadId: string): void => {
    db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(threadId);
    db.prepare(`DELETE FROM snoozed_pr_watch WHERE thread_id = ?`).run(threadId);
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
  };

  const rememberPullRequestUrl = (threadId: string, url: string | undefined): void => {
    const canonical = url === undefined ? null : canonicalPullRequestUrl(url);
    if (canonical === null) return;
    db.prepare(
      `INSERT INTO snoozed_pr_watch (thread_id, pr_url, snapshot_json, last_polled_at)
       VALUES (?, ?, NULL, 0)
       ON CONFLICT(thread_id) DO UPDATE SET
         snapshot_json = CASE
           WHEN snoozed_pr_watch.pr_url = excluded.pr_url THEN snoozed_pr_watch.snapshot_json
           ELSE NULL
         END,
         pr_url = excluded.pr_url`,
    ).run(threadId, canonical);
  };

  /**
   * bb's own archive, kept in step with the settled shelf.
   *
   * "Settled" and "archived" are the same statement — this work is done — so
   * saying it in one place and not the other leaves the built-in sidebar, the
   * archived filter, and worktree reuse disagreeing with the shelf.
   *
   * Returns every id bb took, which for a thread with children is more than
   * the one asked for. An empty array means the archive did not happen.
   */
  const archiveThread = async (threadId: string): Promise<string[]> => {
    try {
      const result = await bb.sdk.threads.archive({ threadId });
      const ids = result.archivedThreadIds ?? [];
      return ids.includes(threadId) ? ids : [...ids, threadId];
    } catch (error) {
      // Archiving reaches the thread's host, which can be offline. The flag is
      // read — `visibleInboxThreads` drops an archived thread — but the row
      // outranks it, so a failure here costs the archive and nothing else: the
      // flag stays false, the row still shelves the thread, and it sits where
      // the user put it.
      bb.log.warn(`archive failed for thread ${threadId}: ${String(error)}`);
      return [];
    }
  };

  /** The mirror: every id the settle took, given back one by one. */
  const unarchiveThreads = async (threadIds: readonly string[]) => {
    for (const threadId of threadIds) {
      try {
        await bb.sdk.threads.unarchive({ threadId });
      } catch (error) {
        // One child that cannot be reached must not strand the rest, and the
        // parent is the id that matters most — it is the one on the shelf.
        // This direction is not the benign one `archiveThread` describes: the
        // callers clear or rewrite the row whatever happens here, so a parent
        // that stays archived is a thread nothing here still calls settled,
        // and it leaves the sidebar until bb unarchives it.
        bb.log.warn(`unarchive failed for thread ${threadId}: ${String(error)}`);
      }
    }
  };

  /**
   * Every id a settle archived, or the thread's own id when the row predates
   * the cascade column. The fallback is exactly the old behaviour.
   */
  const archivedIdsFor = (threadId: string): string[] => {
    const stored = readOne(threadId)?.archivedThreadIds ?? [];
    return stored.length === 0 ? [threadId] : stored;
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

            const summary = await gitButlerHost.call(
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
    async listThreadPullRequests({ threads }) {
      if (resolvedGhPath === undefined) {
        resolvedGhPath = await resolveGhPath(shutdown.signal);
      }
      const gh = resolvedGhPath === null ? null : createGhRunner(shutdown.signal, resolvedGhPath);
      let restRemaining: number | null = null;
      if (gh !== null) {
        const limit = await githubRestJson(gh, "rate_limit", 8_000);
        restRemaining = parseRestRateLimit(limit.raw)?.restRemaining ?? null;
      }

      const readPrCache = (environmentId: string): CachedPullRow | undefined => {
        const row = db
          .prepare(
            `SELECT environment_id, owner, repo, number, title, url, state, attention, fetched_at
               FROM thread_pr_index
              WHERE environment_id = ?`,
          )
          .get(environmentId) as
          | {
              environment_id: string;
              owner: string | null;
              repo: string | null;
              number: number | null;
              title: string | null;
              url: string | null;
              state: string | null;
              attention: string | null;
              fetched_at: number;
            }
          | undefined;
        if (row === undefined) return undefined;
        return {
          environmentId: row.environment_id,
          owner: row.owner,
          repo: row.repo,
          number: row.number,
          title: row.title,
          url: row.url,
          state: row.state,
          attention: row.attention,
          fetchedAt: row.fetched_at,
        };
      };

      const resolved = await resolveThreadPullRequests(threads, {
        now: Date.now(),
        restRemaining,
        getCache: readPrCache,
        putCache: (row) => {
          db.prepare(
            `INSERT INTO thread_pr_index
               (environment_id, owner, repo, number, title, url, state, attention, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(environment_id) DO UPDATE SET
               owner = excluded.owner,
               repo = excluded.repo,
               number = excluded.number,
               title = excluded.title,
               url = excluded.url,
               state = excluded.state,
               attention = excluded.attention,
               fetched_at = excluded.fetched_at`,
          ).run(
            row.environmentId,
            row.owner,
            row.repo,
            row.number,
            row.title,
            row.url,
            row.state,
            row.attention,
            row.fetchedAt,
          );
        },
        getRepo: async (environmentId) => {
          const environment = await bb.sdk.environments.get({ environmentId });
          if (!environment.isGitRepo || environment.path === null) return null;
          const context = await gitButlerHost.call(
            "githubRepoContext",
            { cwd: environment.path },
            { hostId: environment.hostId },
          );
          if (context.owner === null || context.repo === null) return null;
          return { owner: context.owner, repo: context.repo };
        },
        listOpenPulls: async (repo) => {
          if (gh === null) return [];
          const key = `${repo.owner}/${repo.repo}`;
          const inflight = restPullsInFlight.get(key);
          if (inflight !== undefined) return inflight;
          const path = `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?state=open&per_page=100`;
          const pending = (async () => {
            const listed = await githubRestJson(gh, path);
            if (listed.exitCode !== 0) {
              throw new Error(listed.stderr.trim() || `gh api ${path} exited ${listed.exitCode}`);
            }
            return parseRestPulls(listed.raw);
          })().finally(() => {
            restPullsInFlight.delete(key);
          });
          restPullsInFlight.set(key, pending);
          return pending;
        },
        getPull: async (repo, number) => {
          if (gh === null) return null;
          const key = `${repo.owner}/${repo.repo}#${number}`;
          const inflight = restPullGetInFlight.get(key);
          if (inflight !== undefined) return inflight;
          const path = `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${number}`;
          const pending = (async () => {
            const listed = await githubRestJson(gh, path);
            if (listed.exitCode !== 0) {
              throw new Error(listed.stderr.trim() || `gh api ${path} exited ${listed.exitCode}`);
            }
            return parseRestPull(listed.raw);
          })().finally(() => {
            restPullGetInFlight.delete(key);
          });
          restPullGetInFlight.set(key, pending);
          return pending;
        },
        listClosedPullsByHead: async (repo, branchName) => {
          if (gh === null) return [];
          const head = `${repo.owner}:${branchName}`;
          const path = `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?state=closed&head=${encodeURIComponent(head)}&per_page=5`;
          const listed = await githubRestJson(gh, path);
          if (listed.exitCode !== 0) {
            throw new Error(listed.stderr.trim() || `gh api ${path} exited ${listed.exitCode}`);
          }
          return parseRestPulls(listed.raw);
        },
        log: bb.log,
      });

      return {
        pullRequests: [...resolved.entries()].map(([threadId, pullRequest]) => ({
          threadId,
          ...pullRequest,
        })),
      };
    },
    /**
     * The archived threads this plugin settled in the last day, and only
     * those. A thread the user archived through bb itself has no row here and
     * stays out of the sidebar, exactly as it did before any of this existed;
     * one settled longer ago than the window keeps its row and its archive and
     * simply stops being drawn.
     *
     * The window is applied here as well as on the frontend. The frontend's is
     * the live one — it re-cuts on its own clock, so a row ages off screen
     * without a refetch — and this one keeps the response proportional to the
     * shelf instead of to the whole archive.
     */
    async listSettledThreads() {
      const now = Date.now();
      const settledAtById = new Map(
        readAll()
          .filter((row) => row.settledAt !== null && isWithinSettledWindow(row.settledAt, now))
          .map((row) => [row.threadId, row.settledAt as number]),
      );
      if (settledAtById.size === 0) return { threads: [] };
      let archived;
      try {
        archived = await listArchivedThreads();
      } catch (error) {
        // The shelf keeps whatever the frontend already had rather than
        // emptying itself over one failed read.
        bb.log.warn(`listing archived threads failed: ${String(error)}`);
        throw error;
      }
      return {
        threads: archived
          .filter((thread) => settledAtById.has(thread.id))
          .map((thread) => ({
            id: thread.id,
            // Non-null by construction: the id came from this map.
            settledAt: settledAtById.get(thread.id) ?? 0,
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
          })),
      };
    },
    async settle({ threadId }) {
      // Settling clears any snooze: they are two answers to the same
      // question, and holding both would make the shelf order ambiguous.
      write({
        threadId,
        settledAt: Date.now(),
        snoozedUntil: null,
        snoozedAt: null,
        archivedThreadIds: [],
      });
      // The row first, then the archive. A settled thread stays on screen
      // only because its row says so, so archiving first would blink it out
      // of the list until the row landed.
      const archivedThreadIds = await archiveThread(threadId);
      if (archivedThreadIds.length > 0) {
        // Second write, second publish — and the publish is the point. bb has
        // just evicted the thread from the host's sidebar view, so this is
        // what tells the frontend to fetch it back from `listSettledThreads`.
        // Re-read rather than re-derive: a user who restored the thread while
        // the archive was in flight must not have their un-settle overwritten
        // by the settle that started before it.
        const row = readOne(threadId);
        if (row !== undefined && row.settledAt !== null) {
          write({ ...row, archivedThreadIds });
        }
      }
      return { ok: true };
    },
    async unsettle({ threadId }) {
      // The archive first, then the row — the mirror of settle, for the same
      // reason: clearing the row while the thread is still archived would
      // drop it out of the sidebar entirely.
      await unarchiveThreads(archivedIdsFor(threadId));
      clear(threadId);
      return { ok: true };
    },
    async snooze({ threadId, snoozedUntil, pullRequestUrl }) {
      const now = Date.now();
      // Snoozing a settled thread takes the archive back first: a snoozed row
      // is not on the settled shelf, so the thread has nowhere to be drawn
      // until bb reports it again.
      await unarchiveThreads(archivedIdsFor(threadId));
      write({
        threadId,
        settledAt: null,
        snoozedUntil,
        snoozedAt: now,
        archivedThreadIds: [],
      });
      rememberPullRequestUrl(threadId, pullRequestUrl);
      return { ok: true };
    },
    async unsnooze({ threadId }) {
      clear(threadId);
      return { ok: true };
    },
    async logPrDebug(payload) {
      const env = payload.environmentId ?? "none";
      if (payload.hasPullRequest) {
        bb.log.info(
          `pr-debug ${payload.threadId} env=${env} #${payload.number} state=${payload.state} attention=${payload.attention}`,
        );
      } else {
        bb.log.info(
          `pr-debug ${payload.threadId} env=${env} loading=${payload.isLoading} pullRequest=null`,
        );
      }
      return { ok: true };
    },
    async openThreadBrowserTab({ tab, threadId }) {
      const browserTab: InAppBrowserTab = { ...tab, kind: "browser" };
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await bb.sdk.threads.tabs.get({ threadId });
        const persistable = current.tabs.filter((candidate) => candidate.kind !== "side-chat");
        const next = upsertBrowserTab(persistable, browserTab);
        const opened = asPersistedBrowserTab(next.tab, browserTab);
        const alreadyThere = persistable.some((candidate) => candidate.id === opened.id);
        if (alreadyThere) {
          return { tab: opened };
        }
        try {
          await bb.sdk.threads.tabs.update({
            expectedRevision: current.revision,
            tabs: next.tabs,
            threadId,
          });
          return { tab: opened };
        } catch (error) {
          const status =
            typeof error === "object" && error !== null && "status" in error
              ? error.status
              : null;
          if (status !== 409 || attempt === 2) throw error;
        }
      }
      return { tab: browserTab };
    },
  });

  // A deleted thread must not leave a row behind that would park a future
  // thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", ({ thread }) => {
    clear(thread.id);
  });

  /**
   * The settled shelf's heartbeat.
   *
   * An archived thread is invisible to the host's sidebar view, so no host
   * update can tell the frontend that a settled thread started working or
   * finished a turn. Without this the un-settle rule — new attention brings a
   * thread back — would never fire again for anything on the shelf. A publish
   * only asks the frontend to re-read; the decision stays where it was.
   */
  const republishIfSettled = ({ thread }: { thread: { id: string } }) => {
    if (readOne(thread.id)?.settledAt == null) return;
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId: thread.id });
  };
  bb.events.on("thread.active", republishIfSettled);
  bb.events.on("thread.idle", republishIfSettled);
  bb.events.on("thread.failed", republishIfSettled);

  const readRateLimitHint = async (): Promise<{
    remaining: number | null;
    skipUntilMs: number | null;
  }> => {
    const stored = await bb.storage.kv.get<{ remaining?: unknown; skipUntilMs?: unknown }>(
      PR_WATCH_RATE_LIMIT_KEY,
    );
    if (stored === undefined) return { remaining: null, skipUntilMs: null };
    return {
      remaining: typeof stored.remaining === "number" ? stored.remaining : null,
      skipUntilMs: typeof stored.skipUntilMs === "number" ? stored.skipUntilMs : null,
    };
  };

  bb.background.schedule("pr-watch", "0 * * * *", async () => {
    if (shutdown.signal.aborted) return;
    const ghPath = await resolveGhPath(shutdown.signal);
    if (ghPath === null) {
      bb.log.info("snoozed PR watch skipped: GitHub CLI not found on PATH");
      return;
    }

    const gh = createGhRunner(shutdown.signal, ghPath);
    const hint = await readRateLimitHint();
    const now = Date.now();
    const result = await pollSnoozedPullRequests({
      now,
      store: {
        listSnoozed: () =>
          readAll()
            .filter((row) => row.snoozedUntil !== null)
            .map((row) => ({
              threadId: row.threadId,
              snoozedUntil: row.snoozedUntil as number,
            })),
        getWatch: (threadId) => {
          const row = db
            .prepare(
              `SELECT thread_id, pr_url, snapshot_json
                 FROM snoozed_pr_watch
                WHERE thread_id = ?`,
            )
            .get(threadId) as
            | { thread_id: string; pr_url: string; snapshot_json: string | null }
            | undefined;
          if (row === undefined) return undefined;
          return {
            threadId: row.thread_id,
            prUrl: row.pr_url,
            snapshotJson: row.snapshot_json,
          } satisfies StoredPrWatch;
        },
        upsertWatch: (row) => {
          db.prepare(
            `INSERT INTO snoozed_pr_watch
               (thread_id, pr_url, snapshot_json, last_polled_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET
               pr_url = excluded.pr_url,
               snapshot_json = excluded.snapshot_json,
               last_polled_at = excluded.last_polled_at`,
          ).run(row.threadId, row.prUrl, row.snapshotJson, row.lastPolledAt);
        },
      },
      graphql: (query) => githubGraphql(gh, query),
      resolvePrUrl: async (threadId) => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId === null) return null;
        const pullRequest = await bb.sdk.environments.pullRequest({
          environmentId: thread.environmentId,
        });
        if (pullRequest.outcome !== "available") return null;
        return pullRequest.pullRequest.url;
      },
      wakeThread: async (threadId, snapshot, changes) => {
        // Clear the shelf first so a successful agent turn cannot land back
        // on Snoozed when it goes idle. Then start a turn with what changed.
        clear(threadId);
        await bb.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [
            {
              type: "text",
              text: formatAgentWakeMessage(snapshot, changes),
              mentions: [],
            },
          ],
        });
      },
      log: bb.log,
      remainingHint: hint.remaining,
      skipUntilMs: hint.skipUntilMs,
    });

    await bb.storage.kv.set(PR_WATCH_RATE_LIMIT_KEY, {
      remaining: result.remaining,
      skipUntilMs: result.skipUntilMs,
    });
  });
}
