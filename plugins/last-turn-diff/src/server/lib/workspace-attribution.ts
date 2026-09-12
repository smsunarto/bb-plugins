import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { join } from "node:path";
import { MAX_PATCH_CHARS, type TurnRow } from "./build-latest-turn.ts";
import type { Change, LatestTurn } from "../../shared/contract.ts";

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

function isFileChangeRow(row: TurnRow): row is FileChangeRow {
  return (
    row.kind === "work" &&
    row.workKind === "file-change" &&
    row.status === "completed" &&
    row.approvalStatus !== "denied"
  );
}

/** Edits outside the thread's own worktree that the aggregate patch cannot cover. */
function foreignRowChanges(
  turnId: string,
  patchLength: number,
  rows: TurnRow[],
  attribute: Attribute,
): { changes: Change[]; limited: boolean } {
  const changes: Change[] = [];
  let limited = false;
  let remaining = MAX_PATCH_CHARS - patchLength;
  for (const row of rows) {
    if (row.turnId !== turnId || !isFileChangeRow(row)) continue;
    const attribution = attribute(row.change.path);
    if (attribution.workspace === undefined) continue;
    let text = row.change.diff;
    if (text !== null && text.length > remaining) {
      text = null;
      limited = true;
    }
    remaining -= text?.length ?? 0;
    changes.push({
      id: row.id,
      path: row.change.path,
      patch: text,
      ...row.change.diffStats,
      ...attribution,
    });
  }
  return { changes, limited };
}

/**
 * Label each recorded change with the workspace that owns it. Provider-reported
 * change paths are absolute, so a turn that edited another checkout shows up
 * here: foreign changes get a `workspace` label and every attributed path gets
 * a workspace-relative `relPath` for display. Unattributable foreign paths are
 * labeled by their parent directory.
 *
 * When an aggregate patch exists it only covers the thread's own worktree, so
 * foreign file-change rows are appended to `changes` alongside it. Never
 * throws — attribution is decorative.
 */
export async function attributeWorkspaces(
  bb: BbPluginApi,
  threadId: string,
  turn: LatestTurn,
  rows: TurnRow[],
): Promise<LatestTurn> {
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    const environment: Environment | null = thread.environmentId
      ? await bb.sdk.environments.get({ environmentId: thread.environmentId })
      : null;
    const root = environment?.path ? stripTrailingSeparators(environment.path) : null;
    const projects = await bb.sdk.projects.list({ includePersonal: true }).catch(() => []);
    const sources = projectSources(projects, environment?.hostId);
    const own = root ? sources.find((source) => source.root === root) : undefined;
    const ownLabel = own?.label ?? environment?.name ?? (root ? lastSegment(root) : undefined);

    const attribute: Attribute = (path) => {
      // Relative paths resolve against the env root so `../` escapes still
      // attribute correctly; without a root they can only be local.
      const absolute = isAbsolute(path)
        ? stripTrailingSeparators(path)
        : root
          ? join(root, path)
          : null;
      if (absolute === null) return {};
      const local = root === null ? null : under(root, absolute);
      if (local !== null) return local ? { relPath: local } : {};
      const foreign = sources.find((source) => under(source.root, absolute) !== null);
      if (foreign) return { workspace: foreign.label, relPath: under(foreign.root, absolute)! };
      return { workspace: lastSegment(parentDirectory(absolute)) };
    };

    const changes: Change[] = turn.changes.map((change) => ({
      ...change,
      ...attribute(change.path),
    }));
    let limited = turn.limited;
    if (turn.patch !== null) {
      const foreign = foreignRowChanges(turn.turnId, turn.patch.length, rows, attribute);
      changes.push(...foreign.changes);
      limited ||= foreign.limited;
    }
    return {
      ...turn,
      changes,
      limited,
      ...(ownLabel ? { workspace: ownLabel } : {}),
    };
  } catch {
    return turn;
  }
}
