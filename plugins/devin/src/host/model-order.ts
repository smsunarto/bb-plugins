import { BRIDGE_REQUEST_METHODS } from "@get-bb/plugin-sdk/provider-bridge";
import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * Orders Devin's model catalog for the bb picker.
 *
 * Devin lists nine single models and twenty Fusion pairs (a primary model
 * plus a sidekick) in no useful order. The picker shows instead:
 *
 * 1. The latest Astra and latest Sol Fusion pairs, each with the strongest
 *    SWE-2 sidekick the catalog offers that primary. Every other Fusion
 *    pair is omitted. A pair's display name drops the primary's baked-in
 *    effort ("High Thinking") because the reasoning selector controls the
 *    primary independently; the sidekick's fixed effort stays in the name.
 * 2. The latest of each headline family: Astra, Fable, Sol, Opus, then SWE.
 * 3. The rest grouped by vendor (Anthropic, OpenAI, then others), largest
 *    model first, then newest version first.
 *
 * "Latest" and "strongest" are read from the catalog, so a new version or a
 * stronger sidekick pairing takes the slot without an edit here. A new
 * family or size name needs a table entry; until then it sorts at the end
 * of its vendor's group.
 *
 * Model ids are parsed, not display names: `gpt-6-1-sol-medium`,
 * `claude-fable-5-1-medium`, `swe-2-high`, `grok-4-7-medium`, and
 * `fusion-<primary>-sidekick-<sidekick>`.
 */
export type ModelCatalog = Readonly<{
  models: readonly AvailableModel[];
  selectedOnlyModels: readonly AvailableModel[];
}>;

type Vendor = "anthropic" | "openai" | "cognition" | "other";

/** A model id's parts: vendor, size or product line, version, reasoning effort. */
type ModelName = Readonly<{
  vendor: Vendor;
  line: string;
  version: readonly number[];
  effort: number;
}>;

type ParsedId = Readonly<{ fusion: boolean; primary: ModelName; sidekick: ModelName | null }>;

type Family = Readonly<{ vendor: Vendor; line: string }>;

/** Each vendor's lines, largest first. */
const LINES: Readonly<Record<Vendor, readonly string[]>> = {
  openai: ["astra", "sol", "terra", "luna"],
  anthropic: ["fable", "opus", "sonnet", "haiku"],
  cognition: ["swe"],
  other: [],
};

/** Vendor order for the models below the headline tier. */
const VENDOR_ORDER: readonly Vendor[] = ["anthropic", "openai", "cognition", "other"];

/** Picker order after the Fusion tier: the latest model of each family. */
const HEADLINE: readonly Family[] = [
  { vendor: "openai", line: "astra" },
  { vendor: "anthropic", line: "fable" },
  { vendor: "openai", line: "sol" },
  { vendor: "anthropic", line: "opus" },
  { vendor: "cognition", line: "swe" },
];

/** A Fusion pair stays in the picker only with the latest of these as primary. */
const FUSION_PRIMARIES: readonly Family[] = [
  { vendor: "openai", line: "astra" },
  { vendor: "openai", line: "sol" },
];

/** Reasoning effort suffixes Devin appends to an id, weakest first. */
const EFFORTS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const VERSION_SEGMENTS = 4;

type SortKey = readonly number[];

type Message = Record<string, unknown>;

const isNumeric = (token: string): boolean => /^\d+$/.test(token);

function parseName(tokens: readonly string[]): ModelName {
  const effort = EFFORTS.indexOf(tokens[tokens.length - 1] ?? "");
  const body = effort === -1 ? tokens : tokens.slice(0, -1);
  const [head = "", ...rest] = body;
  const vendor: Vendor =
    head === "gpt"
      ? "openai"
      : head === "claude"
        ? "anthropic"
        : head === "swe"
          ? "cognition"
          : "other";
  const word = rest.find((token) => !isNumeric(token)) ?? "";
  return {
    vendor,
    line: vendor === "openai" || vendor === "anthropic" ? word : head,
    version: rest.filter(isNumeric).map(Number),
    effort,
  };
}

function parseId(id: string): ParsedId {
  const tokens = id.split("-");
  if (tokens[0] !== "fusion") return { fusion: false, primary: parseName(tokens), sidekick: null };
  const at = tokens.indexOf("sidekick");
  return {
    fusion: true,
    primary: parseName(at === -1 ? tokens.slice(1) : tokens.slice(1, at)),
    sidekick: at === -1 ? null : parseName(tokens.slice(at + 1)),
  };
}

