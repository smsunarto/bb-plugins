import { scoreRunId, type RunScore } from "./score.ts";

const ROWS: Array<{ label: string; read: (score: RunScore) => string }> = [
  { label: "embed-score", read: (score) => percent(score.embedScore) },
  { label: "clean runs", read: (score) => percent(score.cleanRuns) },
  { label: "necessity", read: (score) => percent(score.necessity) },
  { label: "range-fits", read: (score) => percent(score.rangeFits) },
  { label: "placement", read: (score) => percent(score.placement) },
  { label: "coverage (gate)", read: (score) => percent(score.coverage) },
  { label: "budget (gate)", read: (score) => percent(score.budget) },
  { label: "timeouts", read: (score) => String(score.timeouts) },
  { label: "mean cost", read: (score) => `$${score.meanCostUsd.toFixed(3)}` },
];

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

const runIds = process.argv.slice(2).filter((value) => !value.startsWith("--"));
if (runIds.length === 0) throw new Error("pass one or more run ids");
const scores = await Promise.all(runIds.map(scoreRunId));
const columns = scores.map((score) => `${score.variant} (${score.model})`);
const width = Math.max(...columns.map((one) => one.length), 15);

console.log(`| criterion       | ${columns.map((one) => one.padEnd(width)).join(" | ")} |`);
console.log(`| --------------- | ${columns.map(() => "-".repeat(width)).join(" | ")} |`);
for (const row of ROWS) {
  console.log(
    `| ${row.label.padEnd(15)} | ${scores.map((score) => row.read(score).padEnd(width)).join(" | ")} |`,
  );
}
console.log(`\nruns: ${scores.map((score) => `${score.variant}=${score.runId}`).join("  ")}`);
