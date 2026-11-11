/**
 * The review page's model: one row per Change in the Changes nav, merged
 * from independent sources (each account's inbox on the forge, each host's
 * checkouts from the server's placement table) by a pure function, and the
 * selected Change's header, files and commits. Everything is keyed by
 * ChangeKey, so a pull request with no checkout anywhere reads the same way
 * as one with three.
 */
import { z } from "zod";
import {
  attentionChips,
  chipSchema,
  shipStepSchema,
  sortKey,
  statusLine,
  type ChangeSummary,
} from "./status.ts";
import { changeKeyOf, changeKeySchema, repoSchema, type ChangeKey, type Repo } from "./ids.ts";
import {
  changeKeyForBranch,
  commitSchema,
  filePatchSchema,
  fileChangeSchema,
  problemSchema,
  pullRequestSchema,
  uncommittedCount,
  type Branch,
  type ForgeValue,
  type PullRequest,
  type Stack,
  type WorkspaceValue,
} from "./change.ts";

// ── Identity ───────────────────────────────────────────────────────────

export type ParsedKey =
  | { kind: "gh"; repo: Repo; headOwner: string; branch: string }
  | { kind: "local"; hostId: string; commonDir: string; branch: string };

/** A ChangeKey's parts. Git branch names cannot hold `:`, so the branch is the last segment. */
export function parseChangeKey(key: ChangeKey): ParsedKey | null {
  const parts = key.split(":");
  if (parts[0] === "gh" && parts.length === 4) {
    const [owner, name] = parts[1]!.split("/");
    if (!owner || !name || !parts[2] || !parts[3]) return null;
    return { kind: "gh", repo: { owner, name }, headOwner: parts[2], branch: parts[3] };
  }
  if (parts[0] === "local" && parts.length >= 4) {
    const branch = parts.at(-1)!;
    const commonDir = parts.slice(2, -1).join(":");
    if (!parts[1] || !commonDir || !branch) return null;
    return { kind: "local", hostId: parts[1], commonDir, branch };
  }
  return null;
}

// ── Rows ───────────────────────────────────────────────────────────────

export const rowStateSchema = z.enum(["local", "draft", "open", "merged", "closed"]);
export type RowState = z.infer<typeof rowStateSchema>;

/** Where a Change sits in a stack: 1 is the bottom, which merges first. */
export const stackPlaceSchema = z
  .object({
    /** Stable across reads: the stack's bottom branch on its host. */
    id: z.string(),
    position: z.number().int().positive(),
    size: z.number().int().positive(),
  })
  .strict();
export type StackPlace = z.infer<typeof stackPlaceSchema>;

/**
 * One Change as a list row, from one source. Small (a row stays under 2 KB)
 * and already derived, so the nav, the phone list and the header agree.
 */
export const changeRowSchema = z
  .object({
    key: changeKeySchema,
    /** "owner/name" on GitHub; the checkout's folder name for a local repository. */
    repo: z.string(),
    title: z.string(),
    branch: z.string(),
    baseRef: z.string().nullable(),
    number: z.number().int().positive().nullable(),
    url: z.string().nullable(),
    author: z.string().nullable(),
    state: rowStateSchema,
    /** Opened by the account reading it. */
    mine: z.boolean(),
    /** Review requested from the account reading it. */
    asked: z.boolean(),
    stack: stackPlaceSchema.nullable(),
    /** The host whose checkout has it, for a local source's row. */
    hostId: z.string().nullable(),
    line: z.string(),
    chips: z.array(chipSchema).max(8),
    sort: z.number().int(),
    /** ISO time of the last update the source knows. */
    updatedAt: z.string().nullable(),
  })
  .strict();
export type ChangeRow = z.infer<typeof changeRowSchema>;

/** One source's rows, with when they were read and what went wrong since. */
export const sourceRowsSchema = z
  .object({
    read: z
      .object({ rows: z.array(changeRowSchema).max(500), at: z.number().int().nonnegative() })
      .strict()
      .nullable(),
    problem: problemSchema.nullable(),
  })
  .strict();
export type SourceRows = z.infer<typeof sourceRowsSchema>;

