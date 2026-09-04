import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadCase } from "./lib/cases.ts";
import { directiveKey } from "./lib/criteria.ts";
import { scanDirectives } from "./lib/directives.ts";
import { capture } from "./lib/proc.ts";
import { attemptDir, readJson, readText, runDir, writeJson, type RunMeta } from "./lib/store.ts";

const JUDGE_MODEL = "gpt-5.2";
const CHUNK = 20;
const CONTEXT_BEFORE = 10;
const CONTEXT_AFTER = 3;
const MARK = ">> ";

type Item = { id: string; key: string; runId: string; excerpt: string };

const RUBRIC = `You grade where a widget was placed inside a written answer.

A directive line renders as an inline panel. ::smart-diff{...} renders the diff of a file. ::smart-code{...} renders a snippet of a file. ::smart-patch{...} renders a proposed diff the agent has not applied.

Each item below is an excerpt of an answer. The line marked with ${MARK.trim()} is the directive under review. Decide one thing only: does that directive sit directly under the specific sentence or claim it supports, so the reader meets the evidence exactly where the claim is made?

Answer true when the sentence right above the directive names what the panel shows, or makes the claim the panel proves.
Answer false when the directive is parked in a trailing block away from the prose it belongs to, sits under an unrelated sentence, or appears before any claim that would motivate it.

Reply with ONLY a JSON object. No prose, no code fence, no markdown.
{"items":[{"id":"<id>","placed":true,"reason":"<at most 12 words>"}]}
Include exactly one entry for every id you were given.`;

function excerptFor(response: string, line: number): string {
  const lines = response.split("\n");
  const from = Math.max(0, line - CONTEXT_BEFORE);
  const to = Math.min(lines.length, line + CONTEXT_AFTER + 1);
  return lines
    .slice(from, to)
    .map((text, index) => (from + index === line ? `${MARK}${text}` : `   ${text}`))
    .join("\n");
}

function shuffle<T>(items: T[], seed: string): T[] {
  return items
    .map((item, index) => ({
      item,
      order: createHash("sha256").update(`${seed}:${index}`).digest("hex"),
    }))
    .sort((left, right) => left.order.localeCompare(right.order))
    .map((entry) => entry.item);
}

async function ask(prompt: string): Promise<Map<string, boolean>> {
  const captured = await capture(
    "cursor-agent",
    [
      "--print",
      "--output-format",
      "json",
      "--model",
      JUDGE_MODEL,
      "--mode",
      "ask",
      "--trust",
      prompt,
    ],
    { cwd: process.cwd() },
  );
  const envelope = JSON.parse(captured.stdout) as { result?: string };
  const body = (envelope.result ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/```$/u, "");
  const parsed = JSON.parse(body) as { items?: Array<{ id?: string; placed?: boolean }> };
  const verdicts = new Map<string, boolean>();
  for (const entry of parsed.items ?? []) {
    if (typeof entry.id === "string" && typeof entry.placed === "boolean") {
      verdicts.set(entry.id, entry.placed);
    }
  }
  return verdicts;
}

async function collect(runIds: string[]): Promise<Item[]> {
  const items: Item[] = [];
  for (const runId of runIds) {
    const meta = await readJson<RunMeta>(join(runDir(runId), "meta.json"));
    if (meta === null) throw new Error(`no run at ${runId}`);
    for (const caseId of meta.caseIds) {
      const evalCase = await loadCase(caseId);
      for (let rep = 1; rep <= meta.reps; rep += 1) {
        const response = await readText(join(attemptDir(runId, caseId, rep), "result.md"));
        if (response.length === 0) continue;
        for (const directive of scanDirectives(response).directives) {
          const key = directiveKey(evalCase.id, rep, directive);
          items.push({
            id: createHash("sha256").update(`${runId}:${key}`).digest("hex").slice(0, 10),
            key,
            runId,
            excerpt: excerptFor(response, directive.line),
          });
        }
      }
    }
  }
  return items;
}

const runIds = process.argv.slice(2).filter((value) => !value.startsWith("--"));
if (runIds.length === 0) throw new Error("pass one or more run ids");

const items = shuffle(await collect(runIds), runIds.join("|"));
console.log(`judging ${items.length} embeds across ${runIds.length} runs on ${JUDGE_MODEL}`);

const verdicts = new Map<string, boolean>();
for (let index = 0; index < items.length; index += CHUNK) {
  const chunk = items.slice(index, index + CHUNK);
  const body = chunk.map((item) => `--- item ${item.id} ---\n${item.excerpt}`).join("\n\n");
  let answers = new Map<string, boolean>();
  for (let tries = 0; tries < 2 && answers.size === 0; tries += 1) {
    try {
      answers = await ask(`${RUBRIC}\n\nITEMS:\n\n${body}`);
    } catch (error) {
      console.warn(`  chunk ${index / CHUNK + 1} failed: ${String(error)}`);
    }
  }
  let missing = 0;
  for (const item of chunk) {
    const verdict = answers.get(item.id);
    if (verdict === undefined) missing += 1;
    else verdicts.set(`${item.runId} ${item.key}`, verdict);
  }
  console.log(`  chunk ${index / CHUNK + 1}: ${chunk.length - missing}/${chunk.length} judged`);
}

for (const runId of runIds) {
  const scoped: Record<string, boolean> = {};
  for (const [composite, verdict] of verdicts) {
    const gap = composite.indexOf(" ");
    if (composite.slice(0, gap) === runId) scoped[composite.slice(gap + 1)] = verdict;
  }
  await writeJson(join(runDir(runId), "judgments.json"), {
    model: JUDGE_MODEL,
    judgedWith: runIds,
    verdicts: scoped,
  });
  console.log(`wrote ${Object.keys(scoped).length} verdicts for ${runId}`);
}
