import { BRIDGE_REQUEST_METHODS, type AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";

export type ModelCatalog = Readonly<{
  models: readonly AvailableModel[];
  selectedOnlyModels: readonly AvailableModel[];
}>;

export interface ParsedAgyModelEfforts {
  readonly efforts: readonly string[];
  readonly defaultEffort: string;
}

export interface ParsedAgyModels {
  readonly effortsByFamily: ReadonlyMap<string, ParsedAgyModelEfforts>;
  readonly exactModelIds: ReadonlySet<string>;
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_INDEX = new Map<string, number>(EFFORT_ORDER.map((level, index) => [level, index]));
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

const MODE_OPTION_ID = "mode";
/** TTY output pads columns with 2+ spaces; piped stdout separates columns with a tab. */
const AGY_MODEL_LINE = /^\s*(\S+)(?:\t+|\s{2,})(.+?)\s*$/u;

function splitEffortSuffix(id: string): { family: string; effort: string } | null {
  for (const effort of EFFORT_ORDER) {
    const suffix = `-${effort}`;
    if (id.endsWith(suffix) && id.length > suffix.length) {
      return { family: id.slice(0, -suffix.length), effort };
    }
  }
  return null;
}

/**
 * Parses `agy models` output (`<model-id>   <Display Name>`).
 *
 * `agy models` lists every `(family, effort)` variant in priority order, with
 * the first variant per family matching `agy`'s default reasoning effort.
 * Models without effort variants (such as Orchestrator or GPT-OSS 120B) are
 * recorded in `exactModelIds` so they resolve to `reasoningDiscovery: "known"`
 * with an empty effort list rather than staying `"unknown"`.
 */
export function parseAgyModelsOutput(stdout: string): ParsedAgyModels {
  const rawEfforts = new Map<string, string[]>();
  const exactModelIds = new Set<string>();

  for (const line of stdout.split("\n")) {
    const match = AGY_MODEL_LINE.exec(line);
    if (match === null) continue;
    const id = match[1];
    if (id === undefined) continue;
    exactModelIds.add(id);

    const split = splitEffortSuffix(id);
    if (split === null) continue;
    const list = rawEfforts.get(split.family) ?? [];
    if (!list.includes(split.effort)) {
      list.push(split.effort);
      rawEfforts.set(split.family, list);
    }
  }

  const effortsByFamily = new Map<string, ParsedAgyModelEfforts>();
  for (const [family, list] of rawEfforts) {
    const defaultEffort = list[0];
    if (defaultEffort === undefined) continue;
    const sorted = [...list].sort(
      (left, right) => (EFFORT_INDEX.get(left) ?? 99) - (EFFORT_INDEX.get(right) ?? 99),
    );
    effortsByFamily.set(family, { efforts: sorted, defaultEffort });
  }

  return { effortsByFamily, exactModelIds };
}

/**
 * Models BB offers from Antigravity: Gemini 4 Neon and Carbon plus their
 * orchestrators (`gemini-pro-orchestrator` is "Orchestrator (Carbon)").
 * Every other model `agy` reports is dropped from the catalog.
 */
const VISIBLE_MODEL_IDS: ReadonlySet<string> = new Set([
  "gemini-4-neon",
  "gemini-4-carbon",
  "gemini-pro-orchestrator-neon",
  "gemini-pro-orchestrator",
]);

export function isVisibleAntigravityModel(id: string): boolean {
  return VISIBLE_MODEL_IDS.has(splitEffortSuffix(id)?.family ?? id);
}

/** Lists Gemini 4 models before the orchestrators. */
function modelGroupRank(id: string): number {
  return id.startsWith("gemini-pro-orchestrator") ? 1 : 0;
}

function stripRedundantModeOption(model: AvailableModel): AvailableModel {
  if (model.sessionOptions === undefined) return model;
  const filtered = model.sessionOptions.filter((option) => option.id !== MODE_OPTION_ID);
  return filtered.length === model.sessionOptions.length
    ? model
    : { ...model, sessionOptions: filtered };
}

function enrichModelReasoning(
  model: AvailableModel,
  parsed: ParsedAgyModels | null,
): AvailableModel {
  const cleaned = stripRedundantModeOption(model);
  if (parsed === null || cleaned.reasoningDiscovery === "known") {
    return cleaned;
  }
  const family = parsed.effortsByFamily.get(cleaned.id);
  if (family !== undefined) {
    return {
      ...cleaned,
      reasoningDiscovery: "known",
      defaultReasoningEffort: family.defaultEffort,
      supportedReasoningEfforts: family.efforts.map((effort) => {
        const label = EFFORT_LABELS[effort] ?? effort;
        return {
          reasoningEffort: effort,
          label,
          description: label,
        };
      }),
    };
  }
  if (parsed.exactModelIds.has(cleaned.id)) {
    return {
      ...cleaned,
      reasoningDiscovery: "known",
      supportedReasoningEfforts: [],
    };
  }
  return cleaned;
}

export function transformAntigravityModelCatalog(
  catalog: ModelCatalog,
  parsed: ParsedAgyModels | null,
): ModelCatalog {
  const indexed = catalog.models
    .filter((model) => isVisibleAntigravityModel(model.id))
    .map((model, index) => ({
      model: enrichModelReasoning(model, parsed),
      rank: modelGroupRank(model.id),
      index,
    }));
  indexed.sort((left, right) => left.rank - right.rank || left.index - right.index);

  const models = indexed.map((entry) => entry.model);
  const hasDefault = models.some((model) => model.isDefault);
  const first = models[0];
  const normalizedModels =
    hasDefault || first === undefined
      ? models
      : [{ ...first, isDefault: true }, ...models.slice(1)];

  const selectedOnlyModels: AvailableModel[] = [];
  for (const model of catalog.selectedOnlyModels) {
    if (!isVisibleAntigravityModel(model.id)) continue;
    selectedOnlyModels.push({ ...enrichModelReasoning(model, parsed), isDefault: false });
  }

  return { models: normalizedModels, selectedOnlyModels };
}

type Message = Record<string, unknown>;

function asRecord(value: unknown): Message | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Message)
    : null;
}

