import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  invokeOperation,
  InvocationError,
  preflightOperationInvocations,
  type InvokeOptions,
} from "./invoke.js";

interface FixtureStep {
  readonly operation: string;
  readonly input: unknown;
}

interface FixtureScenario {
  readonly name: string;
  readonly seed: readonly FixtureStep[];
  readonly invoke: FixtureStep;
  readonly expect: unknown;
}

export interface FixtureScenarioResult {
  readonly id: string;
  readonly file: string;
  readonly operation: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly stage?: "seed" | "invoke" | "expect";
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface FixtureRunResult {
  readonly ok: boolean;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly scenarios: readonly FixtureScenarioResult[];
}

export interface FixtureRunOptions extends Pick<
  InvokeOptions,
  "confirm" | "serverUrl" | "fetch"
> {
  readonly module?: string;
}

interface LoadedScenario {
  readonly id: string;
  readonly file: string;
  readonly scenario: FixtureScenario;
}

export class FixtureError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(redactText(message));
    this.name = "FixtureError";
    this.code = code;
  }
}

function fixtureFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...fixtureFiles(path));
    else if (entry.isFile() && /\.(?:json|ya?ml)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJson(value: unknown, label: string): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertJson(item, `${label}[${index}]`);
    return;
  }
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) assertJson(item, `${label}.${key}`);
    return;
  }
  throw new FixtureError("invalid_fixture", `${label} must be JSON-serializable`);
}

