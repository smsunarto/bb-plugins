/**
 * A Change's files, patches and commits at one revision: from the checkout's
 * host for a host revision, from the forge for a pull request's. Revisions
 * are immutable, so each list is read once and kept; patches for a forge
 * revision come out of its file list.
 */
import { Effect } from "effect";
import type { Commit, FilePatch, Problem } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import {
  parseChangeKey,
  type ChangeFile,
  type CommitsResult,
  type FilesResult,
  type ReviewRevision,
} from "../core/review.ts";
import { readPullRequestCommits, readPullRequestFiles } from "../forge/review.ts";
import type { RangeAnswer, RangeRead } from "../contract/host.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { LocalReads } from "./local-read.ts";
import { callProblem, failureProblem, hostCall, type HostCalls } from "./host-calls.ts";
import { moved } from "./review-change.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

/** File lists kept per revision, most recent first. */
const REVISION_CACHE = 24;

type HostRevision = ReviewRevision & { source: { kind: "host" } };
type ForgeRevision = ReviewRevision & { source: { kind: "forge" } };
type ForgeFile = { file: ChangeFile; patch: FilePatch | null };

const isHost = (revision: ReviewRevision): revision is HostRevision =>
  revision.source.kind === "host";
const isForge = (revision: ReviewRevision): revision is ForgeRevision =>
  revision.source.kind === "forge";

/** A small most-recently-used map. */
function lru<V>(limit: number) {
  const entries = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const value = entries.get(key);
      if (value !== undefined) {
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    },
    set(key: string, value: V) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
  };
}

const revisionId = (key: ChangeKey, revision: ReviewRevision) =>
  `${key}@${revision.base}..${revision.head}`;

/** GitHub sends no hunks for a binary file or one past its size limit: the patch says so. */
const forgePatch = (entry: ForgeFile): FilePatch =>
  entry.patch ?? {
    path: entry.file.path,
    kind: entry.file.kind,
    previousPath: entry.file.previousPath,
    patch: "",
    truncated: true,
  };

