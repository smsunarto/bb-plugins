export interface ThreadSection {
  id: string;
  name: string;
}

/** Resolve a user-facing section name or an exact section ID. */
export function resolveThreadSectionId(
  configured: string,
  sections: ThreadSection[],
): string | undefined {
  const value = configured.trim();
  if (value.length === 0) return undefined;

  const match = sections.find((section) => section.id === value || section.name === value);
  if (match !== undefined) return match.id;

  const available = sections.map((section) => section.name).join(", ");
  throw new Error(`no thread section named '${value}'. Available: ${available || "(none)"}`);
}