function fixtureStep(value: unknown, label: string): FixtureStep {
  if (!isRecord(value)) {
    throw new FixtureError("invalid_fixture", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !["operation", "input"].includes(key));
  if (unknown.length > 0) {
    throw new FixtureError(
      "invalid_fixture",
      `${label} has unknown ${unknown.length === 1 ? "field" : "fields"}: ${unknown.join(", ")}`,
    );
  }
  if (typeof value.operation !== "string" || value.operation.trim() === "") {
    throw new FixtureError("invalid_fixture", `${label}.operation must be a non-empty string`);
  }
  const input = Object.hasOwn(value, "input") ? value.input : {};
  assertJson(input, `${label}.input`);
  return { operation: value.operation, input };
}

function loadScenario(root: string, path: string): LoadedScenario {
  const file = relative(root, path).replaceAll("\\", "/");
  let value: unknown;
  try {
    const source = readFileSync(path, "utf8");
    value = path.endsWith(".json") ? JSON.parse(source) : parseYaml(source);
  } catch (error) {
    throw new FixtureError(
      "invalid_fixture",
      `${file} cannot be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw new FixtureError("invalid_fixture", `${file} must contain an object`);
  }
  const allowed = new Set(["name", "seed", "invoke", "expect"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new FixtureError(
      "invalid_fixture",
      `${file} has unknown ${unknown.length === 1 ? "field" : "fields"}: ${unknown.join(", ")}`,
    );
  }
  const fallbackName = file
    .replace(/^fixtures\//, "")
    .replace(/\.(?:json|ya?ml)$/, "")
    .replaceAll("/", ".");
  const name = value.name === undefined ? fallbackName : value.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new FixtureError("invalid_fixture", `${file}.name must be a non-empty string`);
  }
  if (!Object.hasOwn(value, "invoke")) {
    throw new FixtureError("invalid_fixture", `${file} is missing invoke`);
  }
  if (!Object.hasOwn(value, "expect")) {
    throw new FixtureError("invalid_fixture", `${file} is missing expect`);
  }
  if (value.seed !== undefined && !Array.isArray(value.seed)) {
    throw new FixtureError("invalid_fixture", `${file}.seed must be an array`);
  }
  const seed = (value.seed ?? []).map((step, index) =>
    fixtureStep(step, `${file}.seed[${index}]`),
  );
  const invoke = fixtureStep(value.invoke, `${file}.invoke`);
  assertJson(value.expect, `${file}.expect`);
  return {
    id: name,
    file,
    scenario: { name, seed, invoke, expect: value.expect },
  };
}

function invocationError(error: unknown): { code: string; message: string } {
  if (error instanceof InvocationError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "fixture_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function redactText(value: string): string {
  return value
    .replace(
      /(\b"?(?:api[-_]?key|password|secret|token)"?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]");
}

function redactJson(value: unknown, key = ""): unknown {
  if (/(?:api[-_]?key|password|secret|token)/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, item]) => [
        entryKey,
        redactJson(item, entryKey),
      ]),
    );
  }
  return typeof value === "string" ? redactText(value) : value;
}

/** Run loaded-plugin scenarios in stable order and stop after unknown state. */
export async function runFixtures(
  root: string,
  options: FixtureRunOptions = {},
): Promise<FixtureRunResult> {
  if (options.module && !/^[a-z0-9][a-z0-9-]*$/.test(options.module)) {
    throw new FixtureError("invalid_fixture_module", "fixture module must be lowercase kebab-case");
  }
  const fixtureRoot = join(root, "fixtures");
  const directory = options.module ? join(fixtureRoot, options.module) : fixtureRoot;
  const files = fixtureFiles(directory);
  if (files.length === 0) {
    throw new FixtureError(
      "no_fixtures",
      options.module
        ? `no fixtures found for module "${options.module}"`
        : "no fixtures found",
    );
  }
  const loaded = files.map((path) => loadScenario(root, path));
  const ids = new Set<string>();
  for (const fixture of loaded) {
    if (ids.has(fixture.id)) {
      throw new FixtureError("duplicate_fixture", `duplicate fixture name "${fixture.id}"`);
    }
    ids.add(fixture.id);
  }
  preflightOperationInvocations(
    root,
    loaded.flatMap(({ scenario }) => [
      ...scenario.seed.map((step) => step.operation),
      scenario.invoke.operation,
    ]),
    options.confirm === true,
  );

  const scenarios: FixtureScenarioResult[] = [];
  const invocationOptions = {
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  } satisfies InvokeOptions;
  let stopped = false;
  for (const fixture of loaded) {
    const { scenario } = fixture;
    if (stopped) {
      scenarios.push({
        id: fixture.id,
        file: fixture.file,
        operation: scenario.invoke.operation,
        status: "skipped",
        error: { code: "previous_failure", message: "an earlier fixture failed" },
      });
      continue;
    }
    let stage: "seed" | "invoke" = "seed";
    let currentOperation = scenario.invoke.operation;
    try {
      for (const step of scenario.seed) {
        currentOperation = step.operation;
        await invokeOperation(root, step.operation, {
          ...invocationOptions,
          input: JSON.stringify(step.input),
          cwd: root,
        });
      }
      stage = "invoke";
      currentOperation = scenario.invoke.operation;
      const result = await invokeOperation(root, scenario.invoke.operation, {
        ...invocationOptions,
        input: JSON.stringify(scenario.invoke.input),
        cwd: root,
      });
      if (!isDeepStrictEqual(result.result, scenario.expect)) {
        stopped = true;
        scenarios.push({
          id: fixture.id,
          file: fixture.file,
          operation: scenario.invoke.operation,
          status: "failed",
          stage: "expect",
          error: { code: "expectation_failed", message: "operation result did not exactly match expect" },
          expected: redactJson(scenario.expect),
          actual: redactJson(result.result),
        });
      } else {
        scenarios.push({
          id: fixture.id,
          file: fixture.file,
          operation: scenario.invoke.operation,
          status: "passed",
        });
      }
    } catch (error) {
      stopped = true;
      const failure = invocationError(error);
      scenarios.push({
        id: fixture.id,
        file: fixture.file,
        operation: currentOperation,
        status: "failed",
        stage,
        error: {
          ...failure,
          message: redactText(failure.message),
        },
      });
    }
  }
  const passed = scenarios.filter((scenario) => scenario.status === "passed").length;
  const failed = scenarios.filter((scenario) => scenario.status === "failed").length;
  return {
    ok: failed === 0,
    total: scenarios.length,
    passed,
    failed,
    scenarios,
  };
}

export function formatFixtureRun(result: FixtureRunResult): string {
  const icon = { passed: "✓", failed: "✗", skipped: "–" } as const;
  const lines = result.scenarios.map((scenario) =>
    `${icon[scenario.status]} ${scenario.id}: ${scenario.status}`
    + (scenario.error ? ` (${scenario.error.code}: ${scenario.error.message})` : ""),
  );
  lines.push(`${result.passed}/${result.total} fixtures passed`);
  return lines.join("\n");
}
