import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { completeCodexInference } from "../plugins/gtd-sidebar/host/inference/chatgpt-client.ts";
import {
  completeThreadTitleWithFallback,
  TITLE_OUTPUT_SCHEMA,
  formatInferredTitle,
} from "../plugins/gtd-sidebar/thread-title-inference.ts";
import type { PlanThreadNamingInput } from "../plugins/gtd-sidebar/lib/thread-naming.ts";

interface ReplayConfig {
  label: string;
  planner: string;
  cases: string;
  output: string;
  ids: string[];
  effort?: "none" | "low";
  structured?: boolean;
}

interface ReplayCase {
  id: string;
  input: PlanThreadNamingInput;
}

const configPath = process.argv[2];
if (!configPath) throw new Error("Usage: bun scripts/gtd-title-eval.ts <config.json>");
const config = JSON.parse(await readFile(configPath, "utf8")) as ReplayConfig;
if (!/^[\w-]+$/u.test(config.label) || !Array.isArray(config.ids) || config.ids.length > 12) {
  throw new Error("Supply a simple label and at most 12 case IDs.");
}
const planner = (await import(
  pathToFileURL(resolve(config.planner)).href
)) as typeof import("../plugins/gtd-sidebar/lib/thread-naming.ts");
const cases = JSON.parse(await readFile(config.cases, "utf8")) as ReplayCase[];
const output = resolve(config.output);
await mkdir(output, { recursive: true });
const ledger = join(output, "attempts.jsonl");
let calls = (
  await readFile(ledger, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })
)
  .split("\n")
  .filter(Boolean).length;
const schema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

for (const id of config.ids) {
  const item = cases.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown case ${id}`);
  const resultPath = join(output, `${config.label}-${id}.json`);
  if (await Bun.file(resultPath).exists()) throw new Error(`Result already exists: ${resultPath}`);
  const plan = planner.planThreadNaming(item.input);
  if (plan.kind !== "run") throw new Error(`Case ${id} skipped: ${plan.reason}`);
  const attempts: Record<string, unknown>[] = [];
  const start = performance.now();
  try {
    const rawTitle = await completeThreadTitleWithFallback({
      primary: "gpt-5.6-luna",
      fallback: "gpt-5.4-mini",
      format: config.structured
        ? formatInferredTitle
        : (value) => {
            if (typeof value.title !== "string") throw new Error("Missing title");
            return value.title;
          },
      complete: async (model) => {
        if (calls >= 32) throw new Error("The 32-attempt evaluation budget is exhausted.");
        calls++;
        await appendFile(
          ledger,
          JSON.stringify({ label: config.label, id, model, call: calls }) + "\n",
        );
        const attemptStart = performance.now();
        try {
          const result = await completeCodexInference({
            serviceId: "gtd-sidebar",
            model,
            reasoningEffort: config.effort ?? "low",
            prompt: plan.prompt,
            outputSchema: config.structured ? TITLE_OUTPUT_SCHEMA : schema,
            timeoutMs: 5_000,
          });
          attempts.push({
            model,
            ms: performance.now() - attemptStart,
            usage: result.usage ?? null,
          });
          return result;
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          attempts.push({
            model,
            ms: performance.now() - attemptStart,
            usage: null,
            error: failure.message,
          });
          if (
            failure.code === "timeout" ||
            failure.code === "rate_limited" ||
            failure.code === "service_unavailable"
          ) {
            return { ok: false, code: failure.code, message: failure.message ?? failure.code };
          }
          throw error;
        }
      },
    });
    const allowedShipped = "allowedShipped" in plan && plan.allowedShipped === true;
    const title = (
      planner.sanitizeGeneratedTitle as (value: string, allowed?: boolean) => string | null
    )(rawTitle, allowedShipped);
    const result = {
      id,
      label: config.label,
      title,
      rawTitle,
      ms: performance.now() - start,
      attempts,
      prompt: plan.prompt,
      promptHash: new Bun.CryptoHasher("sha256").update(plan.prompt).digest("hex"),
    };
    await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ id, title, ms: Math.round(result.ms), attempts }));
  } catch (error) {
    await writeFile(
      resultPath,
      JSON.stringify({ id, label: config.label, error: String(error), attempts }, null, 2) + "\n",
    );
    throw error;
  }
}
