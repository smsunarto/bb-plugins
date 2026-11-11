/**
 * The guided diff's runs. Opening a Change's review page claims one hidden
 * guide run for it, once, in a store transaction; any number of clients and
 * tabs claim it once. Runs start in the order they were claimed, at most
 * `MAX_RUNS` at a time per server; the rest wait. The server resolves the
 * revision and gives the run the file list; the agent reads the diff itself
 * and reports with `source_control_write_guide`, which accepts only those
 * paths. A run whose thread ends without a guide fails, on the thread's
 * event or on the next read after a restart. A later head starts nothing:
 * the stored guide carries forward until someone asks for a rewrite.
 */
import type {
  BbPluginApi,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
} from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { Effect } from "effect";
import { z } from "zod";
import type { Problem } from "../core/change.ts";
import { EMPTY_GUIDE_VIEW, type Guide, type GuidePhase, type GuideView } from "../core/guide.ts";
import { guideTag, type ChangeKey } from "../core/ids.ts";
import {
  parseChangeKey,
  type ChangeDetail,
  type ChangeFile,
  type FilesResult,
  type ReviewRevision,
} from "../core/review.ts";
import { changeHome, fenced, inlineCode, quote } from "./review-start.ts";
import type { GuideRow, Store } from "./store.ts";

const files = instructionFiles(import.meta.url);

export const WRITE_GUIDE = "source_control_write_guide";
/** Guide runs one server starts at once; the rest wait in the order they were asked for. */
export const MAX_RUNS = 2;
/** Files listed in the prompt; a bigger change lists these and says how many more. */
const PROMPT_FILES = 1000;
/** Above this many files the prompt lists directories, each with its count and size. */
const LIST_BY_DIRECTORY = 80;

const RUNNING = new Set(["pending", "starting", "active", "stopping"]);

/** The guide runs' provider and model; either left out takes the project's default. */
export type GuideModel = { providerId?: string; model?: string };

const moved = (detail: string): Problem => ({ kind: "moved", detail });
const failedAt = (detail: string): Problem => ({ kind: "failed", site: "bb", detail });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ── The prompt ─────────────────────────────────────────────────────────

function fileLine(file: ChangeFile): string {
  const from = file.previousPath ? ` from ${inlineCode(file.previousPath)}` : "";
  const size = file.binary ? "binary" : `+${file.additions} −${file.deletions}`;
  return `- ${inlineCode(file.path)} (${file.kind}${from}, ${size})`;
}

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1) || "./";

/** One line per directory: how many files, of which kinds, and the lines they change. */
function directoryList(list: readonly ChangeFile[]): string {
  const dirs = new Map<
    string,
    { files: number; kinds: Map<string, number>; add: number; del: number }
  >();
  for (const file of list) {
    const dir = directoryOf(file.path);
    const entry = dirs.get(dir) ?? { files: 0, kinds: new Map(), add: 0, del: 0 };
    entry.files += 1;
    entry.kinds.set(file.kind, (entry.kinds.get(file.kind) ?? 0) + 1);
    entry.add += file.additions;
    entry.del += file.deletions;
    dirs.set(dir, entry);
  }
  return [...dirs]
    .map(([dir, entry]) => {
      const kinds = [...entry.kinds].map(([kind, count]) => `${count} ${kind}`).join(", ");
      return `- ${inlineCode(dir)}: ${entry.files} files (${kinds}), +${entry.add} −${entry.del}`;
    })
    .join("\n");
}

/** Every file with its change; a big change by directory, which the write tool also accepts. */
function fileList(list: readonly ChangeFile[]): string {
  if (list.length > LIST_BY_DIRECTORY)
    return [
      `${list.length} files, by directory. You can place a directory without listing its files; list one only if you need a file from it by name.`,
      "",
      directoryList(list),
    ].join("\n");
  const shown = list.slice(0, PROMPT_FILES).map(fileLine);
  const more = list.length - shown.length;
  return more > 0 ? `${shown.join("\n")}\n- …and ${more} more files` : shown.join("\n");
}

/**
 * One complete diff command: the base is named, or resolved inside the
 * command, so the run spends no turn finding it.
 */
export function guideDiff(revision: ReviewRevision): string {
  const head = revision.head;
  if (!revision.base.startsWith("branch:")) return `git diff ${revision.base}...${head}`;
  const name = revision.base.slice("branch:".length);
  if (name) return `git diff ${quote(`origin/${name}`)}...${head}`;
  return `git diff "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"...${head}`;
}