export function createRevisionReads(deps: {
  store: Store;
  sites: ForgeSites;
  host: HostCalls;
  local: LocalReads;
  share: Share;
  deadlineMs: number;
}) {
  const { store } = deps;
  const forgeFiles = lru<ForgeFile[]>(REVISION_CACHE);
  const hostFiles = lru<ChangeFile[]>(REVISION_CACHE);

  const onHost = (revision: HostRevision, read: RangeRead) =>
    Effect.gen(function* () {
      const { hostId, path } = revision.source;
      const placement = store
        .checkouts()
        .find((each) => each.hostId === hostId && each.path === path);
      if (!placement) return yield* Effect.fail(moved("No thread has this checkout any more."));
      const answer = yield* hostCall(deps.deadlineMs, (options) =>
        deps.host.range(hostId, { path, base: revision.base, head: revision.head, read }, options),
      ).pipe(
        Effect.mapError((error) => callProblem(placement, error, true)),
        // A host that missed its deadline is unreachable for the checkout's header too.
        Effect.tapError((problem) =>
          problem.kind === "host-offline"
            ? deps.local.unreachable(placement, problem)
            : Effect.void,
        ),
      );
      if (!answer.ok) return yield* Effect.fail(failureProblem(placement, answer.error));
      return answer.value as RangeAnswer;
    });

  /** The forge's files for the revision, once: only while the pull request is still at its head. */
  const forgeFilesAt = (key: ChangeKey, revision: ForgeRevision) =>
    Effect.suspend(() => {
      const id = revisionId(key, revision);
      const known = forgeFiles.get(id);
      if (known) return Effect.succeed(known);
      const parsed = parseChangeKey(key);
      if (parsed?.kind !== "gh") return Effect.fail(moved("This Change is not on GitHub."));
      const head = store.forge(key).read?.value?.headRefOid;
      if (head && head !== revision.head)
        return Effect.fail(moved("The pull request has a newer head. Open it again to read it."));
      return deps.share(
        `files:${id}`,
        deps.sites
          .onServer(parsed.repo, (exec, signal) =>
            readPullRequestFiles(exec, parsed.repo, revision.source.number, signal),
          )
          .pipe(
            Effect.mapError((error) => error.problem),
            Effect.tap((files) => Effect.sync(() => forgeFiles.set(id, files))),
          ),
      );
    });

  const hostFilesAt = (key: ChangeKey, revision: HostRevision) =>
    Effect.suspend(() => {
      const id = revisionId(key, revision);
      const known = hostFiles.get(id);
      if (known) return Effect.succeed(known);
      return deps.share(
        `files:${id}`,
        onHost(revision, { kind: "files" }).pipe(
          Effect.map((answer) => (answer.kind === "files" ? answer.files : [])),
          Effect.tap((files) => Effect.sync(() => hostFiles.set(id, files))),
        ),
      );
    });

  const filesAt = (key: ChangeKey, revision: ReviewRevision) => {
    if (isHost(revision)) return hostFilesAt(key, revision);
    if (isForge(revision))
      return forgeFilesAt(key, revision).pipe(Effect.map((entries) => entries.map((e) => e.file)));
    return Effect.fail(moved("Unknown revision source."));
  };

  /** A rename's old path must be in the pathspec for git to pair it. */
  const hostPatches = (key: ChangeKey, revision: HostRevision, wanted: Set<string>) =>
    Effect.gen(function* () {
      const list = yield* hostFilesAt(key, revision);
      const previous = list.flatMap((file) =>
        wanted.has(file.path) && file.previousPath ? [file.previousPath] : [],
      );
      const answer = yield* onHost(revision, { kind: "patches", paths: [...wanted, ...previous] });
      return answer.kind === "patches" ? answer.files.filter((p) => wanted.has(p.path)) : [];
    });

  const commitsAt = (key: ChangeKey, revision: ReviewRevision) => {
    if (isHost(revision))
      return onHost(revision, { kind: "commits" }).pipe(
        Effect.map((answer): Commit[] => (answer.kind === "commits" ? answer.commits : [])),
      );
    const parsed = parseChangeKey(key);
    if (!isForge(revision) || parsed?.kind !== "gh")
      return Effect.fail(moved("This Change is not on GitHub."));
    return deps.sites
      .onServer(parsed.repo, (exec, signal) =>
        readPullRequestCommits(exec, parsed.repo, revision.source.number, signal),
      )
      .pipe(Effect.mapError((error) => error.problem));
  };

  return {
    files: (key: ChangeKey, revision: ReviewRevision) =>
      filesAt(key, revision).pipe(
        Effect.map((list): FilesResult => ({ ok: true, files: list, more: false })),
        Effect.catch((problem: Problem) => Effect.succeed<FilesResult>({ ok: false, problem })),
      ),
    patches: (key: ChangeKey, revision: ReviewRevision, paths: readonly string[]) => {
      const wanted = new Set(paths);
      const read: Effect.Effect<FilePatch[], Problem> = isForge(revision)
        ? forgeFilesAt(key, revision).pipe(
            Effect.map((entries) => entries.filter((e) => wanted.has(e.file.path)).map(forgePatch)),
          )
        : isHost(revision)
          ? hostPatches(key, revision, wanted)
          : Effect.fail(moved("Unknown revision source."));
      return read.pipe(
        Effect.map((list) => ({ ok: true as const, value: { files: list } })),
        Effect.catch((problem: Problem) => Effect.succeed({ ok: false as const, problem })),
      );
    },
    commits: (key: ChangeKey, revision: ReviewRevision) =>
      commitsAt(key, revision).pipe(
        Effect.map((list): CommitsResult => ({ ok: true, commits: list, more: false })),
        Effect.catch((problem: Problem) => Effect.succeed<CommitsResult>({ ok: false, problem })),
      ),
  };
}
