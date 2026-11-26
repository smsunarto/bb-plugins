import type { CallExpr, Decl, Expr, NamedArg, Program, Statement, WatchRule } from "./ast";
import {
  ACTIONS,
  COMPONENTS,
  CONSTANTS,
  FORBIDDEN_PROPERTIES,
  FUNCTIONS,
  METHODS,
  TAUGHT_COMPONENTS,
  type ComponentSpec,
  type FunctionName,
  type ParamKind,
  type ParamSpec,
  type StateKind,
} from "./catalog";
import {
  CHECK_REQUIRED_KEYS,
  CHECK_TYPES,
  regexProblem,
  SHORTHAND_CHECKS,
  type CheckType,
} from "./checks";
import type { DiagnosticList, Pos } from "./diagnostics";
import { loadPath } from "./data";
import type { Value } from "./types";

// Maps, not the catalog objects, so spec-controlled names like `constructor`
// never hit Object.prototype.
export const COMPONENT_SPECS: ReadonlyMap<string, ComponentSpec> = new Map(Object.entries(COMPONENTS));
/** Local (bb-plugins): components kept only for old replies (catalog.ts `retired`). */
const RETIRED: ReadonlySet<string> = new Set(Object.keys(COMPONENTS).filter((name) => !(TAUGHT_COMPONENTS as readonly string[]).includes(name)));
export const ACTION_SPECS: ReadonlyMap<string, ComponentSpec> = new Map(Object.entries(ACTIONS));

type MethodName = (typeof METHODS)[keyof typeof METHODS][number];

/** Methods whose single argument is an arrow `(item, index?) => ...`. */
export const LAMBDA_METHODS: ReadonlySet<string> = new Set(["map", "filter", "find", "some", "every"]);

type Arity = readonly [min: number, max: number];

const METHOD_ARITY: ReadonlyMap<string, Arity> = new Map(
  Object.entries({
    map: [1, 1], filter: [1, 1], find: [1, 1], some: [1, 1], every: [1, 1],
    join: [0, 1], slice: [0, 2], includes: [1, 1], indexOf: [1, 1],
    split: [1, 1], trim: [0, 0], toUpperCase: [0, 0], toLowerCase: [0, 0],
    startsWith: [1, 1], endsWith: [1, 1], toFixed: [0, 1],
  } satisfies Record<MethodName, Arity>),
);

const FUNCTION_ARITY: ReadonlyMap<string, Arity> = new Map(
  Object.entries({
    round: [1, 2], fmt: [1, 2], sum: [1, 1], min: [1, Infinity], max: [1, Infinity], abs: [1, 1], Load: [1, 1],
    keys: [1, 1], values: [1, 1], entries: [1, 1], floor: [1, 1], ceil: [1, 1], sqrt: [1, 1], pow: [2, 2],
    sin: [1, 1], cos: [1, 1], tan: [1, 1], asin: [1, 1], acos: [1, 1], atan: [1, 1], atan2: [2, 2],
    clamp: [3, 3], lerp: [3, 3], range: [2, 3], random: [1, 1], Number: [1, 1],
  } satisfies Record<FunctionName, Arity>),
);

/** Local (bb-plugins): the components that caption a `source:`, for the warning that drops one elsewhere. */
const SOURCE_COMPONENTS = ((names: string[]) => `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`)(
  [...COMPONENT_SPECS].filter(([, spec]) => spec.params.some((param) => param.name === "source")).map(([name]) => name),
);
const ACTION_LIST = [...ACTION_SPECS].map(([name, spec]) => signature(name, spec)).join(", ");
export const ARROW_ONLY =
  "arrow functions can only be declared as a named function (`share = p => ...`), passed to map, filter, find, some or every, or given as a value of a list or object (a Scene's `t => [...]`, a surface's `f`)";

/**
 * Named args models reach for to style a component (lowercased). None exist:
 * components draw in BB's theme, so the error says why instead of only that.
 */
const STYLE_ARGS: Record<string, true> = {
  color: true, colour: true, background: true, backgroundcolor: true, bg: true, fill: true, size: true,
  fontsize: true, font: true, fontweight: true, weight: true, bold: true, border: true, padding: true,
  margin: true, width: true, height: true, style: true, classname: true, class: true, shadow: true, radius: true,
};

/** The type of a value, as named in diagnostics. */
export type Kind = "null" | "boolean" | "number" | "string" | "list" | "object" | "node" | "action" | "binding" | "function";

export const DESCRIPTIONS: Record<Kind, string> = {
  null: "null",
  boolean: "a boolean",
  number: "a number",
  string: "text",
  list: "a list",
  object: "an object",
  node: "a component",
  action: "an action",
  binding: "a state binding",
  function: "a function",
};

export const EXPECTED: Record<ParamKind, string> = {
  string: "text",
  text: "text",
  number: "a number",
  boolean: "true or false",
  enum: "one of its allowed values",
  nodes: "components or text",
  list: "a list",
  series: "a list of numbers or {name: [numbers]}",
  binding: "a `$state`",
  actions: "actions",
  function: "a value or a function such as `t => [...]`",
  any: "a value",
};

const STATE_KINDS: Record<StateKind, { readonly fits: readonly Kind[]; readonly needs: string; readonly example: string }> = {
  text: { fits: ["string"], needs: "a text", example: '""' },
  number: { fits: ["number"], needs: "a number", example: "0" },
  boolean: { fits: ["boolean"], needs: "a boolean", example: "false" },
  scalar: { fits: ["string", "number", "boolean"], needs: "a text, number or boolean", example: '""' },
  list: { fits: ["list"], needs: "a list", example: "[]" },
};

/** Why `kind` cannot be bound to `param` (e.g. "`Checklist` value needs a list state, ..."), or null if it can. */
export function stateMismatch(label: string, param: ParamSpec, state: string, kind: Kind, verb: string): string | null {
  const holds = param.holds;
  if (holds === undefined || kind === "null" || STATE_KINDS[holds].fits.includes(kind)) return null;
  const { needs, example } = STATE_KINDS[holds];
  return `${label} needs ${needs} state, but \`$${state}\` ${verb} ${DESCRIPTIONS[kind]}; declare it as \`$${state} = ${example}\``;
}

/**
 * A lossless reading of a state value an input can't hold as-is, or
 * undefined when there is none: text or a number where a list is needed
 * (`"a"` → `["a"]`, `""` → `[]`), numeric text where a number is, a number or
 * boolean where text is. Models often declare `$picked = ""` for a Checklist;
 * reading it this way keeps the UI working instead of failing it.
 */
