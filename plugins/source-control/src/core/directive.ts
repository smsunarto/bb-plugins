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
