/**
 * The guided diff: an agent-written reading order for one Change, bound to
 * the revision it was written for, and the derived order that stands in
 * until it lands. `resolveGuide` lays either over the files of whatever head
 * the reader has, so a guide survives commits that leave its files alone.
 */
import { z } from "zod";
import { changeKeySchema } from "./ids.ts";
import { problemSchema } from "./change.ts";
import { startsCollapsed, type ChangeFile } from "./review.ts";

const HEX = /^[0-9a-f]{4,64}$/i;

export const guideFileSchema = z
  .object({
    path: z.string().min(1),
    /** The file's blob when the guide was written; null when the source did not say. */
    blob: z.string().nullable(),
    /** One line on what the file does in this change. */
    note: z.string().max(300).nullable(),
  })
  .strict();
export type GuideFile = z.infer<typeof guideFileSchema>;

export const guideGroupSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(120),
    intro: z.string().max(1200),
    files: z.array(guideFileSchema).min(1).max(3000),
  })
  .strict();
export type GuideGroup = z.infer<typeof guideGroupSchema>;

export const guideSchema = z
  .object({
    changeKey: changeKeySchema,
    /** The head the guide was written for. */
    revision: z.string().regex(HEX),
    /** A few sentences on the whole change: where the risk is, what to skim. */
    summary: z.string().max(1200).nullable(),
    groups: z.array(guideGroupSchema).max(40),
  })
  .strict();
export type Guide = z.infer<typeof guideSchema>;

/** The store's row: none until the review page first opens, then one run per Change. */
export const guideStateSchema = z.enum(["none", "running", "done", "failed"]);
export type GuideState = z.infer<typeof guideStateSchema>;

/** What the page draws for the run: `waiting` is a run held back by the per-server limit. */
export const guidePhaseSchema = z.enum(["none", "waiting", "writing", "done", "failed"]);
export type GuidePhase = z.infer<typeof guidePhaseSchema>;

export const viewedSchema = z.object({ path: z.string(), blob: z.string() }).strict();
export type Viewed = z.infer<typeof viewedSchema>;

/** One Change's guide as every surface reads it. */
export const guideViewSchema = z
  .object({
    state: guideStateSchema,
    phase: guidePhaseSchema,
    /** The hidden thread writing it, while it runs or once it failed. */
    threadId: z.string().nullable(),
    /** The head the run was started for. */
    revision: z.string().nullable(),
    guide: guideSchema.nullable(),
    /** Why the run failed, or why none can start. */
    problem: problemSchema.nullable(),
    /** Files marked viewed, each at the blob it had then. */
    viewed: z.array(viewedSchema).max(10_000),
  })
  .strict();
export type GuideView = z.infer<typeof guideViewSchema>;

export const EMPTY_GUIDE_VIEW: GuideView = {
  state: "none",
  phase: "none",
  threadId: null,
  revision: null,
  guide: null,
  problem: null,
  viewed: [],
};

/**
 * The blob a viewed mark is stored under: the file's head blob, or `deleted`.
 * Null when the source did not say, so such a file cannot be marked.
 */
export function viewedBlob(file: Pick<ChangeFile, "blob">): string | null {
  if (file.blob === undefined) return null;
  return file.blob ?? "deleted";
}

const markKey = (path: string, blob: string) => `${path}\u0000${blob}`;

// ── Reading order ──────────────────────────────────────────────────────

/** Lockfiles and generated output last, then by path, as code-review's reading order puts them. */
export function readingOrder<F extends Pick<ChangeFile, "path">>(files: readonly F[]): F[] {
  return files.toSorted(
    (a, b) =>
      Number(startsCollapsed(a.path)) - Number(startsCollapsed(b.path)) ||
      a.path.localeCompare(b.path),
  );
}

export type ResolvedFile = ChangeFile & { note: string | null };

export type ResolvedGroup = {
  id: string;
  title: string;
  intro: string | null;
  /** Not from the guide: the derived order, or files the guide does not cover at this head. */
  derived: boolean;
  files: ResolvedFile[];
};

export type ResolvedGuide = {
  /** `derived` with no guide; `guide` as written; `carried` from an earlier head. */
  source: "derived" | "guide" | "carried";
  summary: string | null;
  groups: ResolvedGroup[];
};

