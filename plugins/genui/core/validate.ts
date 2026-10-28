import type { CallExpr, Decl, Expr, Program, Statement } from "./ast";
import {
  ACTIONS,
  COMPONENTS,
  CONSTANTS,
  FORBIDDEN_PROPERTIES,
  FUNCTIONS,
  METHODS,
  type ComponentSpec,
  type FunctionName,
  type ParamKind,
  type ParamSpec,
  type StateKind,
} from "./catalog";
import type { DiagnosticList, Pos } from "./diagnostics";
import { loadPath } from "./data";
import type { Value } from "./types";

// Maps, not the catalog objects, so spec-controlled names like `constructor`
// never hit Object.prototype.
export const COMPONENT_SPECS: ReadonlyMap<string, ComponentSpec> = new Map(Object.entries(COMPONENTS));
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
    clamp: [3, 3], lerp: [3, 3], range: [2, 3], random: [1, 1],
  } satisfies Record<FunctionName, Arity>),
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
  const params = spec.params.filter((param) => param.legacy !== true).map(
    (param) => `${param.kind === "binding" ? "$" : ""}${param.name}${param.optional ? "?" : ""}`,
  );
  return `${name}(${params.join(", ")})`;
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

  constructor(private readonly diagnostics: DiagnosticList) {}

  run(statements: readonly Statement[]): Program {
    const stateDecls: Decl[] = [];
    const roots: Expr[] = [];
    for (const statement of statements) {
      if (statement.kind === "root") {
        roots.push(statement.value);
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
        this.states.set(statement.name, { index: stateDecls.length, decl: statement });
        stateDecls.push(statement);
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
    stateDecls.forEach((decl, index) => {
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
    return { states: stateDecls, named: this.named, roots };
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
    const candidates = [...COMPONENT_SPECS.keys(), ...ACTION_SPECS.keys(), ...FUNCTION_ARITY.keys()];
    const fallback = isFunctionLike
      ? ` Functions: ${[...FUNCTION_ARITY.keys()].join(", ")}.`
      : ` Components: ${[...COMPONENT_SPECS.keys()].join(", ")}.`;
    return `\`${name}\` is not a component, action or function.${didYouMean(name, candidates) || fallback}`;
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
    const slots: (Expr | undefined)[] = spec.params.map((_, index) => expr.args[index]);
    if (expr.args.length > spec.params.length) {
      this.diagnostics.report(expr.args[spec.params.length].pos, `too many arguments: ${sig}`);
    }
    for (const arg of expr.named) {
      const index = spec.params.findIndex((param) => param.name === arg.name);
      if (index < 0) {
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
    spec.params.forEach((param, index) => {
      const slot = slots[index];
      if (slot === undefined) {
        if (!param.optional) this.diagnostics.report(expr.pos, `\`${expr.name}\` is missing \`${param.name}\`: ${sig}`);
      } else {
        this.checkParam(expr.name, param, slot);
      }
    });
  }

  private checkParam(owner: string, param: ParamSpec, slot: Expr): void {
    const label = `\`${owner}\` ${param.name}`;
    if (owner === "Snippet" && param.name === "path") this.literalPath(slot, "Snippet");
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
