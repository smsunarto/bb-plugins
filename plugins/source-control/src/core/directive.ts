/**
 * The chat card's directive: `::source-control{key="…" revision="…"}`. It
 * names the Change and the head it was shared at, nothing else; the card reads
 * everything it shows from the server.
 */
import { changeKeySchema, type ChangeKey } from "./ids.ts";

export const DIRECTIVE_ID = "source-control";

const HEAD = /^[0-9a-f]{4,64}$/i;

export function shareDirective(key: ChangeKey, revision: string | null): string {
  const attributes = [`key="${encodeURIComponent(key)}"`];
  if (revision && HEAD.test(revision)) attributes.push(`revision="${revision}"`);
  return `::${DIRECTIVE_ID}{${attributes.join(" ")}}`;
}

/** A directive's attributes as a Change and revision; null when they name none. */
export function parseDirective(attributes: Readonly<Record<string, string | undefined>>): {
  key: ChangeKey;
  revision: string | null;
} | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(attributes.key ?? "");
  } catch {
    return null;
  }
  const key = changeKeySchema.safeParse(decoded);
  if (!key.success) return null;
  const revision = attributes.revision;
  return { key: key.data, revision: revision && HEAD.test(revision) ? revision : null };
}

/** One Change of a grouped card, at the head it was shared at. */
export type GroupEntry = { key: ChangeKey; revision: string | null };

export const MAX_GROUP = 25;

/** Several Changes as one card: `::source-control{changes="<encoded JSON [[key, revision], …]>"}`. */
export function groupDirective(entries: readonly GroupEntry[]): string {
  const list = entries.map(({ key, revision }) => [
    key,
    revision && HEAD.test(revision) ? revision : null,
  ]);
  return `::${DIRECTIVE_ID}{changes="${encodeURIComponent(JSON.stringify(list))}"}`;
}

/** A grouped card's Changes: 2 to 25 distinct valid keys, else null. */
export function parseGroup(
  attributes: Readonly<Record<string, string | undefined>>,
): GroupEntry[] | null {
  if (attributes.changes === undefined) return null;
  let list: unknown;
  try {
    list = JSON.parse(decodeURIComponent(attributes.changes));
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length < 2 || list.length > MAX_GROUP) return null;
  const entries: GroupEntry[] = [];
  for (const item of list) {
    if (!Array.isArray(item)) return null;
    const [rawKey, rawRevision] = item as unknown[];
    const key = changeKeySchema.safeParse(rawKey);
    if (!key.success) return null;
    const revision = typeof rawRevision === "string" && HEAD.test(rawRevision) ? rawRevision : null;
    entries.push({ key: key.data, revision });
  }
  return new Set(entries.map((entry) => entry.key)).size === entries.length ? entries : null;
}