export function coerceState(holds: StateKind | undefined, value: Value): Value | undefined {
  const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  if (holds === "list" && scalar) return value === "" ? [] : [value];
  if (holds === "number" && typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  if (holds === "text" && (typeof value === "number" || typeof value === "boolean")) return String(value);
  return undefined;
}

/** Params whose literal arguments can be type-checked before evaluation. */
const LITERAL_KINDS: Partial<Record<ParamKind, Kind>> = { list: "list", number: "number", boolean: "boolean" };

/** The kind an expression always evaluates to, when knowable without evaluating it. */
function staticKind(expr: Expr): Kind | undefined {
  switch (expr.type) {
    case "literal":
      return expr.value === null ? "null" : (typeof expr.value as "string" | "number" | "boolean");
    case "template":
      return "string";
    case "list":
      return "list";
    case "object":
      return "object";
    case "unary":
      return expr.op === "!" ? "boolean" : "number";
    default:
      return undefined;
  }
}

function signature(name: string, spec: ComponentSpec): string {
  const params = spec.params.filter((param) => param.legacy !== true && param.unlisted !== true).map(
    (param) => `${param.kind === "binding" ? "$" : ""}${param.name}${param.optional ? "?" : ""}`,
  );
  return `${name}(${params.join(", ")})`;
}

/** The source text of a synthesized state's initial, as shown in diagnostics. */
function formatInitial(value: Expr): string {
  if (value.type === "list") return "[]";
  if (value.type === "literal") return JSON.stringify(value.value) ?? "null";
  return "…";
}

function arityText([min, max]: Arity): string {
  if (max === Infinity) return `at least ${min} argument${min === 1 ? "" : "s"}`;
  if (min === max) return `${min} argument${min === 1 ? "" : "s"}`;
  return `${min} to ${max} arguments`;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** Local (bb-plugins): names agents reach for that the catalog spells another way. Never taught. */
const COMPONENT_ALIASES: ReadonlyMap<string, string> = new Map([
  ["TextInput", "Input"],
  ["TextField", "Input"],
]);

/** Local (bb-plugins): the one component or action spelled like `name` but for its case (`Textarea`). */
function uniqueCaseInsensitive(name: string): string | undefined {
  const lower = name.toLowerCase();
  const matches = [...COMPONENT_SPECS.keys(), ...ACTION_SPECS.keys()].filter((candidate) => candidate.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The lowercase words of a camelCase or snake_case name: `DatePicker` → date, picker. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

/**
 * Local (bb-plugins): " Did you mean `x`?" for a near miss, else up to
 * three candidates that share a word with `name` (`TextBox` → `TextArea`,
 * `DatePicker` → `DateInput`), else "".
 * Keeps an unknown-name error to one line instead of the whole catalog.
 */
export function closestNames(name: string, candidates: Iterable<string>, max = 3): string {
  const pool = [...candidates];
  // One near miss (`Cards`, `load`) is the answer on its own.
  const near = didYouMean(name, pool);
  if (near !== "") return near;
  const own = new Set(words(name));
  const ranked: { candidate: string; shared: number; distance: number }[] = [];
  for (const candidate of pool) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    const shared = words(candidate).filter((word) => own.has(word)).length;
    if (shared > 0) ranked.push({ candidate, shared, distance });
  }
  ranked.sort((a, b) => b.shared - a.shared || a.distance - b.distance);
  const picks = ranked.slice(0, max).map(({ candidate }) => `\`${candidate}\``);
  if (picks.length === 0) return "";
  const list = picks.length === 1 ? picks[0] : `${picks.slice(0, -1).join(", ")} or ${picks[picks.length - 1]}`;
  return ` Did you mean ${list}?`;
}

/** " Did you mean `x`?" for the closest candidate within edit distance 2, else "". */
export function didYouMean(name: string, candidates: Iterable<string>, render = (candidate: string) => candidate): string {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance && distance < name.length) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best === undefined ? "" : ` Did you mean \`${render(best)}\`?`;
}

/** Local (bb-plugins): text as written, a literal or a template. */
function isText(expr: Expr | undefined): expr is Extract<Expr, { type: "template" | "literal" }> {
  return expr !== undefined && (expr.type === "template" || (expr.type === "literal" && typeof expr.value === "string"));
}

const OPTION_VALUE_KEYS: ReadonlySet<string> = new Set(["label", "title", "name", "value"]);
const OPTION_DETAIL_KEYS: ReadonlySet<string> = new Set(["description", "detail"]);

/**
 * Local (bb-plugins): an option of a question written for Decision, as a
 * Radio option: text as is, `{label, description}` as `{value, detail}`.
 * Undefined for anything else (scores, pros, a computed item).
 */
function radioOption(item: Expr): Expr | undefined {
  if (isText(item)) return item;
  if (item.type !== "object") return undefined;
  if (!item.entries.every((entry) => OPTION_VALUE_KEYS.has(entry.key) || OPTION_DETAIL_KEYS.has(entry.key))) return undefined;
  const values = item.entries.filter((entry) => OPTION_VALUE_KEYS.has(entry.key));
  const details = item.entries.filter((entry) => OPTION_DETAIL_KEYS.has(entry.key));
  const [value] = values;
  const [detail] = details;
  if (value === undefined || values.length > 1 || !isText(value.value)) return undefined;
  if (detail !== undefined && (details.length > 1 || !isText(detail.value))) return undefined;
  const entries: { key: string; value: Expr; pos: Pos }[] = [{ key: "value", value: value.value, pos: value.pos }];
  if (detail !== undefined) entries.push({ key: "detail", value: detail.value, pos: detail.pos });
  return { type: "object", entries, pos: item.pos };
}

interface Ref {
  readonly name: string;
  readonly pos: Pos;
}

/** Everything one top-level expression reads. */
interface Refs {
  readonly named: Ref[];
  readonly states: Ref[];
}

/** Checks parsed statements against the catalog; reports into `diagnostics`. */
export function validate(statements: readonly Statement[], diagnostics: DiagnosticList): Program {
  return new Validator(diagnostics).run(statements);
}

class Validator {
  private readonly states = new Map<string, { readonly index: number; readonly decl: Decl }>();
  private readonly named = new Map<string, Decl>();
  /** `$state` declarations in source order, plus states synthesized by coercion. */
  private readonly stateDecls: Decl[] = [];
  /** Local (bb-plugins): config-object field names (`{name: "…"}`) and the states they bind. */
  private readonly fieldStates = new Map<string, string>();
  /** Local (bb-plugins): states a rewrite declared; a field name never binds one. */
  private readonly synthesized = new Set<string>();
  /** Local (bb-plugins): the Cards Decision questions became; a Form takes their Radio as its own field (evaluate.ts). */
  private readonly questions = new Set<Expr>();
  /** Top-level `Watch($state, Set(...))` rules in source order. */
  private readonly watches: WatchRule[] = [];

  constructor(private readonly diagnostics: DiagnosticList) {}

  run(statements: readonly Statement[]): Program {
    const roots: Expr[] = [];
    const rawWatches: CallExpr[] = [];
    for (const statement of statements) {
      if (statement.kind === "root") {
        if (
          statement.value.type === "call" &&
          (statement.value.name === "Watch" || statement.value.name === "watch")
        ) {
          rawWatches.push(statement.value);
        } else {
          roots.push(statement.value);
        }
        continue;
      }
      this.forbidden(statement.name, statement.pos);
      if (Object.hasOwn(CONSTANTS, statement.name)) {
        this.diagnostics.report(statement.pos, `\`${statement.name}\` is a built-in constant; give your value another name`);
      }
      const isState = statement.kind === "state";
      const previous = isState ? this.states.get(statement.name)?.decl : this.named.get(statement.name);
      if (previous !== undefined) {
        const label = isState ? `$${statement.name}` : statement.name;
        this.diagnostics.report(statement.pos, `\`${label}\` is already declared on line ${previous.pos.line}`);
      } else if (isState) {
        this.states.set(statement.name, { index: this.stateDecls.length, decl: statement });
        this.stateDecls.push(statement);
      } else {
        this.named.set(statement.name, statement);
      }
    }

    const used = new Set<string>();
    const namedRefs = new Map<string, Refs>();
    for (const [name, decl] of this.named) {
      const refs = this.declRefs(decl);
      namedRefs.set(name, refs);
      for (const ref of refs.named) if (ref.name !== name) used.add(ref.name);
    }
    for (const root of roots) for (const ref of this.refs(root).named) used.add(ref.name);
    for (const watch of rawWatches) {
      // A user-declared named function `watch = ...` still wins over the top-level statement.
      if (this.named.has(watch.name)) {
        roots.push(watch);
        for (const ref of this.refs(watch).named) used.add(ref.name);
        continue;
      }
      for (const ref of this.validateWatch(watch).named) used.add(ref.name);
    }

    const rootDecl = this.named.get("root");
    if (roots.length === 0) {
      if (rootDecl === undefined) {
        this.diagnostics.report(
          { line: 1, column: 1 },
          "Nothing to render: add a bare component expression such as Card(...)",
        );
      } else {
        roots.push({ type: "ident", name: "root", pos: rootDecl.pos });
        used.add("root");
      }
    }

    this.checkCycles(namedRefs);
    const statesOf = this.transitiveStates(namedRefs);
    this.stateDecls.forEach((decl, index) => {
      const refs = this.refs(decl.value);
      for (const ref of refs.named) used.add(ref.name);
      for (const ref of refs.states) {
        const target = this.states.get(ref.name);
        if (target === undefined || target.index < index) continue;
        this.diagnostics.report(
          ref.pos,
          target.index === index
            ? `\`$${decl.name}\` cannot use itself in its initial value`
            : `\`$${ref.name}\` is declared after \`$${decl.name}\`; initial values can only use earlier state`,
        );
      }
      for (const ref of refs.named) {
        const late = [...statesOf(ref.name)].find((name) => (this.states.get(name)?.index ?? -1) >= index);
        if (late !== undefined) {
          this.diagnostics.report(
            ref.pos,
            `\`${ref.name}\` reads \`$${late}\`, which is not initialized before \`$${decl.name}\``,
          );
        }
      }
    });

    for (const [name, decl] of this.named) {
      if (!used.has(name)) this.diagnostics.report(decl.pos, `\`${name}\` is never used`, "warning");
    }
    return {
      states: this.stateDecls,
      named: this.named,
      roots,
      ...(this.watches.length > 0 ? { watches: this.watches } : {}),
      questions: this.questions,
    };
  }

  /** Validates a top-level `Watch($state | [$a, $b], Set(...) | [Set(...)])` statement. */
  private validateWatch(call: CallExpr): Refs {
    const refs: Refs = { named: [], states: [] };
    if (call.name === "watch") {
      this.diagnostics.report(call.pos, "`watch` is written `Watch`", "warning");
    }
    let targetExpr: Expr | undefined = call.args[0];
    let actionExpr: Expr | undefined = call.args[1];
    if (call.args.length > 2) {
      this.diagnostics.report(call.args[2].pos, "too many arguments: Watch($state, action)");
    }
    for (const arg of call.named) {
      if (arg.name === "state" || arg.name === "target") {
        if (targetExpr !== undefined) this.diagnostics.report(arg.pos, `\`${arg.name}\` is given twice: Watch($state, action)`);
        else targetExpr = arg.value;
      } else if (arg.name === "action") {
        if (actionExpr !== undefined) this.diagnostics.report(arg.pos, "`action` is given twice: Watch($state, action)");
        else actionExpr = arg.value;
      } else {
        this.diagnostics.report(arg.pos, `\`Watch\` has no parameter \`${arg.name}\`: Watch($state, action)`);
      }
    }
    const targets: string[] = [];
    if (targetExpr === undefined) {
      this.diagnostics.report(call.pos, "`Watch` is missing its `$state` target: Watch($state, Set($other, value))");
    } else if (targetExpr.type === "state") {
      this.check(targetExpr, [], refs);
      targets.push(targetExpr.name);
    } else if (targetExpr.type === "list") {
      if (targetExpr.items.length === 0) {
        this.diagnostics.report(targetExpr.pos, "`Watch` target list cannot be empty");
      }
      for (const item of targetExpr.items) {
        if (item.type !== "state") {
          this.diagnostics.report(item.pos, "`Watch` targets must be state variables written as `$name`");
          this.check(item, [], refs);
        } else {
          this.check(item, [], refs);
          if (!targets.includes(item.name)) targets.push(item.name);
        }
      }
    } else {
      this.diagnostics.report(targetExpr.pos, "`Watch` first argument must be `$state` or `[$a, $b]`");
      this.check(targetExpr, [], refs);
    }

    if (actionExpr === undefined) {
      this.diagnostics.report(call.pos, "`Watch` is missing its action: Watch($state, Set($other, value))");
    } else {
      this.check(actionExpr, [], refs);
      this.checkWatchAction(actionExpr);
    }

    if (targets.length > 0 && actionExpr !== undefined) {
      this.watches.push({ targets, action: actionExpr, pos: call.pos });
    }
    return refs;
  }

  /** Rejects non-`Set` actions statically inside a `Watch` rule so watchers stay pure client-side state updates. */
  private checkWatchAction(expr: Expr): void {
    if (expr.type === "list") {
      for (const item of expr.items) this.checkWatchAction(item);
      return;
    }
    if (expr.type === "conditional") {
      this.checkWatchAction(expr.then);
      this.checkWatchAction(expr.else);
      return;
    }
    if (expr.type === "binary" && (expr.op === "&&" || expr.op === "||" || expr.op === "??")) {
      this.checkWatchAction(expr.right);
      return;
    }
    if (expr.type === "literal" && (expr.value === null || expr.value === false)) return;
    if (expr.type === "call") {
      if (expr.name === "Set") return;
      if (ACTION_SPECS.has(expr.name)) {
        this.diagnostics.report(expr.pos, `\`Watch\` can only run \`Set($state, value)\`, not \`${expr.name}\``);
        return;
      }
      if (COMPONENT_SPECS.has(expr.name) || FUNCTION_ARITY.has(expr.name)) {
        this.diagnostics.report(expr.pos, `\`Watch\` action must be \`Set($state, value)\`, got \`${expr.name}(...)\``);
      }
      return;
    }
    if (expr.type === "literal") {
      this.diagnostics.report(expr.pos, `\`Watch\` action must be \`Set($state, value)\`, got ${JSON.stringify(expr.value)}`);
    }
  }

  private refs(expr: Expr): Refs {
    const refs: Refs = { named: [], states: [] };
    this.check(expr, [], refs);
    return refs;
  }

  /** A named value's refs; a named function (`share = p => ...`) is checked with its parameters in scope. */
  private declRefs(decl: Decl): Refs {
    if (decl.value.type !== "arrow") return this.refs(decl.value);
    if (COMPONENT_SPECS.has(decl.name) || ACTION_SPECS.has(decl.name) || FUNCTION_ARITY.has(decl.name)) {
      this.diagnostics.report(decl.pos, `\`${decl.name}\` is a built-in name; give your function another name`);
    }
    const refs: Refs = { named: [], states: [] };
    this.check(decl.value.body, decl.value.params, refs);
    return refs;
  }

  private checkCycles(namedRefs: ReadonlyMap<string, Refs>): void {
    const status = new Map<string, "visiting" | "done">();
    const path: string[] = [];
    const visit = (name: string): void => {
      const current = status.get(name);
      if (current === "done") return;
      if (current === "visiting") {
        const cycle = [...path.slice(path.indexOf(name)), name];
        this.diagnostics.report(this.named.get(name)!.pos, `\`${name}\` depends on itself: ${cycle.join(" → ")}`);
        return;
      }
      status.set(name, "visiting");
      path.push(name);
      for (const ref of namedRefs.get(name)?.named ?? []) if (this.named.has(ref.name)) visit(ref.name);
      path.pop();
      status.set(name, "done");
    };
    for (const name of this.named.keys()) visit(name);
  }

  /** State names each named value reads, directly or through other named values. */
  private transitiveStates(namedRefs: ReadonlyMap<string, Refs>): (name: string) => ReadonlySet<string> {
    const memo = new Map<string, Set<string>>();
    const statesOf = (name: string): ReadonlySet<string> => {
      const cached = memo.get(name);
      if (cached !== undefined) return cached;
      const result = new Set<string>();
      memo.set(name, result); // cycles were reported; this stops the recursion
      const refs = namedRefs.get(name);
      for (const ref of refs?.states ?? []) result.add(ref.name);
      for (const ref of refs?.named ?? []) for (const state of statesOf(ref.name)) result.add(state);
      return result;
    };
    return statesOf;
  }

  private forbidden(name: string, pos: Pos): void {
    if ((FORBIDDEN_PROPERTIES as readonly string[]).includes(name)) {
      this.diagnostics.report(pos, `\`${name}\` is not accessible`);
    }
  }

  private check(expr: Expr, params: readonly string[], refs: Refs): void {
    switch (expr.type) {
      case "literal":
        return;
      case "template":
        for (const part of expr.parts) this.check(part, params, refs);
        return;
      case "state":
        if (!this.states.has(expr.name)) {
          const hint = this.named.has(expr.name)
            ? ` \`${expr.name}\` is a named value; write it without \`$\`.`
            : didYouMean(expr.name, this.states.keys(), (name) => `$${name}`) ||
              ` Declare it first, as in \`$${expr.name} = 0\`.`;
          this.diagnostics.report(expr.pos, `unknown state \`$${expr.name}\`.${hint}`);
        }
        refs.states.push(expr);
        return;
      case "ident":
        if (params.includes(expr.name) || Object.hasOwn(CONSTANTS, expr.name)) return;
        if (this.named.has(expr.name)) {
          if (this.named.get(expr.name)!.value.type === "arrow") {
            this.diagnostics.report(expr.pos, `\`${expr.name}\` is a function; call it, as in \`${expr.name}(...)\``);
          }
          refs.named.push(expr);
          return;
        }
        this.diagnostics.report(expr.pos, this.unknownName(expr.name, params));
        return;
      case "list":
        for (const item of expr.items) this.checkValue(item, params, refs);
        return;
      case "object":
        for (const entry of expr.entries) {
          this.forbidden(entry.key, entry.pos);
          this.checkValue(entry.value, params, refs);
        }
        return;
      case "unary":
        this.check(expr.operand, params, refs);
        return;
      case "binary":
        this.check(expr.left, params, refs);
        this.check(expr.right, params, refs);
        return;
      case "conditional":
        this.check(expr.test, params, refs);
        this.check(expr.then, params, refs);
        this.check(expr.else, params, refs);
        return;
      case "member":
        this.forbidden(expr.name, expr.pos);
        this.check(expr.object, params, refs);
        return;
      case "index":
        if (expr.index.type === "literal" && typeof expr.index.value === "string") {
          this.forbidden(expr.index.value, expr.index.pos);
        }
        this.check(expr.object, params, refs);
        this.check(expr.index, params, refs);
        return;
      case "arrow":
        this.diagnostics.report(expr.pos, ARROW_ONLY);
        this.check(expr.body, [...params, ...expr.params], refs);
        return;
      case "method":
        this.method(expr, params, refs);
        return;
      case "call":
        this.call(expr, params, refs);
        return;
    }
  }

  /**
   * An expression where a function may be a value (a list item, an object
   * value, a `function` param): an arrow, or a named function by name, which
   * the renderer calls later.
   */
  private checkValue(expr: Expr, params: readonly string[], refs: Refs): void {
    if (expr.type === "arrow") {
      this.check(expr.body, [...params, ...expr.params], refs);
    } else if (expr.type === "ident" && !params.includes(expr.name) && this.named.get(expr.name)?.value.type === "arrow") {
      refs.named.push(expr);
    } else {
      this.check(expr, params, refs);
    }
  }

  private unknownName(name: string, params: readonly string[]): string {
    if (this.states.has(name)) return `\`${name}\` is not defined. Did you mean \`$${name}\`?`;
    if (COMPONENT_SPECS.has(name) || ACTION_SPECS.has(name) || FUNCTION_ARITY.has(name)) {
      return `\`${name}\` must be called, as in \`${name}(...)\``;
    }
    const hint = didYouMean(name, [...params, ...this.named.keys(), ...Object.keys(CONSTANTS)]);
    return `\`${name}\` is not defined.${hint || ` Declare it first, as in \`${name} = ...\`.`}`;
  }

  private method(expr: Extract<Expr, { type: "method" }>, params: readonly string[], refs: Refs): void {
    this.check(expr.object, params, refs);
    for (const arg of expr.named) {
      this.diagnostics.report(arg.pos, "methods take positional arguments only");
      this.check(arg.value, params, refs);
    }
    const arity = METHOD_ARITY.get(expr.name);
    if (arity === undefined) {
      const hint = didYouMean(expr.name, METHOD_ARITY.keys(), (name) => `.${name}()`);
      this.diagnostics.report(
        expr.pos,
        `\`.${expr.name}()\` is not an allowed method.${hint} Lists: ${METHODS.list.join(", ")}. Text: ${METHODS.string.join(", ")}. Numbers: ${METHODS.number.join(", ")}.`,
      );
    } else if (expr.args.length < arity[0] || expr.args.length > arity[1]) {
      this.diagnostics.report(expr.pos, `\`.${expr.name}()\` takes ${arityText(arity)}`);
    }
    const [first, ...rest] = expr.args;
    if (LAMBDA_METHODS.has(expr.name) && first !== undefined) {
      if (first.type !== "arrow") {
        this.diagnostics.report(first.pos, `\`.${expr.name}()\` takes a function, as in \`x => x.price\``);
        this.check(first, params, refs);
      } else {
        if (first.params.length > 2) {
          this.diagnostics.report(first.pos, `\`.${expr.name}()\` passes (item, index); use at most 2 parameters`);
        }
        this.check(first.body, [...params, ...first.params], refs);
      }
    } else if (first !== undefined) {
      this.check(first, params, refs);
    }
    for (const arg of rest) this.check(arg, params, refs);
  }

  private call(expr: CallExpr, params: readonly string[], refs: Refs): void {
    this.coerceCallee(expr, params);
    const spec = COMPONENT_SPECS.get(expr.name) ?? ACTION_SPECS.get(expr.name);
    const own = this.named.get(expr.name)?.value;
    if (spec !== undefined) {
      this.catalogCall(expr, spec);
    } else if (own?.type === "arrow" && !params.includes(expr.name)) {
      if (expr.named.length > 0) {
        this.diagnostics.report(expr.named[0].pos, `\`${expr.name}\` takes positional arguments only`);
      }
      if (expr.args.length > own.params.length) {
        const count = own.params.length;
        this.diagnostics.report(expr.pos, `\`${expr.name}\` takes ${count} argument${count === 1 ? "" : "s"}`);
      }
      refs.named.push(expr);
    } else {
      if (expr.name === "Watch" || expr.name === "watch") {
        this.diagnostics.report(expr.pos, "`Watch` goes at the top level, outside components, like `$state = ...`");
      } else {
        const arity = FUNCTION_ARITY.get(expr.name);
        if (arity === undefined) {
          this.diagnostics.report(expr.pos, this.unknownCallee(expr.name, params));
        } else {
          if (expr.named.length > 0) {
            this.diagnostics.report(expr.named[0].pos, `\`${expr.name}\` takes positional arguments only`);
          }
          if (expr.args.length < arity[0] || expr.args.length > arity[1]) {
            this.diagnostics.report(expr.pos, `\`${expr.name}\` takes ${arityText(arity)}: ${FUNCTIONS[expr.name as FunctionName]}`);
          } else if (expr.name === "Load") {
            this.literalPath(expr.args[0], "Load");
          }
        }
      }
    }
    // A catalog `function` param takes an arrow or a named function as its value.
    const slots = [
      ...expr.args.map((value, index) => ({ value, param: spec?.params[index] })),
      ...expr.named.map((arg) => ({ value: arg.value, param: spec?.params.find((param) => param.name === arg.name) })),
    ];
    for (const { value, param } of slots) {
      if (param?.kind === "function") this.checkValue(value, params, refs);
      else this.check(value, params, refs);
    }
  }

  private unknownCallee(name: string, params: readonly string[]): string {
    if (this.named.has(name) || params.includes(name) || this.states.has(name)) {
      return `\`${name}\` is a value and cannot be called; only components, actions and functions can`;
    }
    const isFunctionLike = name[0] === name[0].toLowerCase();
    const candidates = [...TAUGHT_COMPONENTS, ...ACTION_SPECS.keys(), ...FUNCTION_ARITY.keys()];
    // Local (bb-plugins): name the closest few, never the whole catalog; the
    // full list filled a phone screen and the reference already has it.
    const fallback = isFunctionLike
      ? " The reference lists the functions."
      : " The reference lists the components; `ui_examples` shows each in use.";
    return `\`${name}\` is not a component, action or function.${closestNames(name, candidates) || fallback}`;
  }

  /** The host fetches files before evaluating, so the path must be readable from the source alone. */
  private literalPath(arg: Expr, owner: "Load" | "Snippet"): void {
    const path = loadPath(arg);
    if (path === null) {
      const usage =
        owner === "Load"
          ? '`Load` takes a plain string path, as in Load("data/sales.csv")'
          : '`Snippet` takes its path as a literal string, as in Snippet("src/app.ts", 10, 40)';
      this.diagnostics.report(
        arg.pos,
        `${usage}; the file is read before the UI runs, so the path cannot be computed or use \`\${}\``,
      );
    } else if (path.trim() === "") {
      this.diagnostics.report(arg.pos, `\`${owner}\` needs a file path`);
    }
  }

  /** Maps arguments onto catalog params and checks what is knowable before evaluation. */
  private catalogCall(expr: CallExpr, spec: ComponentSpec): void {
    const sig = signature(expr.name, spec);
    if (RETIRED.has(expr.name)) {
      // Local (bb-plugins): still rendered for replies written before it was retired; no prompt teaches it.
      this.diagnostics.report(expr.pos, `\`${expr.name}\` was retired; its pull requests are shown as links. The Source Control card shows a pull request's status`, "warning");
    }
    const slots: (Expr | undefined)[] = spec.params.map((_, index) => expr.args[index]);
    if (expr.args.length > spec.params.length) {
      this.diagnostics.report(expr.args[spec.params.length].pos, `too many arguments: ${sig}`);
    }
    let sourceDropped = false;
    let sawVisible = false;
    const isComponent = COMPONENT_SPECS.has(expr.name);
    for (const arg of expr.named) {
      if (isComponent && arg.name === "visible") {
        if (sawVisible) this.diagnostics.report(arg.pos, `\`visible\` is given twice: ${sig}`);
        sawVisible = true;
        continue;
      }
      const index = spec.params.findIndex((param) => param.name === arg.name);
      if (index < 0) {
        // Local (bb-plugins): `source:` where only Table, Chart and Metric caption one; dropped.
        if (arg.name === "source") {
          sourceDropped = true;
          this.diagnostics.report(arg.pos, `\`${expr.name}\` shows no \`source:\`; dropped it. Only ${SOURCE_COMPONENTS} caption a source`, "warning");
          continue;
        }
        const hint = didYouMean(arg.name, spec.params.map((param) => param.name));
        const why =
          hint === "" && Object.hasOwn(STYLE_ARGS, arg.name.toLowerCase())
            ? ` Components draw in BB's theme and take no style arguments${spec.params.some((param) => param.name === "tone") ? "; use `tone:` (good, warn, bad, info) for a status colour" : ""}.`
            : hint;
        this.diagnostics.report(arg.pos, `\`${expr.name}\` has no parameter \`${arg.name}\`.${why} ${sig}`);
      } else if (slots[index] !== undefined) {
        this.diagnostics.report(arg.pos, `\`${arg.name}\` is given twice: ${sig}`);
      } else {
        slots[index] = arg.value;
      }
    }
    if (sourceDropped) {
      // validate owns the parsed AST before it becomes the program (readonly is type-level).
      (expr as unknown as { named: NamedArg[] }).named = expr.named.filter((arg) => arg.name !== "source");
    }
    this.coerceSelectLabel(expr, spec, slots, sig);
    this.coerceOptionsFirst(expr, spec, slots, sig);
    this.coerceTabsItems(expr, spec, slots, sig);
    this.coerceConfigObject(expr, spec, slots, sig);
    this.coerceLiteralBindings(expr, spec, slots, sig);
    this.coerceUndeclaredBindings(expr, spec, slots, sig);
    this.coerceSingleCheck(expr, spec, slots);
    spec.params.forEach((param, index) => {
      const slot = slots[index];
      if (slot === undefined) {
        if (!param.optional) this.diagnostics.report(expr.pos, `\`${expr.name}\` is missing \`${param.name}\`: ${sig}`);
      } else {
        this.checkParam(expr.name, param, slot);
      }
    });
  }

  /**
   * The options-as-first-argument slip: `Checklist(["a", "b"])` gives the
   * choices but leaves out the `$state` the picks bind to. With at most one
   * positional argument a list literal can only be the options, so the call is
   * rewritten around a fresh state (`Checklist($checklist, ["a", "b"])`) as a
   * warning: the block renders, and its Source panel shows the corrected call.
   * Anything less unambiguous — more positional arguments, a value argument
   * that is not a list — keeps its own errors.
   */
  private coerceOptionsFirst(expr: CallExpr, spec: ComponentSpec, slots: (Expr | undefined)[], sig: string): void {
    const binding = spec.params[0];
    const optionsIndex = spec.params.findIndex((param, index) => index === 1 && param.kind === "list" && !param.optional);
    if (binding === undefined || binding.kind !== "binding" || optionsIndex < 0 || expr.args.length > 1) return;
    const positionalList = slots[0] !== undefined && slots[0].type === "list";
    if (slots[0] !== undefined && !positionalList) return;
    // Local (bb-plugins): with options given by name, a positional list is the value, not the options; keep its error.
    if (positionalList && expr.named.some((arg) => arg.name === spec.params[optionsIndex].name)) return;
    const list = slots[optionsIndex] ?? (positionalList ? slots[0] : undefined);
    if (list === undefined || list.type !== "list") return;
    const name = this.synthState(expr.name, binding.holds, expr.pos);
    slots[0] = { type: "state", name, pos: expr.pos };
    slots[optionsIndex] = list;
    // validate owns the parsed AST before it becomes the program: rewrite the
    // positional arguments to the corrected layout (the type-level readonly
    // guards against accidental writes; this one is deliberate). The options
    // stay positional when they were positional; a named options argument
    // keeps its named entry, so only the state goes positional.
    const args: Expr[] = [slots[0]!];
    if (positionalList) args.push(list);
    (expr as unknown as { args: Expr[] }).args = args;
    this.diagnostics.report(
      expr.pos,
      `\`${expr.name}\` got its options without a \`$state\` to store the picks in; bound them to \`$${name}\` (write the state yourself to name it): ${sig}`,
      "warning",
    );
  }

  /**
   * Tabs as tab cards: `Tabs([{title: "…", children: […]}, …])` — the model
   * wraps each tab in an object instead of the parallel `labels` and
   * `children` lists the component takes. When every item is exactly a title
   * plus a list of children, the call is split into those two lists as a
   * warning; anything else — extra keys, non-object items, a second argument —
   * keeps its errors, since the layout would then be a guess.
   */
  private coerceTabsItems(expr: CallExpr, spec: ComponentSpec, slots: (Expr | undefined)[], sig: string): void {
    if (expr.name !== "Tabs" || expr.args.length !== 1 || expr.named.length > 0) return;
    const labels = spec.params[0];
    const children = spec.params[1];
    if (labels?.name !== "labels" || labels.kind !== "list" || children?.kind !== "nodes" || children.optional) return;
    const items = slots[0];
    if (items === undefined || items.type !== "list" || slots[1] !== undefined) return;
    const titles: Expr[] = [];
    const panels: Expr[] = [];
    for (const item of items.items) {
      if (item.type !== "object" || item.entries.length !== 2) return;
      const title = item.entries.find(
        (entry) => (entry.key === "title" || entry.key === "label") && (entry.value.type === "literal" || entry.value.type === "template"),
      );
      const kids = item.entries.find((entry) => entry.key === "children" && entry.value.type === "list");
      if (title === undefined || kids === undefined) return;
      titles.push(title.value);
      panels.push(kids.value);
    }
    const labelsList: Expr = { type: "list", items: titles, pos: items.pos };
    const childrenList: Expr = { type: "list", items: panels, pos: items.pos };
    slots[0] = labelsList;
    slots[1] = childrenList;
    // validate owns the parsed AST before it becomes the program (readonly is type-level).
    (expr as unknown as { args: Expr[] }).args = [labelsList, childrenList];
    this.diagnostics.report(
      expr.pos,
      `\`${expr.name}\` got its tabs as one list of {title, children}; split them into parallel labels and children: ${sig}`,
      "warning",
    );
  }

  /**
   * The config-object slip: `Table({columns: […], rows: […]})` — the model
   * packs the arguments into one JS-style props object instead of positional
   * or named arguments. When the call is a single object argument and every
   * key of that object is a parameter name, the entries become named
   * arguments (warning). Only fires when the call would otherwise fail — a
   * required parameter missing or the object landing on a typed parameter it
   * does not fit — so data-shaped objects (KeyValue's map, Json's value) are
   * never touched; and any unknown key keeps the block's errors, since the
   * intent would no longer be clear.
   */
  private coerceConfigObject(expr: CallExpr, spec: ComponentSpec, slots: (Expr | undefined)[], sig: string): void {
    if (expr.args.length !== 1 || expr.named.length > 0) return;
    const obj = slots[0];
    if (obj === undefined || obj.type !== "object" || obj.entries.length === 0) return;
    const landing = spec.params[0];
    const wanted = landing === undefined ? undefined : LITERAL_KINDS[landing.kind];
    // A binding parameter always takes a `$state`: an object there is always
    // the config-object slip, never data.
    const missingRequired = spec.params.some((param, index) => !param.optional && index > 0 && slots[index] === undefined);
    const misplaced =
      (landing !== undefined && landing.kind === "binding") ||
      (wanted !== undefined && wanted !== "object" && !(landing.optional && obj.entries.every((entry) => entry.value.type === "literal" && entry.value.value === null)));
    if (!missingRequired && !misplaced) return;
    const named: NamedArg[] = [];
    let field: { readonly param: string; readonly field: string; readonly pos: Pos; readonly at: Pos } | undefined;
    for (const entry of obj.entries) {
      // Local (bb-plugins): `{name: "work"}` names the state an input binds,
      // as in an HTML form field; it becomes `value: $work`.
      const fieldName = this.fieldStateName(spec, entry, obj.entries);
      if (fieldName !== undefined && field === undefined) {
        field = { ...fieldName, pos: entry.value.pos, at: entry.pos };
        continue;
      }
      const isVisibleKey = COMPONENT_SPECS.has(expr.name) && entry.key === "visible";
      const param = spec.params.find((candidate) => candidate.name === entry.key);
      if ((!isVisibleKey && param === undefined) || slots.some((slot, index) => index > 0 && slot !== undefined && spec.params[index].name === entry.key)) return;
      named.push({ name: entry.key, value: entry.value, pos: entry.pos });
    }
    if (field !== undefined) {
      // Resolved only once the whole object is known to unwrap, so an abandoned rewrite claims no state name.
      const state = this.fieldState(field.field, expr.name);
      named.unshift({ name: field.param, value: { type: "state", name: state, pos: field.pos }, pos: field.at });
    }
    slots.fill(undefined);
    for (const arg of named) {
      const index = spec.params.findIndex((param) => param.name === arg.name);
      if (index >= 0) slots[index] = arg.value;
    }
    // validate owns the parsed AST before it becomes the program (readonly is type-level).
    const mutable = expr as unknown as { args: Expr[]; named: NamedArg[] };
    mutable.args = [];
    mutable.named = named;
    this.diagnostics.report(
      expr.pos,
      `\`${expr.name}\` got its arguments as one {...} object; the keys became named arguments (write them as \`name: value\` next time): ${sig}`,
      "warning",
    );
  }

  /** A fresh `$state`, unique across the program, for a synthesized binding. */
  private synthState(component: string, holds: ParamSpec["holds"], pos: Pos, initial?: Expr): string {
    const base = component.toLowerCase();
    let name = base;
    let n = 1;
    while (this.states.has(name) || this.named.has(name)) name = `${base}${++n}`;
    this.registerState(name, initial ?? this.initialFor(holds, pos), pos);
    this.synthesized.add(name);
    return name;
  }

  /**
   * Local (bb-plugins): the binding param a config object's `name:` or `id:`
   * key stands for, with that key's text as a state name. Undefined when the
   * key is something else, the component binds nothing, or the object also
   * gives the binding (`value:`) itself.
   */
  private fieldStateName(
    spec: ComponentSpec,
    entry: { readonly key: string; readonly value: Expr },
    entries: readonly { readonly key: string }[],
  ): { param: string; field: string } | undefined {
    if ((entry.key !== "name" && entry.key !== "id") || spec.params.some((param) => param.name === entry.key)) return undefined;
    const binding = spec.params.find((param) => param.kind === "binding");
    if (binding === undefined || entries.some((other) => other.key === binding.name)) return undefined;
    if (entry.value.type !== "literal" || typeof entry.value.value !== "string" || entry.value.value.trim() === "") return undefined;
    return { param: binding.name, field: entry.value.value.trim() };
  }

  /**
   * Local (bb-plugins): the state for a config-object field name. The same
   * field name always gets the same state, and distinct field names never
   * share one: `x-y` and `x y` both spell `x_y`, so the second becomes
   * `x_y2`, and a name with no ASCII letters (`имя`) is named after its
   * component (`input`, `input2`). A field name that is already an
   * identifier keeps its spelling (`_work`, `work_`), and binds the state the
   * block declares under that name; a normalized one never does.
   */
  private fieldState(field: string, component: string): string {
    const known = this.fieldStates.get(field);
    if (known !== undefined) return known;
    // A field name that is already an identifier (`_work`, `work_`) is the state's name as written.
    const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(field);
    const slug = valid ? field : field.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(?=\d)/, "_");
    const claimed = new Set(this.fieldStates.values());
    const own = valid || /[A-Za-z0-9]/.test(slug);
    const base = own ? slug : component.toLowerCase();
    // Only a field spelled exactly like a declared state binds it; a normalized one never lands on one.
    const taken = (name: string) =>
      claimed.has(name) || this.named.has(name) || this.synthesized.has(name) || (!(valid && name === field) && this.states.has(name));
    let name = base;
    let n = 1;
    while (taken(name)) name = `${base}${++n}`;
    this.fieldStates.set(field, name);
    return name;
  }

  /**
   * Local (bb-plugins): an input given its starting value instead of a state,
   * as in `TextArea("Ring first", label: "Notes")` or `Toggle(true)`. A scalar
   * the input can hold becomes a fresh state that starts at it (warning); one
   * it cannot hold, such as text for a Slider, keeps its error.
   */
  private coerceLiteralBindings(expr: CallExpr, spec: ComponentSpec, slots: (Expr | undefined)[], sig: string): void {
    spec.params.forEach((param, index) => {
      if (param.kind !== "binding") return;
      const slot = slots[index];
      if (slot === undefined) return;
      // Scalars only: a list could as well be the options (`Checklist(["a"], …)`), which stays an error.
      const kind = slot.type === "literal" ? staticKind(slot) : undefined;
      if (kind === undefined || kind === "null") return;
      if (param.holds !== undefined && !STATE_KINDS[param.holds].fits.includes(kind)) return;
      if (!this.literalIsStartingValue(spec, slots, slot)) return;
      const name = this.synthState(expr.name, param.holds, slot.pos, slot);
      const stateExpr: Expr = { type: "state", name, pos: slot.pos };
      // validate owns the parsed AST before it becomes the program (readonly is type-level).
      if (expr.args[index] === slot) (expr as unknown as { args: Expr[] }).args[index] = stateExpr;
      const namedArg = expr.named.find((arg) => arg.value === slot);
      if (namedArg !== undefined) (namedArg as { value: Expr }).value = stateExpr;
      slots[index] = stateExpr;
      this.diagnostics.report(
        slot.pos,
        `\`${expr.name}\` ${param.name} must be a \`$state\`; declared \`$${name} = ${formatInitial(slot)}\` for you to start from that value: ${sig}`,
        "warning",
      );
    });
  }

  /**
   * Local (bb-plugins): whether a literal in an input's value slot reads as
   * its starting value rather than a misplaced argument. A pick must be one
   * of the options given (`Choice("Plan", ["Basic", "Pro"])` is not), and
   * other text without a `label:` is more likely the label (`Input("Email")`).
   */
  private literalIsStartingValue(spec: ComponentSpec, slots: readonly (Expr | undefined)[], slot: Expr): boolean {
    if (slot.type !== "literal") return false;
    const optionsIndex = spec.params.findIndex((param) => param.name === "options" || param.name === "colors");
    if (optionsIndex < 0) {
      const labelIndex = spec.params.findIndex((param) => param.name === "label");
      return typeof slot.value !== "string" || labelIndex < 0 || slots[labelIndex] !== undefined;
    }
    const options = slots[optionsIndex];
    if (options === undefined || options.type !== "list") return false;
    return options.items.some((item) => {
      const value = item.type === "object" ? item.entries.find((entry) => entry.key === "value")?.value : item;
      return value?.type === "literal" && value.value === slot.value;
    });
  }

  /**
   * Local (bb-plugins): callee slips that have one clear reading. A name the
   * catalog spells differently (`TextInput` for `Input`, `Textarea` for
   * `TextArea`) is renamed, and `Form("Question?", [fields])`, which gives
   * Form a title it does not take, becomes `Card("Question?", [Form([fields])])`.
   * Each is a warning; the aliases stay out of the catalog so no prompt
   * teaches them.
   */
  private coerceCallee(expr: CallExpr, params: readonly string[]): void {
    if (this.named.has(expr.name) || params.includes(expr.name) || FUNCTION_ARITY.has(expr.name)) return;
    if (expr.name === "Decision") this.coerceDecisionQuestion(expr);
    if (!COMPONENT_SPECS.has(expr.name) && !ACTION_SPECS.has(expr.name)) {
      const target = COMPONENT_ALIASES.get(expr.name) ?? uniqueCaseInsensitive(expr.name);
      if (target === undefined) return;
      this.diagnostics.report(expr.pos, `\`${expr.name}\` is written \`${target}\``, "warning");
      (expr as { name: string }).name = target;
    }
    const [title, fields] = expr.args;
    if (
      expr.name === "Form" &&
      expr.args.length === 2 &&
      expr.named.length === 0 &&
      (title.type === "template" || (title.type === "literal" && typeof title.value === "string")) &&
      fields.type === "list"
    ) {
      // The inner Form takes the fields list's position, so its node key differs from the Card's.
      const form: Expr = { type: "call", name: "Form", args: [fields], named: [], pos: fields.pos };
      const mutable = expr as unknown as { name: string; args: Expr[] };
      mutable.name = "Card";
      mutable.args = [title, { type: "list", items: [form], pos: fields.pos }];
      this.diagnostics.report(
        expr.pos,
        "`Form` takes only its fields; put the question in a Card around it, as in `Card(\"Question?\", [Form([...])])`. Wrapped it for you",
        "warning",
      );
    }
  }

  /**
   * Local (bb-plugins): `Decision("Question?", [{label, description}, …])`
   * or `Decision({question, options})`: a question, not the options-against-
   * criteria table `Decision(options, criteria)` draws. With no criteria
   * and every option a text or a {label, description} object, the call
   * becomes `Card(null, [Form([Radio($decision, [{value, detail}, …],
   * label: question)])])` (warning), so the pick reaches the user's message
   * as "Question? answer"; a Form it is inside takes the Radio as its own
   * field when it evaluates. Anything else keeps its errors.
   */
  private coerceDecisionQuestion(expr: CallExpr): void {
    if (expr.named.length > 0) return;
    let question: Expr | undefined;
    let options: Expr | undefined;
    const [first, second] = expr.args;
    if (expr.args.length === 2 && isText(first)) {
      question = first;
      options = second;
    } else if (expr.args.length === 1 && first.type === "object") {
      if (!first.entries.every((entry) => entry.key === "question" || entry.key === "options")) return;
      question = first.entries.find((entry) => entry.key === "question")?.value;
      options = first.entries.find((entry) => entry.key === "options")?.value;
    }
    if (question === undefined || !isText(question) || options?.type !== "list" || options.items.length === 0) return;
    const items: Expr[] = [];
    for (const item of options.items) {
      const option = radioOption(item);
      if (option === undefined) return;
      items.push(option);
    }
    const name = this.synthState("Decision", "scalar", expr.pos);
    const radio: Expr = {
      type: "call",
      name: "Radio",
      args: [{ type: "state", name, pos: question.pos }, { type: "list", items, pos: options.pos }],
      named: [{ name: "label", value: question, pos: question.pos }],
      pos: question.pos,
    };
    // Card, Form and Radio each keep a distinct position, so their node keys differ.
    const form: Expr = { type: "call", name: "Form", args: [{ type: "list", items: [radio], pos: options.pos }], named: [], pos: options.pos };
    const mutable = expr as unknown as { name: string; args: Expr[] };
    mutable.name = "Card";
    mutable.args = [{ type: "literal", value: null, pos: expr.pos }, { type: "list", items: [form], pos: options.pos }];
    this.questions.add(expr);
    this.diagnostics.report(
      expr.pos,
      `\`Decision\` scores options against criteria; with none it is a question, so it became a Radio bound to \`$${name}\`. Write a question as \`Radio($pick, [{value, detail}], label: "Question?")\` in a Form`,
      "warning",
    );
  }

  /**
   * Local (bb-plugins): `Select("Region", ["eu", "us"])` (text that is not an
   * option) and `Select("region", "Region", ["eu", "us"])` (a field name, a
   * label, the options): the label stands where the `$state` goes. Both
   * become `Select($state, options, label: "Region")` (warning), with the
   * field name as the state's name when given. Text that is one of the
   * options stays its starting value (coerceLiteralBindings).
   */
  private coerceSelectLabel(expr: CallExpr, spec: ComponentSpec, slots: (Expr | undefined)[], sig: string): void {
    if (expr.name !== "Select" || expr.named.length > 0) return;
    const [first, second, third] = expr.args;
    let state: string;
    let label: Expr;
    let options: Expr;
    if (expr.args.length === 3 && first.type === "literal" && typeof first.value === "string" && first.value.trim() !== "" && isText(second) && third.type === "list") {
      state = this.fieldState(first.value.trim(), expr.name);
      if (!this.states.has(state)) this.registerState(state, this.initialFor("scalar", first.pos), first.pos);
      label = second;
      options = third;
    } else if (expr.args.length === 2 && isText(first) && second.type === "list" && !this.literalIsStartingValue(spec, slots, first)) {
      state = this.synthState(expr.name, "scalar", first.pos);
      label = first;
      options = second;
    } else {
      return;
    }
    const stateExpr: Expr = { type: "state", name: state, pos: first.pos };
    slots[0] = stateExpr;
    slots[1] = options;
    slots[2] = label;
    // validate owns the parsed AST before it becomes the program (readonly is type-level).
    const mutable = expr as unknown as { args: Expr[]; named: NamedArg[] };
    mutable.args = [stateExpr, options];
    mutable.named = [{ name: "label", value: label, pos: label.pos }];
    this.diagnostics.report(
      expr.pos,
      `\`Select\` got its label where its \`$state\` goes; bound the pick to \`$${state}\` and made the text its label: ${sig}`,
      "warning",
    );
  }

  /**
   * An input bound to a state that is never declared: `Input($addr, …)` with
   * no `$addr = …` anywhere, or the bare `Input(addr, …)` spelling. The model
   * clearly means a state with that name, so declare it with the kind's
   * neutral initial and say so — the input works instead of the block dying.
   * A name already taken by a named value keeps its own error (that one is a
   * genuine mixup between `$state` and `name = value`).
   */
  private coerceUndeclaredBindings(expr: CallExpr, spec: ComponentSpec, slots: (Expr | undefined)[], sig: string): void {
    spec.params.forEach((param, index) => {
      if (param.kind !== "binding") return;
      const slot = slots[index];
      if (slot === undefined) return;
      const name = slot.type === "state" || slot.type === "ident" ? slot.name : undefined;
      if (name === undefined || this.states.has(name) || this.named.has(name)) return;
      const value = this.initialFor(param.holds, slot.pos);
      this.registerState(name, value, slot.pos);
      if (slot.type === "ident") {
        // A bare spelling must become a real `$state` reference everywhere it
        // appears: positionally, or inside a named argument.
        const stateExpr: Expr = { type: "state", name, pos: slot.pos };
        if (expr.args[index] === slot) (expr as unknown as { args: Expr[] }).args[index] = stateExpr;
        const namedArg = expr.named.find((arg) => arg.value === slot);
        if (namedArg !== undefined) (namedArg as { value: Expr }).value = stateExpr;
        slots[index] = stateExpr;
      }
      this.diagnostics.report(
        slot.pos,
        `\`${expr.name}\` binds \`$${name}\`, which is never declared; declared \`$${name} = ${formatInitial(value)}\` for you (declare states yourself at the top to keep control): ${sig}`,
        "warning",
      );
    });
  }

  /** The neutral initial for a state kind: `[]` for a list, `""` for text/scalar. */
  private initialFor(holds: ParamSpec["holds"], pos: Pos): Expr {
    return holds === "list" ? { type: "list", items: [], pos } : { type: "literal", value: holds === "number" ? 0 : holds === "boolean" ? false : "", pos };
  }

  private registerState(name: string, value: Expr, pos: Pos): void {
    const decl: Decl = { name, value, pos };
    this.states.set(name, { index: this.stateDecls.length, decl });
    this.stateDecls.push(decl);
  }

  /** Coerces a single check (`checks: "required"` or `checks: {type: ...}`) into a 1-item list with a warning. */
  private coerceSingleCheck(expr: CallExpr, spec: ComponentSpec, slots: (Expr | undefined)[]): void {
    const index = spec.params.findIndex((param) => param.name === "checks");
    if (index < 0) return;
    const slot = slots[index];
    if (slot === undefined) return;
    const isSingle = (slot.type === "literal" && typeof slot.value === "string") || slot.type === "object";
    if (!isSingle) return;
    const wrapped: Expr = { type: "list", items: [slot], pos: slot.pos };
    slots[index] = wrapped;
    if (expr.args[index] === slot) (expr as unknown as { args: Expr[] }).args[index] = wrapped;
    const namedArg = expr.named.find((arg) => arg.value === slot);
    if (namedArg !== undefined) (namedArg as { value: Expr }).value = wrapped;
    this.diagnostics.report(
      slot.pos,
      `\`${expr.name}\` checks expects a list; wrapped it as \`[...]\``,
      "warning",
    );
  }

  /** Static compile-time check of literal `checks: [...]` entries. */
  private checkValidationRules(label: string, slot: Expr): void {
    if (slot.type !== "list") return;
    for (const item of slot.items) {
      if (item.type === "literal") {
        if (item.value === null || item.value === false) continue;
        if (typeof item.value === "string") {
          if (!(SHORTHAND_CHECKS as readonly string[]).includes(item.value)) {
            const hint = didYouMean(item.value, SHORTHAND_CHECKS);
            this.diagnostics.report(
              item.pos,
              `${label}: unknown shorthand check ${JSON.stringify(item.value)}.${hint} Use ${SHORTHAND_CHECKS.join(", ")} or an object check`,
            );
          }
        } else {
          this.diagnostics.report(item.pos, `${label}: each check must be a string (e.g. "required") or an object`);
        }
        continue;
      }
      if (item.type !== "object") continue;
      const typeEntry = item.entries.find((entry) => entry.key === "type");
      const hasValid = item.entries.some((entry) => entry.key === "valid" || entry.key === "ok");
      if (typeEntry === undefined) {
        if (!hasValid) {
          this.diagnostics.report(
            item.pos,
            `${label}: check object needs \`type: "..."\` or \`valid: <condition>\``,
          );
        }
        continue;
      }
      if (typeEntry.value.type !== "literal" || typeof typeEntry.value.value !== "string") continue;
      const typeName = typeEntry.value.value;
      if (!(CHECK_TYPES as readonly string[]).includes(typeName)) {
        const hint = closestNames(typeName, CHECK_TYPES);
        this.diagnostics.report(
          typeEntry.value.pos,
          `${label}: unknown check type ${JSON.stringify(typeName)}.${hint} Allowed: ${CHECK_TYPES.join(", ")}`,
        );
        continue;
      }
      const requiredKeys = CHECK_REQUIRED_KEYS[typeName as CheckType];
      if (requiredKeys !== undefined) {
        const argsEntry = item.entries.find((entry) => entry.key === "args");
        const argsKeys =
          argsEntry?.value.type === "object" ? argsEntry.value.entries.map((entry) => entry.key) : [];
        const present = requiredKeys.some(
          (key) => item.entries.some((entry) => entry.key === key) || argsKeys.includes(key),
        );
        if (!present && (argsEntry === undefined || argsEntry.value.type === "object")) {
          this.diagnostics.report(
            item.pos,
            `${label}: \`${typeName}\` check is missing \`${requiredKeys[0]}\``,
          );
        }
      }
      if (typeName === "pattern") {
        const argsEntry = item.entries.find((entry) => entry.key === "args");
        const patEntry =
          item.entries.find((entry) => entry.key === "pattern" || entry.key === "regex" || entry.key === "value") ??
          (argsEntry?.value.type === "object"
            ? argsEntry.value.entries.find((entry) => entry.key === "pattern" || entry.key === "regex" || entry.key === "value")
            : undefined);
        if (patEntry?.value.type === "literal" && typeof patEntry.value.value === "string") {
          const problem = regexProblem(patEntry.value.value);
          if (problem !== null) this.diagnostics.report(patEntry.value.pos, `${label}: ${problem}`);
        }
      }
    }
  }

  private checkParam(owner: string, param: ParamSpec, slot: Expr): void {
    const label = `\`${owner}\` ${param.name}`;
    if (owner === "Snippet" && param.name === "path") this.literalPath(slot, "Snippet");
    if (param.name === "checks") this.checkValidationRules(label, slot);
    // A bare state name (`plan` for `$plan`) is already reported with a `$` suggestion.
    const isBareState = slot.type === "ident" && this.states.has(slot.name);
    if (param.kind === "binding" && slot.type !== "state" && !isBareState) {
      this.diagnostics.report(slot.pos, `${label} must be a state variable written as \`$name\``);
    }
    if (param.kind === "binding" && slot.type === "state") {
      const initial = this.states.get(slot.name)?.decl.value;
      const kind = initial === undefined ? undefined : staticKind(initial);
      const mismatch = kind === undefined ? null : stateMismatch(label, param, slot.name, kind, "starts as");
      // A literal the input can read losslessly is only worth a warning.
      const coercible = initial?.type === "literal" && coerceState(param.holds, initial.value) !== undefined;
      if (mismatch !== null) this.diagnostics.report(slot.pos, mismatch, coercible ? "warning" : "error");
    }
    const wanted = LITERAL_KINDS[param.kind];
    const got = staticKind(slot);
    if (wanted !== undefined && got !== undefined && got !== wanted && !(got === "null" && (param.optional || param.nullable))) {
      this.diagnostics.report(slot.pos, `${label} needs ${EXPECTED[param.kind]}, got ${DESCRIPTIONS[got]}`);
    }
    if (param.kind === "enum" && slot.type === "literal" && !(slot.value === null && param.optional)) {
      const values = param.values ?? [];
      if (typeof slot.value !== "string" || !values.includes(slot.value)) {
        this.diagnostics.report(slot.pos, `${label} must be one of ${values.join(", ")}; got ${JSON.stringify(slot.value)}`);
      }
    }
    if (param.kind === "actions") {
      for (const item of slot.type === "list" ? slot.items : [slot]) {
        let got: string | undefined;
        if (item.type === "call" && (COMPONENT_SPECS.has(item.name) || FUNCTION_ARITY.has(item.name))) {
          got = `\`${item.name}(...)\``;
        } else if (item.type === "literal" && item.value !== null) {
          got = JSON.stringify(item.value);
        }
        if (got !== undefined) {
          this.diagnostics.report(item.pos, `${label} takes actions: ${ACTION_LIST}; got ${got}`);
        }
      }
    }
  }
}