/** The hosts the placement table knows, and the forge accounts: what the nav reads from. */
export const pageSourcesSchema = z
  .object({
    hosts: z.array(z.object({ hostId: z.string(), name: z.string() }).strict()),
    accounts: z.array(z.object({ login: z.string(), active: z.boolean() }).strict()),
  })
  .strict();
export type PageSources = z.infer<typeof pageSourcesSchema>;

// ── Building rows ──────────────────────────────────────────────────────

const ROW_TITLE_MAX = 300;

function derived(summary: ChangeSummary) {
  return {
    line: statusLine(summary),
    chips: attentionChips(summary).slice(0, 8),
    sort: sortKey(summary),
  };
}

function rowState(pr: PullRequest | null | undefined): RowState {
  if (!pr) return "local";
  if (pr.state === "open") return pr.isDraft ? "draft" : "open";
  return pr.state;
}

/** A pull request from an account's inbox as a row. */
export function inboxRow(entry: {
  repo: Repo;
  headOwner: string;
  branch: string;
  author: string | null;
  updatedAt: string | null;
  mine: boolean;
  asked: boolean;
  pullRequest: PullRequest;
}): ChangeRow {
  const pr = entry.pullRequest;
  const key = changeKeyOf(
    { hostId: "", commonDir: "", branch: entry.branch },
    { repo: entry.repo, headOwner: entry.headOwner },
  );
  return {
    key,
    repo: `${entry.repo.owner}/${entry.repo.name}`,
    title: pr.title.slice(0, ROW_TITLE_MAX),
    branch: entry.branch,
    baseRef: pr.baseRef || null,
    number: pr.number,
    url: pr.url,
    author: entry.author,
    state: rowState(pr),
    mine: entry.mine,
    asked: entry.asked,
    stack: null,
    hostId: null,
    ...derived({
      key,
      branch: null,
      onGitHub: true,
      uncommitted: 0,
      conflicted: false,
      pullRequest: pr,
      findings: 0,
    }),
    updatedAt: entry.updatedAt,
  };
}

/** A checkout's folder name, for a repository with no GitHub home. */
const folder = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? path;

/**
 * Every branch of a checkout's workspace as rows, with each branch's pull
 * request from the forge facets the server already holds.
 */
export function workspaceRows(input: {
  hostId: string;
  workspace: WorkspaceValue;
  forgeOf: (key: ChangeKey) => ForgeValue | undefined;
}): ChangeRow[] {
  const { hostId, workspace } = input;
  const repo = workspace.github
    ? `${workspace.github.repo.owner}/${workspace.github.repo.name}`
    : folder(workspace.commonDir.replace(/[\\/]\.git$/, ""));
  const uncommitted = uncommittedCount(workspace);
  return workspace.stacks.flatMap((stack: Stack) =>
    stack.branches.map((branch: Branch, index): ChangeRow => {
      const key = changeKeyForBranch(hostId, workspace, branch);
      const pr = input.forgeOf(key);
      const checkedOut =
        workspace.provider === "git" ? workspace.checkedOut === branch.name : index === 0;
      const summary: ChangeSummary = {
        key,
        branch,
        onGitHub: workspace.github !== null,
        uncommitted: checkedOut ? uncommitted : 0,
        conflicted: branch.status === "conflicted",
        pullRequest: pr,
        findings: 0,
      };
      return {
        key,
        repo,
        title: (pr?.title ?? branch.commits[0]?.subject ?? branch.name).slice(0, ROW_TITLE_MAX),
        branch: branch.name,
        baseRef: pr?.baseRef ?? workspace.target?.ref ?? null,
        number: pr?.number ?? null,
        url: pr?.url ?? null,
        author: null,
        state: rowState(pr),
        // A local branch is the reader's own work.
        mine: true,
        asked: false,
        stack: {
          id: `${hostId}:${workspace.commonDir}:${stack.key}`,
          // Branches are listed top first; the bottom merges first.
          position: stack.branches.length - index,
          size: stack.branches.length,
        },
        hostId,
        ...derived(summary),
        updatedAt: branch.commits[0]?.createdAt ?? null,
      };
    }),
  );
}

// ── Merge ──────────────────────────────────────────────────────────────

export type Filter = "all" | "mine" | "asked";

