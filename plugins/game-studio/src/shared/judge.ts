import { z } from "zod";
import { agentSelection } from "./generation.ts";
import type { CanvasNode } from "./schema.ts";
import { nodeTakes, takeRun } from "./takes.ts";

/** The node kinds whose outputs a judge can choose between. */
export const judgeable = (kind: CanvasNode["type"]) => kind === "image";

/** A node's judge setting: off, or on with the agent and the criteria it chooses by. */
export const judgeSettings = z.object({
  enabled: z.boolean(),
  agent: agentSelection.optional(),
  criteria: z.string().max(4000).optional(),
});
export type JudgeSettings = z.output<typeof judgeSettings>;

/** One finished judgement between some of the node's outputs, oldest first in `data.judgements`. */
export const judgeRecord = z.object({
  /** The candidates it chose between, as asset ids in the order the judge saw them. */
  assetIds: z.array(z.string().min(1)).min(2),
  jobId: z.string(),
  text: z.string(),
  /** The candidate it chose; absent when its answer named none. */
  choice: z.string().optional(),
  /** Whether the choice became the node's pick, which it does unless the pick changed meanwhile. */
  applied: z.boolean().optional(),
});
export type JudgeRecord = z.output<typeof judgeRecord>;
/** Judgements kept per node; older ones fall off. */
export const judgeLimit = 20;
/** The most outputs one judgement compares, so every candidate fits beside the run's inputs. */
export const judgeCandidateLimit = 12;

export function nodeJudgeSettings(node: Pick<CanvasNode, "data">): JudgeSettings | undefined {
  const parsed = judgeSettings.safeParse(node.data.judge);
  return parsed.success ? parsed.data : undefined;
}

export function nodeJudgements(node: Pick<CanvasNode, "data">): JudgeRecord[] {
  const parsed = z.array(z.unknown()).safeParse(node.data.judgements);
  return (parsed.success ? parsed.data : []).flatMap((raw) => {
    const record = judgeRecord.safeParse(raw);
    return record.success ? [record.data] : [];
  });
}

/** The candidate a judgement names on its first line, per instructions/canvas-judge.md. */
export function judgeChoice(text: string, candidates: string[]) {
  const first = text.trimStart().split("\n", 1)[0] ?? "";
  const index = /\*\*\s*pick\s*:\s*candidate\s+(\d+)\s*\*\*/i.exec(first)?.[1];
  return index ? candidates[Number(index) - 1] : undefined;
}

/** The request id of the judgement that follows a run, so a repeated adoption judges it once. */
export const judgeRequestId = (runId: string) => `${runId.slice(0, 93)}-judge`;

/**
 * What a judgement after a run compares: the run's outputs against the node's current pick, so
 * a run of one still has to beat what the node already uses. Fewer than two means no judgement.
 */
export function runCandidates(node: Pick<CanvasNode, "data">, runId: string) {
  const fresh = nodeTakes(node)
    .filter((take) => takeRun(take.jobId) === runId)
    .map((take) => take.assetId);
  const pick = typeof node.data.assetId === "string" ? node.data.assetId : undefined;
  const ids = pick && !fresh.includes(pick) ? [pick, ...fresh] : fresh;
  return ids.slice(-judgeCandidateLimit);
}

/** What "Judge now" compares: the shortlist when it holds two or more, else every take. */
export function manualCandidates(node: Pick<CanvasNode, "data">) {
  const takes = nodeTakes(node);
  const starred = takes.filter((take) => take.star);
  return (starred.length >= 2 ? starred : takes)
    .map((take) => take.assetId)
    .slice(-judgeCandidateLimit);
}