function compareNumbers(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const familyKey = (family: Family): string => `${family.vendor}/${family.line}`;
const sameFamily = (family: Family, name: ModelName): boolean =>
  family.vendor === name.vendor && family.line === name.line;

const primaryKey = (name: ModelName): string => `${familyKey(name)}/${name.version.join(".")}`;
const isSwe2 = (name: ModelName | null): name is ModelName =>
  name !== null &&
  name.vendor === "cognition" &&
  name.line === "swe" &&
  compareNumbers(name.version, [2]) === 0 &&
  name.effort >= 0;

/** The strongest SWE-2 sidekick effort the catalog pairs with each primary. */
function strongestSidekickEfforts(ids: readonly ParsedId[]): ReadonlyMap<string, number> {
  const efforts = new Map<string, number>();
  for (const { fusion, primary, sidekick } of ids) {
    if (!fusion || !isSwe2(sidekick)) continue;
    const key = primaryKey(primary);
    efforts.set(key, Math.max(efforts.get(key) ?? -1, sidekick.effort));
  }
  return efforts;
}

/**
 * Drops the primary's baked-in effort from a Fusion display name
 * ("Fusion (GPT-6 Astra High Thinking + SWE-2 High)" -> "Fusion (GPT-6 Astra
 * + SWE-2 High)"); the reasoning selector, not the name, carries it.
 */
function withSelectableReasoning(model: AvailableModel): AvailableModel {
  const displayName = model.displayName.replace(
    /\s+(?:none|minimal|low|medium|high|xhigh|max)(?:\s+thinking)?(?=\s*\+)/i,
    "",
  );
  return displayName === model.displayName ? model : { ...model, displayName };
}

/** The newest version the catalog names in each family. */
function latestVersions(names: readonly ModelName[]): ReadonlyMap<string, readonly number[]> {
  const latest = new Map<string, readonly number[]>();
  for (const name of names) {
    const key = familyKey(name);
    const known = latest.get(key);
    if (known === undefined || compareNumbers(name.version, known) > 0)
      latest.set(key, name.version);
  }
  return latest;
}

/** Where one model name lands below the Fusion tier. */
function nameKey(name: ModelName, latest: ReadonlyMap<string, readonly number[]>): SortKey {
  const isLatest = compareNumbers(name.version, latest.get(familyKey(name)) ?? []) === 0;
  const headline = HEADLINE.findIndex((family) => sameFamily(family, name));
  if (isLatest && headline !== -1) return [1, headline, -name.effort];
  const lines = LINES[name.vendor];
  const line = lines.indexOf(name.line);
  const version = Array.from({ length: VERSION_SEGMENTS }, (_, i) => -(name.version[i] ?? 0));
  return [
    2,
    VENDOR_ORDER.indexOf(name.vendor),
    line === -1 ? lines.length : line,
    ...version,
    -name.effort,
  ];
}

/** Where a Fusion pair lands; null omits it from the picker entirely. */
function fusionKey(
  parsed: ParsedId,
  latest: ReadonlyMap<string, readonly number[]>,
  sidekickEfforts: ReadonlyMap<string, number>,
): SortKey | null {
  const { primary, sidekick } = parsed;
  const pick = FUSION_PRIMARIES.findIndex((family) => sameFamily(family, primary));
  if (pick === -1) return null;
  if (compareNumbers(primary.version, latest.get(familyKey(primary)) ?? []) !== 0) return null;
  if (!isSwe2(sidekick) || sidekick.effort !== sidekickEfforts.get(primaryKey(primary)))
    return null;
  return [0, pick, -primary.effort];
}

const withDefault = (model: AvailableModel, isDefault: boolean): AvailableModel =>
  model.isDefault === isDefault ? model : { ...model, isDefault };

export function orderModelCatalog(catalog: ModelCatalog): ModelCatalog {
  const parsed = catalog.models.map((model) => ({ model, id: parseId(model.id) }));
  const latest = latestVersions(
    parsed.flatMap(({ id }) => (id.sidekick === null ? [id.primary] : [id.primary, id.sidekick])),
  );
  const sidekickEfforts = strongestSidekickEfforts(parsed.map(({ id }) => id));
  const shown: { model: AvailableModel; key: SortKey }[] = [];
  for (const { model, id } of parsed) {
    const key = id.fusion ? fusionKey(id, latest, sidekickEfforts) : nameKey(id.primary, latest);
    if (key !== null)
      shown.push({ model: id.fusion ? withSelectableReasoning(model) : model, key });
  }
  shown.sort((a, b) => compareNumbers(a.key, b.key));
  const models = shown.map(({ model }) => model);
  const first = models[0];
  return {
    models:
      first === undefined || models.some((model) => model.isDefault)
        ? models
        : [withDefault(first, true), ...models.slice(1)],
    selectedOnlyModels: catalog.selectedOnlyModels
      .filter((model) => !parseId(model.id).fusion)
      .map((model) => withDefault(model, false)),
  };
}

function asRecord(value: unknown): Message | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Message)
    : null;
}

function parseMessage(line: string): Message | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

const requestIdOf = (message: Message | null): string | number | null => {
  const id = message?.["id"];
  return typeof id === "string" || typeof id === "number" ? id : null;
};

export type ModelListRewriter = Readonly<{
  /** A line from bb, before the bridge handles it. */
  beforeInbound(line: string): void;
  /** The bridge's outbound stdout line, reordered when it answers `model/list`. */
  rewrite(line: string): string;
}>;

/**
 * Rewrites the bridge's `model/list` answers with {@link orderModelCatalog}.
 * bb's request ids name the answers; everything else passes as written.
 */
export function createModelListRewriter(
  order: (catalog: ModelCatalog) => ModelCatalog = orderModelCatalog,
): ModelListRewriter {
  const pending = new Set<string | number>();
  return {
    beforeInbound(line) {
      if (!line.includes(BRIDGE_REQUEST_METHODS.modelList)) return;
      const message = parseMessage(line);
      const id = requestIdOf(message);
      if (id !== null && message?.["method"] === BRIDGE_REQUEST_METHODS.modelList) pending.add(id);
    },
    rewrite(line) {
      if (pending.size === 0) return line;
      const message = parseMessage(line);
      const id = requestIdOf(message);
      if (message === null || id === null || !pending.has(id)) return line;
      pending.delete(id);
      const result = asRecord(message["result"]);
      const models = result?.["models"];
      if (result === null || !Array.isArray(models)) return line;
      const selectedOnly = result["selectedOnlyModels"];
      const ordered = order({
        models: models as AvailableModel[],
        selectedOnlyModels: Array.isArray(selectedOnly) ? (selectedOnly as AvailableModel[]) : [],
      });
      return `${JSON.stringify({ ...message, result: { ...result, ...ordered } })}\n`;
    },
  };
}