export type NavRow = ChangeRow & {
  /** Every host whose checkout has it. */
  hosts: string[];
};
export type StackGroup = { id: string; rows: NavRow[] };
export type RepoShelf = {
  repo: string;
  /** Each entry is a stack of two or more, or a single Change. */
  groups: (StackGroup | NavRow)[];
  count: number;
};
export type MergedChanges = {
  shelves: RepoShelf[];
  counts: Record<Filter, number>;
  /** Rows in display order, for keyboard movement and windowing. */
  order: NavRow[];
};

const STATE_RANK: Record<RowState, number> = { local: 0, draft: 1, open: 2, merged: 3, closed: 4 };

/**
 * One row from two: the forge knows the pull request, a checkout knows the
 * stack and the host. Fields one source lacks come from the other.
 */
function combine(a: NavRow, b: ChangeRow): NavRow {
  const forge = a.number !== null ? a : b.number !== null ? b : a;
  const local = a.hostId !== null ? a : b.hostId !== null ? b : a;
  const hosts = b.hostId !== null && !a.hosts.includes(b.hostId) ? [...a.hosts, b.hostId] : a.hosts;
  return {
    ...forge,
    mine: a.mine || b.mine,
    asked: a.asked || b.asked,
    stack: local.stack ?? forge.stack,
    hostId: local.hostId,
    hosts,
    // The row that says more about where the Change is wins the status.
    ...(STATE_RANK[b.state] > STATE_RANK[a.state] || (a.number === null && b.number !== null)
      ? { state: b.state, line: b.line, chips: b.chips, sort: b.sort }
      : {}),
  };
}

