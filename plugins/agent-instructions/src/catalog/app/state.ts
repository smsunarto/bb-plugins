import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useCallback, useSyncExternalStore } from "react";
import type { CatalogListing, PublishOutcome } from "../contract.ts";

/** Routing, unsaved drafts, and publish facts shared by the catalog sidebar and page. */

export const PANEL_PATH = "instructions";

export type Skill = CatalogListing["skills"][number];

export type Doc = CatalogListing["docs"][number];

export type Deleted = CatalogListing["deleted"][number];

/** What the page edits: a global instructions doc, or one file of a skill. */
export type CatalogSelection = { doc: string } | { skill: string; path: string };

/**
 * The URL is the selection, so the page and its sidebar agree:
 * `global/docs/<id>` or `global/skills/<name>/<path>`. bb encodes each segment when
 * navigating and hands them back encoded, so `imported:shared` arrives as `imported%3Ashared`.
 * Anything else under `global`, such as an old source-file link, opens the overview.
 */
export function parseCatalogRoute(subPath: string): CatalogSelection | null {
  let parts: string[];
  try {
    parts = subPath.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  const [root, kind, key, ...rest] = parts;
  if (root !== "global" || !key) return null;
  if (kind === "docs" && rest.length === 0) return { doc: key };
  if (kind === "skills") return { skill: key, path: rest.length > 0 ? rest.join("/") : "SKILL.md" };
  return null;
}

export function catalogRoute(selection: CatalogSelection | null): string {
  if (selection === null) return "global";
  return "doc" in selection
    ? `global/docs/${selection.doc}`
    : `global/skills/${selection.skill}/${selection.path}`;
}

export function useGo(): (selection: CatalogSelection | null) => void {
  const navigate = useBbNavigate();
  return useCallback(
    (selection) => navigate.toPluginPanel(PANEL_PATH, { subPath: catalogRoute(selection) }),
    [navigate],
  );
}

export const sameSelection = (a: CatalogSelection | null, b: CatalogSelection) =>
  a !== null &&
  ("doc" in a && "doc" in b
    ? a.doc === b.doc
    : "skill" in a && "skill" in b && a.skill === b.skill && a.path === b.path);

/**
 * Unsaved text and the saved version it was typed over. Saving sends `baseSha`
 * as the expected version, so an edit made elsewhere is never overwritten silently.
 */
export type Draft = { base: string; baseSha: string | null; text: string };

export type DraftUpdate = (draft: Draft | undefined) => Draft | undefined;

export const draftKey = (selection: CatalogSelection) =>
  "doc" in selection
    ? `doc\u0000${selection.doc}`
    : `skill\u0000${selection.skill}\u0000${selection.path}`;

/** Unsaved edits for the app session. The page edits them; the sidebar marks them. */
let drafts: ReadonlyMap<string, Draft> = new Map();

/**
 * Which files have drafts. Replaced only when a file gains or loses its draft,
 * so typing re-renders the open editor but not the sidebar.
 */
let draftKeys: ReadonlySet<string> = new Set();

/** The text each running save is storing, by draft key. */
const saving = new Map<string, string>();

const draftListeners = new Set<() => void>();

export function resetCatalogDraftsForTest(): void {
  saving.clear();
  setDrafts(new Map());
  flash = null;
}

function subscribeDrafts(listener: () => void) {
  draftListeners.add(listener);
  return () => void draftListeners.delete(listener);
}

export function useDrafts(): ReadonlyMap<string, Draft> {
  return useSyncExternalStore(subscribeDrafts, () => drafts);
}

export function useDraftKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeDrafts, () => draftKeys);
}

function setDrafts(next: ReadonlyMap<string, Draft>) {
  drafts = next;
  if (next.size !== draftKeys.size || [...next.keys()].some((key) => !draftKeys.has(key)))
    draftKeys = new Set(next.keys());
  for (const listener of draftListeners) listener();
}

/** Marks the text a save is storing, or clears it when the save ends. */
export function setSaving(key: string, text: string | undefined): void {
  if (text === undefined) saving.delete(key);
  else saving.set(key, text);
}

/**
 * The draft after typing `text` over `base`. Typing back to the saved text drops
 * the draft, unless a save of other text is running: then that save would
 * replace the file, so the typed text is still unsaved.
 */
export function typed(key: string, text: string, base: string, baseSha: string | null) {
  const pending = saving.get(key);
  const clean = text === base && (pending === undefined || pending === text);
  return clean ? undefined : { base, baseSha, text };
}

export function updateDraft(key: string, update: DraftUpdate) {
  const current = drafts.get(key);
  const draft = update(current);
  if (draft === current) return;
  const next = new Map(drafts);
  if (draft === undefined) next.delete(key);
  else next.set(key, draft);
  setDrafts(next);
}

export function dropSkillDrafts(skill: string) {
  const prefix = `skill\u0000${skill}\u0000`;
  setDrafts(new Map([...drafts].filter(([key]) => !key.startsWith(prefix))));
}

/**
 * Paths with an unsaved draft in a skill, including files that do not exist yet,
 * joined by NUL so an unchanged list compares equal across renders.
 */
export function draftPaths(keys: ReadonlySet<string>, skill: string): string {
  const prefix = `skill\u0000${skill}\u0000`;
  return [...keys]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .join("\u0000");
}

/** A message for the overview after the page it belongs to went away, such as a deleted skill. */
let flash: Flash | null = null;
type Flash = { tone: "good" | "warn"; lines: string[] };

export function setFlash(next: Flash): void {
  flash = next;
}

/** The pending flash message, once. */
export function takeFlash(): Flash | null {
  const shown = flash;
  flash = null;
  return shown;
}

/** Per skill, why the last publish left it out, if it did. */
export function publishTrouble(published: PublishOutcome | null, name: string): string | null {
  if (published === null || !published.ok) return null;
  if (published.report.conflicts.includes(`skills/${name}`))
    return `skills/${name} already exists in bb's user skills and this plugin did not make it, so it was left alone`;
  const failed = published.report.failed.find((f) => f.name === name);
  return failed ? `Not published: ${failed.error}` : null;
}

export function publishState(published: PublishOutcome | null): {
  text: string;
  tone?: "bad" | "warn";
} {
  if (published === null) return { text: "Not published since bb started", tone: "warn" };
  if (!published.ok) return { text: "Publish failed", tone: "bad" };
  const problems = published.problems.length;
  if (problems > 0)
    return { text: `${problems} publish problem${problems === 1 ? "" : "s"}`, tone: "bad" };
  return { text: "Published" };
}
