import { join } from "node:path";
import { loadCase } from "./lib/cases.ts";
import { scoreRun, type CriteriaResult } from "./lib/criteria.ts";
import {
  attemptDir,
  readJson,
  readText,
  runDir,
  writeJson,
  type AttemptMeta,
  type RunMeta,
} from "./lib/store.ts";

export type RunScore = {
  runId: string;
  variant: string;
  variantHash: string;
  model: string;
  judged: boolean;
  runs: number;
  embedScore: number;
  cleanRuns: number;
  necessity: number;
  rangeFits: number;
  placement: number;
  coverage: number;
  budget: number;
  timeouts: number;
  meanCostUsd: number;
  totalCostUsd: number;
  perCase: Array<{ caseId: string; pass: number; of: number; notes: string[] }>;
};

function rate(values: Array<boolean | null>): number {
  const applicable = values.filter((value) => value !== null) as boolean[];
  if (applicable.length === 0) return 1;
  return applicable.filter(Boolean).length / applicable.length;
}

export async function scoreRunId(runId: string): Promise<RunScore> {
  const meta = await readJson<RunMeta>(join(runDir(runId), "meta.json"));
  if (meta === null) throw new Error(`no run at ${runId}`);
  const judgments = await readJson<{ verdicts: Record<string, boolean> }>(
    join(runDir(runId), "judgments.json"),
  );
  const verdicts = new Map(Object.entries(judgments?.verdicts ?? {}));

  const results: CriteriaResult[] = [];
  const perCase: RunScore["perCase"] = [];
  let timeouts = 0;
  let cost = 0;
  let attempts = 0;

  for (const caseId of meta.caseIds) {
    const evalCase = await loadCase(caseId);
    const caseResults: CriteriaResult[] = [];
    for (let rep = 1; rep <= meta.reps; rep += 1) {
      const dir = attemptDir(runId, caseId, rep);
      const attemptMeta = await readJson<AttemptMeta>(join(dir, "meta.json"));
      if (attemptMeta === null) continue;
      attempts += 1;
      cost += attemptMeta.costUsd;
      if (attemptMeta.timedOut) timeouts += 1;
      const result = scoreRun(
        evalCase,
        {
          caseId,
          rep,
          timedOut: attemptMeta.timedOut,
          response: await readText(join(dir, "result.md")),
          diff: await readText(join(dir, "diff.patch")),
        },
        verdicts,
      );
      caseResults.push(result);
      results.push(result);
    }
    perCase.push({
      caseId,
      pass: caseResults.filter((one) => one.pass).length,
      of: caseResults.length,
      notes: [...new Set(caseResults.flatMap((one) => one.notes))],
    });
  }

  return {
    runId,
    variant: meta.variant,
    variantHash: meta.variantHash,
    model: meta.model,
    judged: judgments !== null,
    runs: results.length,
    embedScore:
      results.length === 0
        ? 0
        : results.reduce((sum, one) => sum + one.score, 0) / results.length,
    cleanRuns:
      results.length === 0 ? 0 : results.filter((one) => one.pass).length / results.length,
    necessity: rate(results.map((one) => one.necessity)),
    rangeFits: rate(results.map((one) => one.rangeFits)),
    placement: rate(results.map((one) => one.placement)),
    coverage: rate(results.map((one) => one.coverage)),
    budget: rate(results.map((one) => one.budget)),
    timeouts,
    meanCostUsd: attempts === 0 ? 0 : cost / attempts,
    totalCostUsd: cost,
    perCase,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

if (process.argv[1]?.endsWith("score.ts") === true) {
  const runIds = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  if (runIds.length === 0) throw new Error("pass one or more run ids");
  for (const runId of runIds) {
    const score = await scoreRunId(runId);
    await writeJson(join(runDir(runId), "score.json"), score);
    console.log(
      `\n${score.runId}  variant=${score.variant}@${score.variantHash} judged=${score.judged}`,
    );
    console.log(
      `  embed-score ${percent(score.embedScore)}  clean ${percent(score.cleanRuns)}  necessity ${percent(score.necessity)}  range-fits ${percent(score.rangeFits)}  placement ${percent(score.placement)}`,
    );
    console.log(
      `  coverage ${percent(score.coverage)}  budget ${percent(score.budget)}  timeouts ${score.timeouts}  mean $${score.meanCostUsd.toFixed(3)}  total $${score.totalCostUsd.toFixed(2)}`,
    );
    for (const one of score.perCase) {
      console.log(`   ${one.caseId.padEnd(22)} ${one.pass}/${one.of}  ${one.notes.join("; ")}`);
    }
  }
}