/** Where the run reads the change: its checkout, or the pull request fetched into a new worktree. */
function whereText(
  revision: ReviewRevision,
  placement: { path: string; hostName: string } | null,
  pr: { number: number; url: string; baseRef: string } | null,
): string {
  if (placement) {
    return [
      `- Checkout: ${inlineCode(placement.path)} on ${placement.hostName}`,
      `- Head: \`${revision.head}\``,
      "",
      "Run git in the checkout. This checkout is someone's working copy and may hold their other work; read only this diff:",
      "",
      fenced(guideDiff(revision)),
      "",
      `Read a file as the branch has it with \`git show ${revision.head}:<path>\`.`,
    ].join("\n");
  }
  if (!pr) return `- Head: \`${revision.head}\``;
  return [
    `- Pull request: #${pr.number}, ${pr.url}`,
    `- Head: \`${revision.head}\``,
    "",
    "Fetch it in this worktree and read this diff:",
    "",
    fenced(
      [
        `git fetch origin 'pull/${pr.number}/head' ${quote(pr.baseRef)}`,
        `git diff ${quote(`origin/${pr.baseRef}`)}...${revision.head}`,
      ].join("\n"),
    ),
  ].join("\n");
}

// ── The write tool ─────────────────────────────────────────────────────

const parameters = z.strictObject({
  summary: z
    .string()
    .max(1200)
    .describe(
      "Two or three sentences on the whole change: groups, where the risk is, what to skim.",
    ),
  groups: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(120).describe("A few words."),
        intro: z
          .string()
          .max(1200)
          .describe("One to three sentences: what the group does, what to read first."),
        files: z
          .array(
            z.strictObject({
              path: z
                .string()
                .min(1)
                .describe(
                  "A file path from the change, or a directory ending in `/` for all its files you do not place elsewhere.",
                ),
              note: z
                .string()
                .max(300)
                .optional()
                .describe("One line, only when it adds to the path."),
            }),
          )
          .min(1),
      }),
    )
    .min(1)
    .max(40),
});

export function writeGuideEnabled(session: PluginAgentConfigurationContext): boolean {
  const { kind, changeKey } = session.pluginMetadata;
  return kind === "guide" && typeof changeKey === "string";
}

const slug = (title: string, index: number) =>
  `${index + 1}-${title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 40)}`;

type WrittenGroup = z.output<typeof parameters>["groups"][number];

/**
 * Directory entries (`src/mod00/`) replaced by the change's files under
 * them, in path order. A file named on its own stays where it is named; one
 * no group names is left to the page's "Not in the guide" group.
 */
export function expandDirectories(
  groups: readonly WrittenGroup[],
  paths: readonly string[],
): { placed: WrittenGroup[]; unknown: string[] } {
  const known = new Set(paths);
  const named = new Set(
    groups.flatMap((group) =>
      group.files.flatMap((file) => (known.has(file.path) ? [file.path] : [])),
    ),
  );
  const taken = new Set<string>();
  const unknown: string[] = [];
  const placed = groups.map((group) => ({
    ...group,
    files: group.files.flatMap((file) => {
      if (known.has(file.path)) {
        if (taken.has(file.path)) return [];
        taken.add(file.path);
        return [file];
      }
      if (!file.path.endsWith("/")) {
        unknown.push(file.path);
        return [];
      }
      const inDir = (path: string) =>
        file.path === "./" ? !path.includes("/") : path.startsWith(file.path);
      const under = paths
        .filter((path) => inDir(path) && !named.has(path) && !taken.has(path))
        .toSorted();
      if (under.length === 0 && !paths.some(inDir)) unknown.push(file.path);
      for (const path of under) taken.add(path);
      return under.map((path) => ({ path }));
    }),
  }));
  return { placed, unknown };
}

// ── Runs ───────────────────────────────────────────────────────────────