const byShipping = (a: NavRow, b: NavRow) =>
  a.sort - b.sort ||
  (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
  a.key.localeCompare(b.key);

function matches(row: NavRow, filter: Filter): boolean {
  if (filter === "mine") return row.mine;
  if (filter === "asked") return row.asked;
  return true;
}

/**
 * Every source's rows as the nav shows them: one row per ChangeKey, grouped
 * by repository and stack, closest to shipping first. A stack keeps its own
 * order, bottom (merges first) at the bottom, and sorts by its most urgent row.
 */
/**
 * The tint of a row's one status line on the phone (board D): problems are
 * red, a review asked of the reader is amber, ready to merge is green, a
 * merged Change is purple; anything that waits on others stays neutral.
 */
export function lineTone(row: Pick<ChangeRow, "chips">): ChangeRow["chips"][number]["tone"] {
  if (row.chips.some((chip) => chip.tone === "error")) return "error";
  if (row.chips.some((chip) => chip.id === "asked")) return "warning";
  if (row.chips.some((chip) => chip.id === "ready")) return "success";
  if (row.chips.some((chip) => chip.id === "merged")) return "merged";
  return "neutral";
}

const ASKED_CHIP = {
  id: "asked",
  label: "Review requested",
  tone: "warning",
  icon: null,
} as const satisfies ChangeRow["chips"][number];

/**
 * An open pull request the reader is asked to review says so after its
 * problems and before its good news (board A); the phone line takes its tone.
 */
function withAsked(row: NavRow): NavRow {
  if (!row.asked || row.state !== "open" || row.chips.some((chip) => chip.id === "asked"))
    return row;
  const at = row.chips.findIndex((chip) => chip.tone !== "error" && chip.tone !== "warning");
  const chips = row.chips.toSpliced(at === -1 ? row.chips.length : at, 0, ASKED_CHIP).slice(0, 8);
  return { ...row, chips };
}

export function mergeChanges(
  sources: readonly (readonly ChangeRow[])[],
  filter: Filter,
): MergedChanges {
  const byKey = new Map<ChangeKey, NavRow>();
  for (const rows of sources)
    for (const row of rows) {
      const seen = byKey.get(row.key);
      byKey.set(
        row.key,
        seen ? combine(seen, row) : { ...row, hosts: row.hostId === null ? [] : [row.hostId] },
      );
    }
  const all = [...byKey.values()].map(withAsked);
  const counts: Record<Filter, number> = {
    all: all.length,
    mine: all.filter((row) => row.mine).length,
    asked: all.filter((row) => row.asked).length,
  };
  const shown = all.filter((row) => matches(row, filter));
  const repos = new Map<string, NavRow[]>();
  for (const row of shown) repos.set(row.repo, [...(repos.get(row.repo) ?? []), row]);
  const shelves: RepoShelf[] = [...repos].map(([repo, rows]) => {
    const stacks = new Map<string, NavRow[]>();
    const singles: NavRow[] = [];
    for (const row of rows) {
      if (row.stack && row.stack.size > 1)
        stacks.set(row.stack.id, [...(stacks.get(row.stack.id) ?? []), row]);
      else singles.push(row);
    }
    const groups: { group: StackGroup | NavRow; first: NavRow }[] = [
      ...[...stacks].map(([id, members]) => {
        const ordered = members.toSorted((a, b) => b.stack!.position - a.stack!.position);
        return { group: { id, rows: ordered }, first: members.toSorted(byShipping)[0]! };
      }),
      ...singles.map((row) => ({ group: row, first: row })),
    ];
    groups.sort((a, b) => byShipping(a.first, b.first));
    return { repo, groups: groups.map((entry) => entry.group), count: rows.length };
  });
  shelves.sort((a, b) => {
    const first = (shelf: RepoShelf) => {
      const group = shelf.groups[0]!;
      return "rows" in group ? group.rows.toSorted(byShipping)[0]! : group;
    };
    return byShipping(first(a), first(b)) || a.repo.localeCompare(b.repo);
  });
  const order = shelves.flatMap((shelf) =>
    shelf.groups.flatMap((group) => ("rows" in group ? group.rows : [group])),
  );
  return { shelves, counts, order };
}

// ── The selected Change ────────────────────────────────────────────────

/** A file of the Change against its base, with its size. */
export const changeFileSchema = z
  .object({
    path: z.string(),
    kind: fileChangeSchema.shape.kind,
    previousPath: z.string().nullable(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
    /**
     * The file's blob at the head: what a guide and a viewed mark are bound
     * to, so they carry across commits that leave the file alone. Null for a
     * deleted file; absent when the source did not say.
     */
    blob: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .nullable()
      .optional(),
  })
  .strict();
export type ChangeFile = z.infer<typeof changeFileSchema>;

/** One pull request in an account's inbox, with where its branch lives. */
export const inboxEntrySchema = z
  .object({
    repo: repoSchema,
    headOwner: z.string().min(1),
    branch: z.string().min(1),
    author: z.string().nullable(),
    updatedAt: z.string().nullable(),
    mine: z.boolean(),
    asked: z.boolean(),
    pullRequest: pullRequestSchema,
  })
  .strict();
export type InboxEntry = z.infer<typeof inboxEntrySchema>;

/** A pull request's file as GitHub lists it, with its hunks when GitHub sent them. */
export const forgeFileSchema = z
  .object({ file: changeFileSchema, patch: filePatchSchema.nullable() })
  .strict();
export type ForgeFile = z.infer<typeof forgeFileSchema>;

/**
 * The exact revision files and patches are read at: immutable, so they are
 * read once per revision and never again. `source` says where from.
 */
export const reviewRevisionSchema = z
  .object({
    head: z.string().min(1),
    base: z.string().min(1),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }).strict(),
      z.object({ kind: z.literal("forge"), number: z.number().int().positive() }).strict(),
    ]),
  })
  .strict();
export type ReviewRevision = z.infer<typeof reviewRevisionSchema>;

export const stackBranchSchema = z
  .object({
    key: changeKeySchema,
    branch: z.string(),
    number: z.number().int().positive().nullable(),
    state: rowStateSchema,
    commits: z.number().int().nonnegative(),
    /** This Change. */
    current: z.boolean(),
  })
  .strict();

