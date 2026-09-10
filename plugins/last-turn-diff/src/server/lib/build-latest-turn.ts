import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LatestTurn } from "../../shared/contract.ts";

type Row = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["timelineTurnSummaryDetails"]>
>["rows"][number];
const MAX_PATCH_CHARS = 1_000_000;
const MAX_CHANGES = 200;

export function buildLatestTurn(
  turnId: string,
  sourceRows: Row[],
  patch: string | null,
  timelineRows: Row[],
): LatestTurn {
  const rows = sourceRows.filter((row) => row.turnId === turnId);
  const oversized = patch !== null && patch.length > MAX_PATCH_CHARS;
  const result: LatestTurn = {
    turnId,
    anchorId: findTurnAnchor(turnId, timelineRows),
    patch: oversized || !patch?.trim() ? null : patch,
    changes: [],
    limited: oversized,
  };
  if (result.patch !== null) return result;
  let remaining = MAX_PATCH_CHARS;
  // Keep successive edits distinct. Concatenating them would invent a net patch.
  for (const row of rows) {
    if (
      row.kind !== "work" ||
      row.workKind !== "file-change" ||
      row.status !== "completed" ||
      row.approvalStatus === "denied"
    )
      continue;
    if (result.changes.length >= MAX_CHANGES) {
      result.limited = true;
      break;
    }
    let text = row.change.diff;
    if (text !== null && text.length > remaining) {
      text = null;
      result.limited = true;
    }
    remaining -= text?.length ?? 0;
    result.changes.push({
      id: row.id,
      path: row.change.path,
      patch: text,
      ...row.change.diffStats,
    });
  }
  return result;
}

export function findTurnAnchor(turnId: string, rows: Row[]): string | null {
  return (
    [...rows]
      .reverse()
      .find(
        (row) => row.turnId === turnId && row.kind === "conversation" && row.role === "assistant",
      )?.id ?? null
  );
}
