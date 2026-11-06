/**
 * Handoffs start a fresh top-level thread with no structural link to the thread
 * they continue (no parent or source id), so recognise the two shapes BB uses:
 *
 * - BB's native "Continue in new thread": the first message starts with
 *   `Continue from @thread:<id>` (client-core buildThreadHandoffPromptDraft).
 * - The `handoff` plugin (`bb handoff`): the first message attaches
 *   `handoff-<id>-<timestamps>.md`.
 *
 * Only the leading text is trusted; a mention later in a message is not a handoff.
 */
const NATIVE_PREFIX = /^\s*Continue from @thread:([A-Za-z0-9_-]+)/;
const HANDOFF_FILE = /^handoff-(.+?)-\d{10,}/;

type HandoffBlock = { type: string; text?: string; path?: string; name?: string };

export function handoffSourceFromText(text: string | null | undefined): string | null {
  return text?.match(NATIVE_PREFIX)?.[1] ?? null;
}

export function handoffSourceThreadId(
  blocks: readonly HandoffBlock[],
  originPluginId: string | null | undefined,
): string | null {
  const firstText = blocks.find((block) => block.type === "text" && block.text?.trim());
  const native = handoffSourceFromText(firstText?.text);
  if (native) return native;
  if (originPluginId !== "handoff") return null;
  for (const block of blocks) {
    if (block.type !== "localFile") continue;
    const file = (block.name ?? block.path ?? "").split("/").pop() ?? "";
    const match = file.match(HANDOFF_FILE)?.[1];
    if (match) return match;
  }
  return null;
}