export const CHANGED_GROUP = "changed-since-guide";
export const UNGUIDED_GROUP = "not-in-guide";
export const GENERATED_GROUP = "generated";

const asResolved = (file: ChangeFile, note: string | null = null): ResolvedFile => ({
  ...file,
  note,
});

/** Today's order: reviewable files, then generated files and lockfiles. */
function derivedGroups(files: readonly ChangeFile[]): ResolvedGroup[] {
  const ordered = readingOrder(files);
  const generated = ordered.filter((file) => startsCollapsed(file.path));
  const rest = ordered.filter((file) => !startsCollapsed(file.path));
  return [
    {
      id: "files",
      title: "Files",
      intro: null,
      derived: true,
      files: rest.map((f) => asResolved(f)),
    },
    {
      id: GENERATED_GROUP,
      title: "Generated files and lockfiles",
      intro: null,
      derived: true,
      files: generated.map((f) => asResolved(f)),
    },
  ].filter((group) => group.files.length > 0);
}

/** Whether the guide's file is this head's file unchanged. */
function unchanged(written: GuideFile, file: ChangeFile, sameHead: boolean): boolean {
  if (sameHead) return true;
  return written.blob !== null && file.blob !== undefined && written.blob === file.blob;
}

/**
 * The reading order for `files` at `head`. With no guide, the derived order.
 * With a guide for this head, its groups as written; files it leaves out
 * follow in a derived group. With a guide for another head, each group keeps
 * the files whose blob is unchanged; changed and new files fall into a
 * derived "Changed since the guide" group; deleted files drop out, and so do
 * groups left empty.
 */
export function resolveGuide(
  guide: Guide | null,
  files: readonly ChangeFile[],
  head: string | null,
): ResolvedGuide {
  if (!guide || guide.groups.length === 0)
    return { source: "derived", summary: null, groups: derivedGroups(files) };
  const sameHead = head !== null && guide.revision === head;
  const byPath = new Map(files.map((file) => [file.path, file]));
  const placed = new Set<string>();
  const groups = guide.groups.flatMap((group): ResolvedGroup[] => {
    const kept = keptFiles(group, byPath, placed, sameHead);
    return kept.length > 0
      ? [{ id: group.id, title: group.title, intro: group.intro, derived: false, files: kept }]
      : [];
  });
  const rest = readingOrder(files.filter((file) => !placed.has(file.path)));
  if (rest.length > 0) groups.push(restGroup(rest, sameHead));
  return { source: sameHead ? "guide" : "carried", summary: guide.summary, groups };
}

/** The group's files this head still has unchanged, each placed once across the guide. */
function keptFiles(
  group: GuideGroup,
  byPath: ReadonlyMap<string, ChangeFile>,
  placed: Set<string>,
  sameHead: boolean,
): ResolvedFile[] {
  const kept: ResolvedFile[] = [];
  for (const written of group.files) {
    const file = byPath.get(written.path);
    if (!file || placed.has(file.path) || !unchanged(written, file, sameHead)) continue;
    placed.add(file.path);
    kept.push(asResolved(file, written.note));
  }
  return kept;
}

/** Files the guide does not place: left out at its head, or changed since. */
function restGroup(rest: readonly ChangeFile[], sameHead: boolean): ResolvedGroup {
  return {
    id: sameHead ? UNGUIDED_GROUP : CHANGED_GROUP,
    title: sameHead ? "Not in the guide" : "Changed since the guide",
    intro: null,
    derived: true,
    files: rest.map((file) => asResolved(file)),
  };
}

/** Viewed files at this head: a mark counts only for the blob it was made on. */
export function viewedAtHead(
  files: readonly ChangeFile[],
  viewed: readonly { path: string; blob: string }[],
): Set<string> {
  const marks = new Set(viewed.map((mark) => markKey(mark.path, mark.blob)));
  return new Set(
    files
      .filter((file) => {
        const blob = viewedBlob(file);
        return blob !== null && marks.has(markKey(file.path, blob));
      })
      .map((file) => file.path),
  );
}

/** The derived order's file paths, the order every client paints first. */
export function derivedPaths(files: readonly ChangeFile[]): string[] {
  return derivedGroups(files).flatMap((group) => group.files.map((file) => file.path));
}