/** The review page's header and rail for one Change. */
export const changeDetailSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("missing"), problem: problemSchema.nullable() }).strict(),
  z
    .object({
      state: z.literal("change"),
      row: changeRowSchema,
      head: z.string().nullable(),
      files: z.number().int().nonnegative().nullable(),
      additions: z.number().int().nonnegative().nullable(),
      deletions: z.number().int().nonnegative().nullable(),
      /** The revision Files and Commits read, or null while nothing can say it. */
      revision: reviewRevisionSchema.nullable(),
      /** Top of the stack first, as the rail draws it; null outside a stack. */
      stack: z.array(stackBranchSchema).nullable(),
      /** Mark ready for the owner of a draft: the expected head for the write. */
      canMarkReady: z.boolean(),
      /** `shipPath` of the Change's summary: Committed → Merged, as the header draws it. */
      ship: z.array(shipStepSchema).max(6),
      problem: problemSchema.nullable(),
      at: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type ChangeDetail = z.infer<typeof changeDetailSchema>;

export const filesResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), files: z.array(changeFileSchema), more: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), problem: problemSchema }).strict(),
]);
export type FilesResult = z.infer<typeof filesResultSchema>;

export const commitsResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), commits: z.array(commitSchema), more: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), problem: problemSchema }).strict(),
]);
export type CommitsResult = z.infer<typeof commitsResultSchema>;

// ── Generated files ────────────────────────────────────────────────────

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
]);
const GENERATED = [
  /\.min\.(js|css)$/,
  /\.generated\./,
  /(^|\/)(dist|vendor|__generated__)\//,
  /\.snap$/,
  /\.map$/,
];

/** Lockfiles and generated output start collapsed: their diffs are long and rarely read. */
export function startsCollapsed(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return LOCKFILES.has(name) || GENERATED.some((pattern) => pattern.test(path));
}

// ── Deep links ─────────────────────────────────────────────────────────

export const REVIEW_TABS = ["files", "commits", "conversation"] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];

export type ReviewLocation = {
  key: ChangeKey | null;
  tab: ReviewTab;
  /** A commit, for the Commits tab's file list. */
  commit: string | null;
  path: string | null;
  line: number | null;
};

const EMPTY: ReviewLocation = { key: null, tab: "files", commit: null, path: null, line: null };

/**
 * The panel's subPath, `c/<key>/<tab>[/k/<commit>][/f/<path>[/l/<line>]]`,
 * with each segment percent-encoded as bb hands it over. The key and the
 * path are one segment each, so their own `/` stay encoded.
 */
/** bb's segments decoded, and the key and path once more as `reviewPath` encoded them; null if malformed. */
function decodeSegments(segments: string[]): string[] | null {
  try {
    const decoded = segments.map((segment) => decodeURIComponent(segment));
    decoded[1] = decodeURIComponent(decoded[1]!);
    for (let index = 3; index + 1 < decoded.length; index += 2)
      if (decoded[index] === "f") decoded[index + 1] = decodeURIComponent(decoded[index + 1]!);
    return decoded;
  } catch {
    return null;
  }
}

const lineOf = (value: string) => {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : null;
};

export function parseReviewPath(subPath: string): ReviewLocation {
  const segments = subPath.split("/").filter((segment) => segment !== "");
  if (segments[0] !== "c" || !segments[1]) return EMPTY;
  const decoded = decodeSegments(segments);
  if (!decoded) return EMPTY;
  const key = changeKeySchema.safeParse(decoded[1]);
  if (!key.success) return EMPTY;
  const tab = (REVIEW_TABS as readonly string[]).includes(decoded[2] ?? "")
    ? (decoded[2] as ReviewTab)
    : "files";
  const location: ReviewLocation = { ...EMPTY, key: key.data, tab };
  for (let index = 3; index + 1 < decoded.length; index += 2) {
    const value = decoded[index + 1]!;
    if (decoded[index] === "k") location.commit = value;
    if (decoded[index] === "f") location.path = value;
    if (decoded[index] === "l") location.line = lineOf(value);
  }
  return location;
}

/**
 * The unencoded subPath for a location, as `toPluginPanel` takes it: bb
 * splits on `/` and encodes each segment, so the key and path, which hold
 * `/`, are encoded here first and survive as one segment each.
 */
export function reviewPath(location: Partial<ReviewLocation> & { key: ChangeKey }): string {
  const parts = ["c", encodeURIComponent(location.key), location.tab ?? "files"];
  if (location.commit) parts.push("k", location.commit);
  if (location.path) {
    parts.push("f", encodeURIComponent(location.path));
    if (location.line) parts.push("l", String(location.line));
  }
  return parts.join("/");
}