export function createGuides(deps: {
  bb: BbPluginApi;
  store: Store;
  detail: (key: ChangeKey) => ChangeDetail;
  /** Reads the Change's sources now, so the run is given its current head. */
  refresh: (key: ChangeKey) => Effect.Effect<void>;
  files: (key: ChangeKey, revision: ReviewRevision) => Effect.Effect<FilesResult>;
  invalidate: (tags: readonly string[]) => void;
  fork: (work: Effect.Effect<void>) => void;
  now: () => number;
  model: () => Promise<GuideModel>;
}) {
  const { bb, store } = deps;
  /** Threads this server saw running since it started; any other is asked about once. */
  const alive = new Set<string>();
  const asking = new Set<string>();

  const changed = (key: ChangeKey) => deps.invalidate([guideTag(key)]);

  /** The run cannot start or ended without writing: failed, keeping any earlier guide on show. */
  const fail = (key: ChangeKey, row: GuideRow, problem: Problem) => {
    store.putGuide(key, { ...row, state: "failed", problem });
    changed(key);
  };

  /** The spawn: the thread's id, or why no run can start here. */
  const spawn = async (
    key: ChangeKey,
    detail: Extract<ChangeDetail, { state: "change" }>,
    revision: ReviewRevision,
    listed: readonly ChangeFile[],
  ): Promise<{ threadId: string } | { problem: Problem }> => {
    const home = await changeHome(bb, store, key, revision);
    if (typeof home === "string") return { problem: moved(home) };
    const pr = store.forge(key).read?.value ?? null;
    const open = pr && pr.state === "open" ? pr : null;
    if (!home.placement && !open)
      return { problem: moved("This Change has no checkout or open pull request to read.") };
    const parsed = parseChangeKey(key);
    const model = await deps.model();
    const thread = await bb.sdk.threads.spawn({
      projectId: home.projectId,
      environment: home.environment,
      visibility: "hidden",
      title: `Guide ${detail.row.number ? `#${detail.row.number}` : detail.row.branch}`,
      pluginMetadata: { kind: "guide", changeKey: key, revision: revision.head },
      ...model,
      prompt: files.read("guide-run", {
        change: inlineCode(detail.row.branch),
        repoName: inlineCode(
          parsed?.kind === "gh" ? `${parsed.repo.owner}/${parsed.repo.name}` : detail.row.repo,
        ),
        where: whereText(
          revision,
          home.placement,
          open ? { number: open.number, url: open.url, baseRef: open.baseRef } : null,
        ),
        files: fileList(listed),
      }),
    });
    return { threadId: thread.id };
  };

  /** Starts one waiting run: resolves the revision, lists its files, spawns the hidden thread. */
  const start = (key: ChangeKey, row: GuideRow) =>
    Effect.gen(function* () {
      yield* deps.refresh(key);
      const detail = deps.detail(key);
      if (detail.state !== "change" || !detail.revision)
        return fail(key, row, moved("This Change has no commits to guide yet."));
      const { revision } = detail;
      const listed = yield* deps.files(key, revision);
      if (!listed.ok) return fail(key, row, listed.problem);
      const started = yield* Effect.tryPromise({
        try: () => spawn(key, detail, revision, listed.files),
        catch: (error) => failedAt(message(error)),
      }).pipe(Effect.catch((problem: Problem) => Effect.succeed({ problem })));
      if ("problem" in started) return fail(key, row, started.problem);
      alive.add(started.threadId);
      store.putGuide(key, {
        ...row,
        threadId: started.threadId,
        revision: revision.head,
        problem: null,
        startedAt: deps.now(),
        files: listed.files.map((file) => ({ path: file.path, blob: file.blob ?? null })),
      });
      changed(key);
    });

  /** Starts waiting runs while fewer than `MAX_RUNS` run, oldest first. */
  const pumpOnce = Effect.gen(function* () {
    const rows = store.runningGuides();
    let active = rows.filter((each) => each.row.threadId !== null).length;
    for (const { key, row } of rows) {
      if (active >= MAX_RUNS) break;
      if (row.threadId !== null) continue;
      yield* start(key, row).pipe(
        Effect.catchCause((cause) => Effect.sync(() => fail(key, row, failedAt(String(cause))))),
      );
      // A run that could not start holds no slot.
      if (store.guide(key)?.threadId) active += 1;
    }
  });

  // One pump at a time; a claim or a freed slot during a pass runs one more pass after it.
  let pumping = false;
  let again = false;
  const startPump = () => {
    again = true;
    if (pumping) return;
    pumping = true;
    deps.fork(
      Effect.whileLoop({
        while: () => again,
        body: () => {
          again = false;
          return Effect.ignore(pumpOnce);
        },
        step: () => {},
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pumping = false;
          }),
        ),
      ),
    );
  };

  /** A run's thread stopped: without a guide, the run failed; either way a slot is free. */
  const threadEnded = (threadId: string) => {
    alive.delete(threadId);
    const found = store.guideByThread(threadId);
    if (!found) return;
    if (found.row.state === "running")
      fail(found.key, found.row, moved("The guide run ended without writing a guide."));
    startPump();
  };

  /** After a restart, a running row's thread is asked about once; one that stopped fails. */
  const confirm = (row: GuideRow) => {
    const threadId = row.threadId;
    if (row.state !== "running" || !threadId || alive.has(threadId) || asking.has(threadId)) return;
    asking.add(threadId);
    deps.fork(
      Effect.promise(() =>
        bb.sdk.threads.get({ threadId }).then(
          (thread) => RUNNING.has(thread.status),
          () => false,
        ),
      ).pipe(
        Effect.flatMap((running) =>
          Effect.sync(() => {
            asking.delete(threadId);
            if (running) alive.add(threadId);
            else threadEnded(threadId);
          }),
        ),
      ),
    );
  };

  const phaseOf = (row: GuideRow): GuidePhase => {
    if (row.state !== "running") return row.state;
    return row.threadId ? "writing" : "waiting";
  };

  const view = (key: ChangeKey): GuideView => {
    const row = store.guide(key);
    const viewed = store.viewed(key);
    if (!row) return viewed.length > 0 ? { ...EMPTY_GUIDE_VIEW, viewed } : EMPTY_GUIDE_VIEW;
    confirm(row);
    return {
      state: row.state,
      phase: phaseOf(row),
      threadId: row.threadId,
      revision: row.revision,
      guide: row.guide,
      problem: row.problem,
      viewed,
    };
  };

  /** Claims a run and starts the pump; returns the view after the claim. */
  const claim = (key: ChangeKey, again: boolean): GuideView => {
    if (store.claimGuide(key, deps.now(), again)) {
      changed(key);
      startPump();
    }
    return view(key);
  };

  return {
    /** Stored state only; a run that stopped after a restart fails on this read. */
    read(keys: readonly ChangeKey[]): Record<string, GuideView> {
      return Object.fromEntries(keys.map((key) => [key, view(key)]));
    },
    /** The review page opened: the Change's one run, if it has none yet. */
    open: (key: ChangeKey) => claim(key, false),
    /** "Rewrite guide" and "Try again": a new run for the current head, unless one is running. */
    rewrite: (key: ChangeKey) => claim(key, true),
    setViewed(key: ChangeKey, path: string, blob: string, viewed: boolean): void {
      if (store.setViewed(key, path, blob, viewed)) changed(key);
    },
    threadEnded,
    /** At start: resume waiting runs and ask about running ones. */
    resume(): void {
      for (const { row } of store.runningGuides()) confirm(row);
      startPump();
    },
    /** The write tool's work: validated against the run's file list, bound to its revision. */
    write(threadId: string, input: z.output<typeof parameters>): string {
      const found = store.guideByThread(threadId);
      if (!found || !found.row.files || !found.row.revision)
        throw new Error(
          "This thread is not a Source Control guide run, so there is nowhere to write a guide.",
        );
      const { key, row } = found;
      const blobs = new Map(row.files!.map((file) => [file.path, file.blob]));
      const groups = expandDirectories(input.groups, [...blobs.keys()]);
      if (groups.unknown.length > 0) {
        const { unknown } = groups;
        throw new Error(
          `These paths are not in the change: ${unknown.slice(0, 20).join(", ")}${unknown.length > 20 ? ` and ${unknown.length - 20} more` : ""}. Use paths from the file list exactly as given, or a directory of them ending in \`/\`.`,
        );
      }
      const guide: Guide = {
        changeKey: key,
        revision: row.revision!,
        summary: input.summary.trim() || null,
        groups: groups.placed.flatMap((group, index) =>
          group.files.length === 0
            ? []
            : [
                {
                  id: slug(group.title, index),
                  title: group.title.trim(),
                  intro: group.intro.trim(),
                  files: group.files.map((file) => ({
                    path: file.path,
                    blob: blobs.get(file.path) ?? null,
                    note: file.note?.trim() || null,
                  })),
                },
              ],
        ),
      };
      store.putGuide(key, { ...row, state: "done", guide, problem: null });
      changed(key);
      startPump();
      const count = guide.groups.reduce((sum, group) => sum + group.files.length, 0);
      return `Saved the guide: ${guide.groups.length} groups, ${count} of ${blobs.size} files.`;
    },
  };
}

export type Guides = ReturnType<typeof createGuides>;

export function writeGuideTool(guides: Guides) {
  return {
    name: WRITE_GUIDE,
    ...files.tool(WRITE_GUIDE),
    presentation: {
      label: { pending: "Writing the reading guide", completed: "Wrote the reading guide" },
    },
    parameters,
    async execute(input: z.output<typeof parameters>, { threadId }: PluginAgentToolContext) {
      return guides.write(threadId, input);
    },
  };
}
