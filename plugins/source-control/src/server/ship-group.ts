/**
 * Ship all on a grouped card: one message to the thread naming every Change
 * on it, for its agent to ship. Ported from code-review
 * (`src/server/rpc/ship-group-prompt.ts`, `instructions/ship-group.md`).
 * Merge all is not this: the card merges each pull request itself.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import type { GroupEntry } from "../core/directive.ts";
import { parseChangeKey, type ChangeDetail } from "../core/review.ts";
import type { ChangeKey } from "../core/ids.ts";
import { message } from "./host-calls.ts";

const files = instructionFiles(import.meta.url);

/** One Change as the agent needs it to ship: where it is and the head the card showed. */
function describe(entry: GroupEntry, detail: ChangeDetail | undefined) {
  const parsed = parseChangeKey(entry.key);
  if (detail?.state !== "change")
    return { change: entry.key, head: entry.revision, note: "Source Control could not read it." };
  const { row } = detail;
  const head = detail.head ?? entry.revision;
  if (row.number !== null && parsed?.kind === "gh")
    return {
      pullRequest: `${row.repo}#${row.number}`,
      url: row.url,
      branch: row.branch,
      base: row.baseRef,
      head,
    };
  return {
    branch: row.branch,
    repository: row.repo,
    ...(parsed?.kind === "local" ? { hostId: parsed.hostId, gitDir: parsed.commonDir } : {}),
    head,
  };
}

export function shipGroupPrompt(
  entries: readonly GroupEntry[],
  details: Readonly<Record<string, ChangeDetail>>,
): string {
  const changes = entries.map((entry) => describe(entry, details[entry.key]));
  return files.read("ship-group", { changes: JSON.stringify({ changes }, null, 2) });
}

export function createShipGroup(deps: {
  bb: BbPluginApi;
  detail: (keys: readonly ChangeKey[]) => Readonly<Record<string, ChangeDetail>>;
}) {
  return async function shipGroup(
    threadId: string,
    entries: readonly GroupEntry[],
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const text = shipGroupPrompt(entries, deps.detail(entries.map((entry) => entry.key)));
      await deps.bb.sdk.threads.send({
        threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text, mentions: [] }],
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: message(error) };
    }
  };
}