function parseJsonLine(line: string): Message | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function requestIdOf(message: Message | null): string | number | null {
  const id = message?.["id"];
  return typeof id === "string" || typeof id === "number" ? id : null;
}

export interface ModelListEnricher {
  beforeInbound(line: string, command: string): void;
  interceptOutbound(line: string, write: (chunk: string) => void): boolean;
}

const MODELS_CACHE_TTL_MS = 5 * 60_000;
const MODELS_WAIT_CAP_MS = 2_500;

export function createModelListEnricher(args: {
  fetchModelsOutput: (command: string) => Promise<string | null>;
  now?: () => number;
}): ModelListEnricher {
  const now = args.now ?? Date.now;
  const pendingIds = new Map<string | number, Promise<ParsedAgyModels | null>>();
  let cached: { command: string; at: number; parsed: ParsedAgyModels } | null = null;
  let inFlight: { command: string; promise: Promise<ParsedAgyModels | null> } | null = null;

  function loadParsedModels(command: string): Promise<ParsedAgyModels | null> {
    if (cached !== null && cached.command === command && now() - cached.at < MODELS_CACHE_TTL_MS) {
      return Promise.resolve(cached.parsed);
    }
    if (inFlight !== null && inFlight.command === command) {
      return inFlight.promise;
    }
    const promise = args
      .fetchModelsOutput(command)
      .then((output) => {
        if (output === null) return null;
        const parsed = parseAgyModelsOutput(output);
        if (parsed.exactModelIds.size === 0) return null;
        cached = { command, at: now(), parsed };
        return parsed;
      })
      .catch(() => null)
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { command, promise };
    return promise;
  }

  function rewriteResponseLine(message: Message, parsed: ParsedAgyModels | null): string {
    const result = asRecord(message["result"]);
    const models = result?.["models"];
    if (result === null || !Array.isArray(models)) {
      return `${JSON.stringify(message)}\n`;
    }
    const selectedOnly = result["selectedOnlyModels"];
    const transformed = transformAntigravityModelCatalog(
      {
        models: models as AvailableModel[],
        selectedOnlyModels: Array.isArray(selectedOnly) ? (selectedOnly as AvailableModel[]) : [],
      },
      parsed,
    );
    return `${JSON.stringify({ ...message, result: { ...result, ...transformed } })}\n`;
  }

  return {
    beforeInbound(line, command) {
      if (!line.includes(BRIDGE_REQUEST_METHODS.modelList)) return;
      const message = parseJsonLine(line);
      const id = requestIdOf(message);
      if (id !== null && message?.["method"] === BRIDGE_REQUEST_METHODS.modelList) {
        pendingIds.set(id, loadParsedModels(command));
      }
    },
    interceptOutbound(line, write) {
      if (pendingIds.size === 0) return false;
      const message = parseJsonLine(line);
      const id = requestIdOf(message);
      if (message === null || id === null) return false;
      const enrichment = pendingIds.get(id);
      if (enrichment === undefined) return false;
      pendingIds.delete(id);

      const bounded = Promise.race([
        enrichment,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), MODELS_WAIT_CAP_MS)),
      ]);
      void bounded.then((parsed) => {
        write(rewriteResponseLine(message, parsed));
        return undefined;
      });
      return true;
    },
  };
}
