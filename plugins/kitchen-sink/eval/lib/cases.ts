import { readdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EVAL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const CASES_DIR = join(EVAL_DIR, "cases");

export type CaseKind = "range" | "investigation" | "generated" | "incidental" | "small";

export type EvalCase = {
  id: string;
  kind: CaseKind;
  project: string;
  prompt: string;
  expectDiffFor: string[];
  noDiffFor: string[] | "*";
  rangeRequiredFor: string[];
  anchorSymbols: string[];
};

export function caseDir(id: string): string {
  return join(CASES_DIR, id);
}

export function fixtureDir(id: string): string {
  return join(CASES_DIR, id, "fixture");
}

export function driftDir(id: string): string | null {
  const path = join(CASES_DIR, id, "drift");
  return existsSync(path) ? path : null;
}

export async function loadCase(id: string): Promise<EvalCase> {
  const parsed = JSON.parse(await readFile(join(CASES_DIR, id, "case.json"), "utf8")) as EvalCase;
  if (parsed.id !== id) throw new Error(`case ${id} declares id ${parsed.id}`);
  return parsed;
}

export function caseIds(): string[] {
  return readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function loadCases(only?: string[]): Promise<EvalCase[]> {
  const ids = only && only.length > 0 ? only : caseIds();
  return Promise.all(ids.map(loadCase));
}

export function noDiffPaths(evalCase: EvalCase): string[] | "*" {
  return evalCase.noDiffFor;
}
