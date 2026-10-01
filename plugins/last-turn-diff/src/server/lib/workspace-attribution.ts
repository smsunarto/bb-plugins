import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { join } from "node:path";
import { MAX_PATCH_CHARS, type TurnRow } from "./build-latest-turn.ts";
import type { Change, LatestTurn } from "../../shared/contract.ts";
import type { Coverage } from "./read-latest-turn.ts";
import { isTemporaryPath } from "../../shared/patches.ts";

type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
type Project = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["list"]>>[number];
type FileChangeRow = Extract<TurnRow, { workKind: "file-change" }>;

interface SourceRoot {
  root: string;
  label: string;
}

interface Attribution {
  workspace?: string;
  relPath?: string;
}

type Attribute = (path: string) => Attribution;

function stripTrailingSeparators(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

function lastSegment(path: string): string {
  const trimmed = stripTrailingSeparators(path);
  return trimmed.split(/[/\\]/).at(-1) ?? path;
}

function parentDirectory(path: string): string {
  const trimmed = stripTrailingSeparators(path);
  const index = trimmed.search(/[/\\][^/\\]+$/);
  return index < 0 ? trimmed : trimmed.slice(0, index);
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path);
}

/** The workspace-relative remainder when `path` lives under `root`, else null. */
function under(root: string, path: string): string | null {
  const normalized = stripTrailingSeparators(root);
  if (path === normalized) return "";
  return path.startsWith(`${normalized}/`) ? path.slice(normalized.length + 1) : null;
}

function projectSources(projects: Project[], hostId: string | undefined): SourceRoot[] {
  return projects
    .flatMap((project: Project) =>
      project.sources
        .filter((source) => hostId === undefined || source.hostId === hostId)
        .map((source) => ({ root: stripTrailingSeparators(source.path), label: project.name })),
    )
    .sort((a, b) => b.root.length - a.root.length);
}

export function isFileChangeRow(row: TurnRow): row is FileChangeRow {
  return (
    row.kind === "work" &&
    row.workKind === "file-change" &&
    row.status === "completed" &&
    row.approvalStatus !== "denied"
  );
}

function insideAny(roots: readonly string[], path: string | undefined): boolean {
  return path !== undefined && roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * Edits the patch cannot cover: those outside the thread's own worktree, and
 * those inside submodules, which a workspace snapshot records only as a commit.
 */
function uncoveredRowChanges(
  turnId: string,
  patchLength: number,
  rows: TurnRow[],
  attribute: Attribute,
  submodules: readonly string[],
): { changes: Change[]; limited: boolean } {
  const changes: Change[] = [];
  let limited = false;
  let remaining = MAX_PATCH_CHARS - patchLength;
  for (const row of rows) {
    if (row.turnId !== turnId || !isFileChangeRow(row)) continue;
    const destination = row.change.movePath;
    const path =
      destination && (!isTemporaryPath(destination) || attribute(destination).relPath !== undefined)
        ? destination
        : row.change.path;
    const attribution = attribute(path);
    if (attribution.workspace === undefined && !insideAny(submodules, attribution.relPath)) {
      continue;
    }
    let text = row.change.diff;
    if (text !== null && text.length > remaining) {
      text = null;
      limited = true;
    }
    remaining -= text?.length ?? 0;
    changes.push({
      id: row.id,
      path,
      patch: text,
      ...row.change.diffStats,
      ...attribution,
    });
  }
  return { changes, limited };
}

/** Labels a turn's changes by owning workspace. Pure, so turn selection can apply it per candidate. */
export interface Attributor {
  apply: (turn: LatestTurn, rows: TurnRow[], coverage?: Coverage) => LatestTurn;
  keepPath: (path: string, coverage?: Coverage) => boolean;
}

async function loadContext(bb: BbPluginApi, threadId: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  const environment: Environment | null = thread.environmentId
    ? await bb.sdk.environments.get({ environmentId: thread.environmentId })
    : null;
  const root = environment?.path ? stripTrailingSeparators(environment.path) : null;
  const projects = await bb.sdk.projects.list({ includePersonal: true }).catch(() => []);
  const sources = projectSources(projects, environment?.hostId);
  const own = root ? sources.find((source) => source.root === root) : undefined;
  return {
    root,
    sources,
    ownLabel: own?.label ?? environment?.name ?? (root ? lastSegment(root) : undefined),
  };
}

/**
 * Label each recorded change with the workspace that owns it. Provider-reported
 * change paths are absolute, so a turn that edited another checkout shows up
 * here: foreign changes get a `workspace` label and every attributed path gets
 * a workspace-relative `relPath` for display. Unattributable foreign paths are
 * labeled by their parent directory.
 *
 * When a patch exists (aggregate or snapshot) it only covers the thread's own
 * worktree, so foreign and submodule file-change rows are appended to
 * `changes` alongside it. Never throws. Without the thread's environment,
 * labels are missing, but rows a snapshot covers are still dropped.
 */
export async function workspaceAttributor(bb: BbPluginApi, threadId: string): Promise<Attributor> {
  const context = await loadContext(bb, threadId).catch(() => null);
  const sources = context?.sources ?? [];
  const ownLabel = context?.ownLabel;
  const attribution = (path: string, coverage?: Coverage): Attribution => {
    const root = context?.root ?? coverage?.roots[0] ?? null;
    // Relative paths resolve against the env root so `../` escapes still
    // attribute correctly; without a root they can only be local.
    const absolute = isAbsolute(path)
      ? stripTrailingSeparators(path)
      : root
        ? join(root, path)
        : null;
    if (absolute === null) return {};
    const local = [...(root === null ? [] : [root]), ...(coverage?.roots ?? [])]
      .map((candidate) => under(candidate, absolute))
      .find((rest) => rest !== null);
    if (local !== undefined) return local ? { relPath: local } : {};
    const foreign = sources.find((source) => under(source.root, absolute) !== null);
    if (foreign) return { workspace: foreign.label, relPath: under(foreign.root, absolute)! };
    return { workspace: lastSegment(parentDirectory(absolute)) };
  };
  const keepPath = (path: string, coverage?: Coverage) =>
    !isTemporaryPath(path) || attribution(path, coverage).relPath !== undefined;
  return {
    keepPath,
    apply: (turn, rows, coverage) => {
      // Without the environment, only a snapshot's root tells local from foreign.
      if (!context && !coverage) return turn;
      const attribute: Attribute = (path) => attribution(path, coverage);

      let limited = turn.limited;
      let changes: Change[];
      if (turn.patch === null) {
        changes = turn.changes.map((change) => ({ ...change, ...attribute(change.path) }));
      } else {
        const extra = uncoveredRowChanges(
          turn.turnId,
          turn.patch.length,
          rows.filter(
            (row) =>
              !isFileChangeRow(row) ||
              keepPath(row.change.path, coverage) ||
              (row.change.movePath !== null && keepPath(row.change.movePath, coverage)),
          ),
          attribute,
          coverage?.uncovered ?? [],
        );
        changes = extra.changes;
        limited ||= extra.limited;
      }
      const projectRoots = [
        ...new Set([
          ...(context?.root ? [context.root] : []),
          ...(coverage?.roots ?? []),
          ...sources.map((source) => source.root),
        ]),
      ].filter(isTemporaryPath);
      return {
        ...turn,
        changes,
        limited,
        ...(ownLabel ? { workspace: ownLabel } : {}),
        ...(projectRoots.length ? { projectRoots } : {}),
      };
    },
  };
}
