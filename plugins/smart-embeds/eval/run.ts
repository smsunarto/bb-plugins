import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driftDir, fixtureDir, loadCases, type EvalCase } from "./lib/cases.ts";
import { runClaude } from "./lib/claude.ts";
import { run } from "./lib/proc.ts";
import {
  attemptDir,
  hashText,
  promptPath,
  runDir,
  writeJson,
  writeText,
  type AttemptMeta,
  type RunMeta,
} from "./lib/store.ts";

const TIMEOUT_MS = 300_000;
const MAX_TURNS = 40;

type Options = {
  variant: string;
  reps: number;
  model: string;
  concurrency: number;
  cases: string[];
  keep: boolean;
};

function options(argv: string[]): Options {
  const parsed: Options = {
    variant: "baseline",
    reps: 3,
    model: "sonnet",
    concurrency: 6,
    cases: [],
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--variant" && value !== undefined) parsed.variant = value;
    else if (flag === "--reps" && value !== undefined) parsed.reps = Number(value);
    else if (flag === "--model" && value !== undefined) parsed.model = value;
    else if (flag === "--concurrency" && value !== undefined) parsed.concurrency = Number(value);
    else if (flag === "--case" && value !== undefined) parsed.cases.push(value);
    else if (flag === "--keep") parsed.keep = true;
  }
  return parsed;
}

async function shell(command: string[], cwd: string): Promise<string> {
  return run(command[0]!, command.slice(1), cwd);
}

async function stageWorkspace(evalCase: EvalCase): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${evalCase.project}-`));
  await shell(["cp", "-R", `${fixtureDir(evalCase.id)}/.`, dir], dir);
  await shell(["git", "init", "-q", "-b", "main"], dir);
  await shell(["git", "add", "-A"], dir);
  await shell(
    [
      "git",
      "-c",
      "user.name=Dana Whitfield",
      "-c",
      "user.email=dana@example.com",
      "commit",
      "-q",
      "-m",
      "import project sources",
    ],
    dir,
  );
  const drift = driftDir(evalCase.id);
  if (drift !== null) await shell(["cp", "-R", `${drift}/.`, dir], dir);
  return dir;
}

async function attempt(
  runId: string,
  evalCase: EvalCase,
  rep: number,
  appendix: string,
  model: string,
  keep: boolean,
): Promise<AttemptMeta> {
  const dir = await stageWorkspace(evalCase);
  try {
    const result = await runClaude({
      cwd: dir,
      model,
      prompt: evalCase.prompt,
      systemPromptAppendix: appendix,
      maxTurns: MAX_TURNS,
      timeoutMs: TIMEOUT_MS,
    });
    await shell(["git", "add", "-AN"], dir);
    const diff = await shell(["git", "diff", "-U0"], dir);
    const target = attemptDir(runId, evalCase.id, rep);
    await writeText(join(target, "result.md"), result.response);
    await writeText(join(target, "diff.patch"), diff);
    if (result.stderr.length > 0) await writeText(join(target, "stderr.txt"), result.stderr);
    const meta: AttemptMeta = {
      caseId: evalCase.id,
      rep,
      ok: result.ok,
      timedOut: result.timedOut,
      turns: result.turns,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      stopReason: result.stopReason,
    };
    await writeJson(join(target, "meta.json"), meta);
    return meta;
  } finally {
    if (!keep) await rm(dir, { recursive: true, force: true });
  }
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await work(items[index]!);
    }
  });
  await Promise.all(workers);
}

const opts = options(process.argv.slice(2));
const prompt = promptPath(opts.variant);
if (!existsSync(prompt)) throw new Error(`no prompt file at ${prompt}`);
const appendix = (await readFile(prompt, "utf8")).replace(/\n$/u, "");
const cases = await loadCases(opts.cases);
for (const one of cases) {
  if (!existsSync(fixtureDir(one.id))) throw new Error(`case ${one.id} has no fixture`);
}

const version = (await shell(["claude", "--version"], process.cwd())).trim();
const runId = `${opts.variant}-${opts.model}-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
const startedAt = new Date().toISOString();
const work = cases.flatMap((one) =>
  Array.from({ length: opts.reps }, (_, index) => ({ evalCase: one, rep: index + 1 })),
);

console.log(`run ${runId}: ${cases.length} cases x ${opts.reps} reps on ${opts.model}`);
const metas: AttemptMeta[] = [];
let done = 0;
await pool(work, opts.concurrency, async (item) => {
  const meta = await attempt(runId, item.evalCase, item.rep, appendix, opts.model, opts.keep);
  metas.push(meta);
  done += 1;
  console.log(
    `  [${done}/${work.length}] ${meta.caseId} rep${meta.rep} ${meta.stopReason} ${Math.round(meta.durationMs / 1000)}s $${meta.costUsd.toFixed(3)}`,
  );
});

const runMeta: RunMeta = {
  runId,
  variant: opts.variant,
  variantHash: hashText(appendix),
  model: opts.model,
  reps: opts.reps,
  caseIds: cases.map((one) => one.id),
  claudeVersion: version,
  startedAt,
  finishedAt: new Date().toISOString(),
  totalCostUsd: metas.reduce((sum, meta) => sum + meta.costUsd, 0),
};
await writeJson(join(runDir(runId), "meta.json"), runMeta);
console.log(`done ${runId} $${runMeta.totalCostUsd.toFixed(2)}`);
