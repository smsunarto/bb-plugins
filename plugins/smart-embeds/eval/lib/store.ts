import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EVAL_DIR } from "./cases.ts";

export const ROOT = join(EVAL_DIR, "..", "..", "..", ".scratch", "smart-embeds-eval");
export const RUNS = join(ROOT, "runs");

export type RunMeta = {
  runId: string;
  variant: string;
  variantHash: string;
  model: string;
  reps: number;
  caseIds: string[];
  claudeVersion: string;
  startedAt: string;
  finishedAt: string;
  totalCostUsd: number;
};

export type AttemptMeta = {
  caseId: string;
  rep: number;
  ok: boolean;
  timedOut: boolean;
  turns: number;
  costUsd: number;
  durationMs: number;
  stopReason: string;
};

export function runDir(runId: string): string {
  return join(RUNS, runId);
}

export function attemptDir(runId: string, caseId: string, rep: number): string {
  return join(RUNS, runId, "cases", caseId, `rep${rep}`);
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

export async function readText(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, "utf8") : "";
}

export function promptPath(variant: string): string {
  return join(EVAL_DIR, "prompts", `${variant}.md`);
}
