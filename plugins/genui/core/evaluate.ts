import type { ArrowExpr, CallExpr, Expr, Program } from "./ast";
import { CONSTANTS, FORBIDDEN_PROPERTIES, LIMITS, type ComponentName, type ComponentSpec, type ParamSpec } from "./catalog";
import { DiagnosticList, type Pos } from "./diagnostics";
import { dataKey, languageOf, loadsReached, snippetLines, snippetRangeError, type LoadedData } from "./data";
import { sceneErrors } from "./scene";
import { shaderErrors } from "./shader-args";
import type { Action, Binding, Diagnostic, FunctionValue, UiNode, UiState, Value } from "./types";
import {
  ACTION_SPECS,
  ARROW_ONLY,
  COMPONENT_SPECS,
  coerceState,
  DESCRIPTIONS,
  EXPECTED,
  LAMBDA_METHODS,
  stateMismatch,
  type Kind,
} from "./validate";

/** Longest string any operation may produce; repeated doubling would otherwise exhaust memory. */
const MAX_STRING_LENGTH = 100_000;
/** Deepest expression nesting during evaluation (named values included), so the stack cannot overflow. */
const MAX_EVAL_DEPTH = 1_000;
/** Data for callers that load no files: every `Load` reports it is still loading, every `Snippet` shows its loading state. */
const NO_DATA: ReadonlyMap<string, LoadedData> = new Map();
/** Components that credit the files their data came from (`loadedFrom`) when no `source:` says where. */
const SOURCED: Partial<Record<string, true>> = { Table: true, Chart: true, Metric: true };
/**
 * Per program, the files each sourced call's arguments Load, found once by
 * following its names to their definitions: evaluation runs on every input
 * change, the program only changes with the text.
 */
const LOADED_FROM = new WeakMap<Program, Map<CallExpr, readonly string[]>>();

abstract class EvalFailure extends Error {
  constructor(
    readonly pos: Pos,
    message: string,
  ) {
    super(message);
  }
}

/** A problem local to one component: it becomes an Error node, siblings still render. */
class RuntimeError extends EvalFailure {}

/** A resource limit: evaluation stops. */
class LimitError extends EvalFailure {}

/**
 * A `Load` whose file is still being read. It travels like a RuntimeError, so
 * whatever used the value waits too, but the component becomes a Loading
 * placeholder instead of an Error, and it is no diagnostic.
 */
class LoadPending extends RuntimeError {
  constructor(
    pos: Pos,
    readonly path: string,
  ) {
    super(pos, `Loading ${path}…`);
  }
}

function kindOf(value: Value): Kind {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "list";
  // Object literals cannot carry these `kind` values (see the "object" case), so they mark interpreter output.
  if ("kind" in value && (value.kind === "node" || value.kind === "action" || value.kind === "binding" || value.kind === "function")) {
    return value.kind;
  }
  return "object";
}

function describe(value: Value): string {
  return DESCRIPTIONS[kindOf(value)];
}

function isList(value: Value): value is readonly Value[] {
  return Array.isArray(value);
}

type PlainObject = { readonly [key: string]: Value };

/** A spec-language or loaded-data object, as opposed to interpreter-made nodes, actions and bindings. */
export function isPlainObject(value: Value): value is PlainObject {
  return kindOf(value) === "object";
}

function isNode(value: Value): value is UiNode {
  return kindOf(value) === "node";
}

function isAction(value: Value): value is Action {
  return kindOf(value) === "action";
}

function truthy(value: Value): boolean {
  return value !== null && value !== false && value !== 0 && value !== "";
}

/** Non-finite arithmetic results become null. */
function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function checkString(text: string, pos: Pos): string {
  if (text.length > MAX_STRING_LENGTH) {
    throw new RuntimeError(pos, `text longer than ${MAX_STRING_LENGTH} characters`);
  }
  return text;
}

function checkLength<T extends readonly Value[]>(list: T, pos: Pos): T {
  if (list.length > LIMITS.listLength) {
    throw new RuntimeError(pos, `lists are limited to ${LIMITS.listLength} items (got ${list.length})`);
  }
  return list;
}

/** Text for `+`, templates and `join`: null is empty, other scalars use String(). */
function toText(value: Value, pos: Pos): string {
  if (value === null) return "";
  if (typeof value === "object") {
    throw new RuntimeError(pos, `cannot turn ${describe(value)} into text${isList(value) ? '; use .join(", ")' : ""}`);
  }
  return String(value);
}

function compare(op: string, left: number | string, right: number | string): boolean {
  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    default:
      return left >= right;
  }
}

const BITS = new DataView(new ArrayBuffer(8));

/**
 * `random(i)`: a 0–1 hash of the number's bits (murmur3's finalizer over both
 * halves), so a scene's scattered stars are the same on every render and
 * device, unlike Math.random.
 */
function random(i: number): number {
  BITS.setFloat64(0, i === 0 ? 0 : i); // -0 hashes as 0
  let h = BITS.getUint32(0) ^ Math.imul(BITS.getUint32(4) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4_294_967_296;
}

/** Rounds half away from zero, exact for decimal inputs like 1.005. */
function roundTo(value: number, digits: number): number {
  const magnitude = Math.abs(value);
  let rounded = Number(`${Math.round(Number(`${magnitude}e${digits}`))}e${-digits}`);
  if (!Number.isFinite(rounded)) rounded = Math.round(magnitude * 10 ** digits) / 10 ** digits;
  return value < 0 ? -rounded : rounded;
}

/** `1234.5` → "1,234.5"; fixed `digits`, or up to 2 with trailing zeros trimmed. */
function fmt(value: number, digits: number | undefined): string {
  let fixed = roundTo(value, digits ?? 2).toFixed(digits ?? 2);
  if (digits === undefined) fixed = fixed.replace(/\.0+$|(\.\d*?)0+$/, "$1");
  const [whole, fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** The expression passed for `params[index]`, positionally or by name. */
function argument(call: CallExpr, params: readonly ParamSpec[], index: number): Expr | undefined {
  return index < call.args.length ? call.args[index] : call.named.find((arg) => arg.name === params[index].name)?.value;
}

interface Scope {
  readonly name: string;
  readonly value: Value;
  readonly parent: Scope | null;
}

class Interpreter {
  readonly diagnostics = new DiagnosticList();
  private steps = 0;
  /** LIMITS.steps for the evaluation; LIMITS.functionSteps while a FunctionValue runs. */
  private stepLimit: number = LIMITS.steps;
  private nodes = 0;
  private depth = 0;
  /** `#index` per enclosing map iteration, appended to node keys. */
  private suffix = "";
  private readonly cache = new Map<string, { readonly value: Value } | { readonly error: RuntimeError }>();

  constructor(
    private readonly program: Program,
    private readonly state: UiState,
    private readonly data: ReadonlyMap<string, LoadedData>,
  ) {}

  /** Reports a failure (a load still in flight is none) and restores the evaluation context saved before it; rethrows anything else. */
  recover(error: unknown, depth: number, suffix: string): EvalFailure {
    if (!(error instanceof EvalFailure)) throw error;
    this.depth = depth;
    this.suffix = suffix;
    if (!(error instanceof LoadPending)) this.diagnostics.report(error.pos, error.message);
    return error;
  }

  expr(expr: Expr, scope: Scope | null): Value {
    if (++this.steps > this.stepLimit) {
      throw new LimitError(
        expr.pos,
        this.stepLimit === LIMITS.steps
          ? `the UI needs more than ${LIMITS.steps} evaluation steps; simplify it`
          : `one call of this function needs more than ${this.stepLimit} evaluation steps; simplify it`,
      );
    }
    if (++this.depth > MAX_EVAL_DEPTH) throw new LimitError(expr.pos, "expressions are nested too deeply");
    const value = this.compute(expr, scope);
    this.depth--;
    return value;
  }

  /**
   * An expression where a function may be a value (a list item, an object
   * value, a `function` param): an arrow, or a named function by name,
   * becomes a FunctionValue over `scope`.
   */
  private value(expr: Expr, scope: Scope | null): Value {
    if (expr.type === "arrow") return this.closure(expr, scope);
    if (expr.type === "ident") {
      let shadowed = false;
      for (let current = scope; current !== null && !shadowed; current = current.parent) shadowed = current.name === expr.name;
      const own = this.program.named.get(expr.name)?.value;
      // A named function sees only its parameters and top-level names (as callOwn).
      if (!shadowed && own?.type === "arrow") return this.closure(own, null);
    }
    return this.expr(expr, scope);
  }

  private closure(fn: ArrowExpr, scope: Scope | null): FunctionValue {
    const suffix = this.suffix;
    return { kind: "function", params: fn.params, call: (args) => this.callClosure(fn, scope, suffix, args) };
  }

  /**
   * Runs a FunctionValue: during this evaluation (a Scene read at t = 0) or
   * any time after (each frame). It gets its own step budget and leaves the
   * interpreter as it found it, so the renderer can call it again and again.
   */
  private callClosure(fn: ArrowExpr, scope: Scope | null, suffix: string, args: readonly Value[]): { value: Value; error: string | null } {
    const saved = { steps: this.steps, stepLimit: this.stepLimit, nodes: this.nodes, depth: this.depth, suffix: this.suffix };
    this.steps = 0;
    this.stepLimit = LIMITS.functionSteps;
    this.suffix = suffix;
    let inner = scope;
    fn.params.forEach((name, index) => {
      inner = { name, value: index < args.length ? args[index] : null, parent: inner };
    });
    try {
      return { value: this.expr(fn.body, inner), error: null };
    } catch (error) {
      if (error instanceof EvalFailure) return { value: null, error: error.message };
      // A JS stack overflow or the like: still never thrown at the renderer.
      return { value: null, error: error instanceof Error ? error.message : String(error) };
    } finally {
      Object.assign(this, saved);
    }
  }

  private compute(expr: Expr, scope: Scope | null): Value {
    switch (expr.type) {
      case "literal":
        return expr.value;
      case "template": {
        let text = expr.quasis[0];
        expr.parts.forEach((part, index) => {
          text += toText(this.expr(part, scope), part.pos) + expr.quasis[index + 1];
        });
        return checkString(text, expr.pos);
      }
      case "state":
        return Object.hasOwn(this.state, expr.name) ? this.state[expr.name] : null;
      case "ident":
        for (let current = scope; current !== null; current = current.parent) {
          if (current.name === expr.name) return current.value;
        }
        if (Object.hasOwn(CONSTANTS, expr.name)) return CONSTANTS[expr.name];
        return this.named(expr.name, expr.pos);
      case "list":
        return checkLength(
          expr.items.map((item) => this.value(item, scope)),
          expr.pos,
        );
      case "object": {
        const object: Record<string, Value> = {};
        for (const entry of expr.entries) {
          const value = this.value(entry.value, scope);
          if (entry.key === "kind" && (value === "node" || value === "action" || value === "binding" || value === "function")) {
            throw new RuntimeError(entry.pos, `\`kind: "${value}"\` is reserved; use another key or value`);
          }
          object[entry.key] = value;
        }
        return object;
      }
      case "unary": {
        const operand = this.expr(expr.operand, scope);
        return expr.op === "!" ? !truthy(operand) : finite(-this.number(operand, expr.pos, "`-`"));
      }
      case "binary":
        return this.binary(expr, scope);
      case "conditional":
        return truthy(this.expr(expr.test, scope)) ? this.expr(expr.then, scope) : this.expr(expr.else, scope);
      case "member":
        return this.member(this.expr(expr.object, scope), expr.name, expr.pos);
      case "index":
        return this.index(this.expr(expr.object, scope), this.expr(expr.index, scope), expr.pos);
      case "call": {
        const component = COMPONENT_SPECS.get(expr.name);
        if (component !== undefined) return this.component(expr, component, scope);
        const action = ACTION_SPECS.get(expr.name);
        if (action !== undefined) return this.action(expr, action, scope);
        const own = this.program.named.get(expr.name)?.value;
        if (own?.type === "arrow") return this.callOwn(expr, own, scope);
        return this.callFunction(expr, scope);
      }
      case "method":
        return this.method(expr, scope);
      case "arrow":
        throw new RuntimeError(expr.pos, ARROW_ONLY);
    }
  }

  private named(name: string, pos: Pos): Value {
    const cached = this.cache.get(name);
    if (cached !== undefined) {
      if ("error" in cached) throw cached.error;
      return cached.value;
    }
    const decl = this.program.named.get(name);
    if (decl === undefined) throw new RuntimeError(pos, `\`${name}\` is not defined`);
    if (decl.value.type === "arrow") throw new RuntimeError(pos, `\`${name}\` is a function; call it, as in \`${name}(...)\``);
    // Named values are top-level: their nodes never take the keys of the map that reads them.
    const suffix = this.suffix;
    this.suffix = "";
    try {
      const value = this.expr(decl.value, null);
      this.cache.set(name, { value });
      this.suffix = suffix;
      return value;
    } catch (error) {
      if (error instanceof RuntimeError) this.cache.set(name, { error });
      throw error;
    }
  }

  private number(value: Value, pos: Pos, label: string): number {
    if (typeof value !== "number") throw new RuntimeError(pos, `${label} needs a number, got ${describe(value)}`);
    return value;
  }

  private text(value: Value, pos: Pos, label: string): string {
    if (typeof value !== "string") throw new RuntimeError(pos, `${label} needs text, got ${describe(value)}`);
    return value;
  }

  private digits(value: Value, pos: Pos, label: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 20) {
      throw new RuntimeError(pos, `${label} digits must be a whole number from 0 to 20`);
    }
    return value;
  }

  private binary(expr: Extract<Expr, { type: "binary" }>, scope: Scope | null): Value {
    const op = expr.op;
    const left = this.expr(expr.left, scope);
    if (op === "&&") return truthy(left) ? this.expr(expr.right, scope) : left;
    if (op === "||") return truthy(left) ? left : this.expr(expr.right, scope);
    if (op === "??") return left === null ? this.expr(expr.right, scope) : left;
    const right = this.expr(expr.right, scope);
    switch (op) {
      case "==":
      case "===":
        return left === right;
      case "!=":
      case "!==":
        return left !== right;
      case "+":
        if (typeof left === "string" || typeof right === "string") {
          return checkString(toText(left, expr.left.pos) + toText(right, expr.right.pos), expr.pos);
        }
        if (typeof left === "number" && typeof right === "number") return finite(left + right);
        throw new RuntimeError(expr.pos, `\`+\` needs numbers or text, got ${describe(left)} and ${describe(right)}`);
      case "<":
      case "<=":
      case ">":
      case ">=":
        if (typeof left === "number" && typeof right === "number") return compare(op, left, right);
        if (typeof left === "string" && typeof right === "string") return compare(op, left, right);
        throw new RuntimeError(expr.pos, `\`${op}\` compares two numbers or two texts, got ${describe(left)} and ${describe(right)}`);
    }
    const a = this.number(left, expr.left.pos, `\`${op}\``);
    const b = this.number(right, expr.right.pos, `\`${op}\``);
    switch (op) {
      case "-":
        return finite(a - b);
      case "*":
        return finite(a * b);
      case "/":
        return finite(a / b);
      case "%":
        return finite(a % b);
      case "**":
        return finite(a ** b);
    }
  }

  private member(object: Value, name: string, pos: Pos): Value {
    if (object === null) return null;
    if (isPlainObject(object)) {
      // Narrowing keeps structurally compatible Action shapes; widen to read by key.
      const record: PlainObject = object;
      return Object.hasOwn(record, name) ? record[name] : null;
    }
    if (isList(object) || typeof object === "string") {
      if (name === "length") return object.length;
      throw new RuntimeError(pos, `${describe(object)} only has \`.length\`; \`.${name}\` does not exist`);
    }
    throw new RuntimeError(pos, `cannot read \`.${name}\` of ${describe(object)}`);
  }

  private index(object: Value, index: Value, pos: Pos): Value {
    if (object === null) return null;
    if (isList(object) || typeof object === "string") {
      const at = this.number(index, pos, "an index");
      return Number.isInteger(at) && at >= 0 && at < object.length ? object[at] : null;
    }
    if (isPlainObject(object)) {
      const record: PlainObject = object;
      const key = this.text(index, pos, "an object key");
      if ((FORBIDDEN_PROPERTIES as readonly string[]).includes(key)) {
        throw new RuntimeError(pos, `\`${key}\` is not accessible`);
      }
      return Object.hasOwn(record, key) ? record[key] : null;
    }
    throw new RuntimeError(pos, `cannot index ${describe(object)}`);
  }

  private node(type: UiNode["type"], key: string, props: Record<string, Value>, pos: Pos): UiNode {
    if (++this.nodes > LIMITS.nodes) throw new LimitError(pos, `the UI has more than ${LIMITS.nodes} components`);
    return { kind: "node", type, key, props };
  }

  private component(call: CallExpr, spec: ComponentSpec, scope: Scope | null): UiNode {
    const key = `${call.pos.line}:${call.pos.column}${this.suffix}`;
    // COMPONENT_SPECS only holds catalog names.
    const type = call.name as ComponentName;
    const depth = this.depth;
    const suffix = this.suffix;
    try {
      const props: Record<string, Value> = {};
      spec.params.forEach((param, index) => {
        const arg = argument(call, spec.params, index);
        if (arg === undefined) return;
        const value = this.param(param, arg, scope, `${call.name} ${param.name}`, key);
        if (value !== undefined) props[param.name] = value;
      });
      if (SOURCED[type] && props.source === undefined) {
        const from = this.loadedFrom(call, spec);
        if (from.length > 0) props.loadedFrom = from;
      }
      const problems = type === "Scene" ? sceneErrors(props, 0) : type === "Shader" ? shaderErrors(props) : [];
      if (problems.length > 0) {
        const more = problems.length > 3 ? `; and ${problems.length - 3} more` : "";
        throw new RuntimeError(call.pos, `${type}: ${problems.slice(0, 3).join("; ")}${more}`);
      }
      return this.node(type, key, type === "Snippet" ? this.snippet(props) : props, call.pos);
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      const failure = this.recover(error, depth, suffix);
      return failure instanceof LoadPending
        ? this.node("Loading", key, { path: failure.path, component: type }, call.pos)
        : this.node("Error", key, { message: failure.message }, call.pos);
    }
  }

  /** The files `call`'s data arguments (all but `source`) read with Load. */
  private loadedFrom(call: CallExpr, spec: ComponentSpec): readonly string[] {
    let calls = LOADED_FROM.get(this.program);
    if (calls === undefined) LOADED_FROM.set(this.program, (calls = new Map()));
    let from = calls.get(call);
    if (from === undefined) {
      const data = spec.params.flatMap((param, index) => {
        const arg = param.name === "source" ? undefined : argument(call, spec.params, index);
        return arg === undefined ? [] : [arg];
      });
      from = loadsReached(this.program, data);
      calls.set(call, from);
    }
    return from;
  }

  /**
   * Snippet props: the requested range plus its lines from the raw file. A file
   * still loading is `code: null` (the renderer shows a placeholder), and a
   * file or range problem is `error`, never an Error node.
   */
  private snippet(props: Readonly<Record<string, Value>>): Record<string, Value> {
    // `path` is a required string param and the others optional numbers, so these are the evaluated values.
    const path = typeof props.path === "string" ? props.path : "";
    const from = typeof props.from === "number" ? props.from : null;
    const to = typeof props.to === "number" ? props.to : null;
    const loaded = this.data.get(dataKey({ path, raw: true }));
    const rangeError = snippetRangeError(from, to);
    let shown: { code: string | null; error: string | null };
    if (rangeError !== null) shown = { code: null, error: rangeError };
    else if (loaded === undefined) shown = { code: null, error: null };
    else if (!loaded.ok) shown = { code: null, error: loaded.error };
    else if (typeof loaded.value !== "string") shown = { code: null, error: "not a text file" };
    else shown = snippetLines(loaded.value, from, to);
    return { path, from, to, code: shown.code, error: shown.error, language: languageOf(path) };
  }

  /** Evaluates and normalizes one argument; `undefined` means an optional param passed as null. */
  private param(param: ParamSpec, arg: Expr, scope: Scope | null, label: string, key: string): Value | undefined {
    if (param.kind === "binding") {
      if (arg.type !== "state") throw new RuntimeError(arg.pos, `${label} must be a state variable written as \`$name\``);
      const value = Object.hasOwn(this.state, arg.name) ? this.state[arg.name] : null;
      // Set() or a computed initial value can still give the state the wrong
      // type; a lossless reading keeps the input working, anything else fails.
      const mismatch = stateMismatch(label, param, arg.name, kindOf(value), "holds");
      const coerced = mismatch === null ? value : coerceState(param.holds, value);
      if (coerced === undefined) throw new RuntimeError(arg.pos, mismatch!);
      const binding: Binding = { kind: "binding", name: arg.name, value: coerced };
      return binding;
    }
    const value = param.kind === "function" ? this.value(arg, scope) : this.expr(arg, scope);
    if (param.kind === "nodes") return this.children(value, arg.pos, label, key);
    if (param.kind === "actions") return this.actions(value, arg.pos, label);
    if (value === null) {
      if (param.optional) return undefined;
      if (param.nullable || param.kind === "any") return null;
    }
    switch (param.kind) {
      case "string":
      case "text":
        if (value !== null && typeof value !== "object") return String(value);
        break;
      case "number":
        if (typeof value === "number") return value;
        break;
      case "boolean":
        if (typeof value === "boolean") return value;
        break;
      case "enum": {
        const values = param.values ?? [];
        if (typeof value === "string" && values.includes(value)) return value;
        const got = typeof value === "string" ? JSON.stringify(value) : describe(value);
        throw new RuntimeError(arg.pos, `${label} must be one of ${values.join(", ")}; got ${got}`);
      }
      case "list":
        if (isList(value)) return value;
        break;
      case "series": {
        const isNumbers = (item: Value) => isList(item) && item.every((n) => typeof n === "number" || n === null);
        // A named series may carry its own tone: {name: {values, tone}}. Widened to read by key: narrowing keeps Action shapes.
        const isSeries = (item: Value) => {
          if (isNumbers(item)) return true;
          if (!isPlainObject(item)) return false;
          const toned: PlainObject = item;
          return isNumbers(toned.values ?? null);
        };
        if (isNumbers(value) || (isPlainObject(value) && Object.values(value).every(isSeries))) return value;
        break;
      }
      case "function":
      case "any":
        return value;
    }
    throw new RuntimeError(arg.pos, `${label} needs ${EXPECTED[param.kind]}, got ${describe(value)}`);
  }

  /** Flattens children: strings/numbers become Text nodes, null/false are dropped. */
  children(value: Value, pos: Pos, label: string, key: string): UiNode[] {
    const out: UiNode[] = [];
    const visit = (item: Value): void => {
      if (item === null || item === false) return;
      if (typeof item === "string" || typeof item === "number") {
        out.push(this.node("Text", `${key}.${out.length}`, { text: String(item) }, pos));
      } else if (isList(item)) {
        for (const child of item) visit(child);
      } else if (isNode(item)) {
        out.push(item);
      } else {
        throw new RuntimeError(pos, `${label} must be components or text, got ${describe(item)}`);
      }
    };
    visit(value);
    return out;
  }

  private actions(value: Value, pos: Pos, label: string): Action[] {
    const out: Action[] = [];
    const visit = (item: Value): void => {
      if (item === null || item === false) return;
      if (isList(item)) {
        for (const child of item) visit(child);
      } else if (isAction(item)) {
        out.push(item);
      } else {
        throw new RuntimeError(pos, `${label} takes actions such as Send("..."), got ${describe(item)}`);
      }
    };
    visit(value);
    return out;
  }

  private action(call: CallExpr, spec: ComponentSpec, scope: Scope | null): Action {
    // Every action has a required first param; the validator guarantees it is present.
    const first = argument(call, spec.params, 0)!;
    if (call.name === "Set") {
      if (first.type !== "state") throw new RuntimeError(first.pos, "Set needs a state variable written as `$name`");
      const second = argument(call, spec.params, 1)!;
      return { kind: "action", type: "set", name: first.name, value: this.expr(second, scope) };
    }
    const value = this.expr(first, scope);
    if (value === null || typeof value === "object") {
      throw new RuntimeError(first.pos, `${call.name} needs text, got ${describe(value)}`);
    }
    const text = String(value);
    switch (call.name) {
      case "Send":
        return { kind: "action", type: "send", text };
      case "Copy":
        return { kind: "action", type: "copy", text };
      case "OpenUrl":
        if (!/^https?:\/\//i.test(text)) throw new RuntimeError(first.pos, "OpenUrl needs an http:// or https:// URL");
        return { kind: "action", type: "openUrl", url: text };
    }
    throw new RuntimeError(call.pos, `unknown action \`${call.name}\``);
  }

  /** Numbers in a list; nulls are skipped. */
  private numbers(value: Value, pos: Pos, label: string): number[] {
    if (!isList(value)) throw new RuntimeError(pos, `${label} needs a list of numbers, got ${describe(value)}`);
    const out: number[] = [];
    for (const item of value) if (item !== null) out.push(this.number(item, pos, label));
    return out;
  }

  private callFunction(call: CallExpr, scope: Scope | null): Value {
    const args = call.args.map((arg) => this.expr(arg, scope));
    const name = call.name;
    const numberAt = (index: number) => this.number(args[index], call.args[index].pos, `${name}()`);
    const digitsAt = (index: number) =>
      index < args.length ? this.digits(args[index], call.args[index].pos, `${name}()`) : undefined;
    switch (name) {
      case "round":
        return finite(roundTo(numberAt(0), digitsAt(1) ?? 0));
      case "fmt":
        return fmt(numberAt(0), digitsAt(1));
      case "abs":
        return Math.abs(numberAt(0));
      case "floor":
        return Math.floor(numberAt(0));
      case "ceil":
        return Math.ceil(numberAt(0));
      case "sqrt":
        return finite(Math.sqrt(numberAt(0)));
      case "pow":
        return finite(numberAt(0) ** numberAt(1));
      case "sin":
      case "cos":
      case "tan":
      case "asin":
      case "acos":
      case "atan":
        return finite(Math[name](numberAt(0)));
      case "atan2":
        return finite(Math.atan2(numberAt(0), numberAt(1)));
      case "clamp":
        return Math.min(numberAt(2), Math.max(numberAt(1), numberAt(0)));
      case "lerp":
        return finite(numberAt(0) + (numberAt(1) - numberAt(0)) * numberAt(2));
      case "range": {
        const start = numberAt(0);
        const step = args.length > 2 ? numberAt(2) : 1;
        if (step === 0) throw new RuntimeError(call.args[2].pos, "range() step cannot be 0");
        const count = Math.max(0, Math.ceil((numberAt(1) - start) / step));
        if (count > LIMITS.listLength) {
          throw new RuntimeError(call.pos, `range() would make ${count} items; lists are limited to ${LIMITS.listLength}`);
        }
        // start + i * step, not repeated addition, so the 100th item carries no accumulated error.
        return Array.from({ length: count }, (_, index) => start + index * step);
      }
      case "random":
        return random(numberAt(0));
      case "sum":
        return finite(this.numbers(args[0], call.args[0].pos, "sum()").reduce((total, n) => total + n, 0));
      case "min":
      case "max": {
        const values =
          args.length === 1 && isList(args[0])
            ? this.numbers(args[0], call.args[0].pos, `${name}()`)
            : args.map((_, index) => numberAt(index));
        if (values.length === 0) return null;
        return name === "min" ? Math.min(...values) : Math.max(...values);
      }
      case "keys":
      case "values":
      case "entries": {
        const object = args[0];
        if (!isPlainObject(object)) throw new RuntimeError(call.args[0].pos, `${name}() needs an object, got ${describe(object)}`);
        const pairs = Object.entries(object);
        return checkLength(
          name === "keys" ? pairs.map(([key]) => key) : name === "values" ? pairs.map(([, value]) => value) : pairs,
          call.pos,
        );
      }
      case "Load": {
        const path = this.text(args[0], call.args[0].pos, "Load()");
        const loaded = this.data.get(dataKey({ path, raw: false }));
        if (loaded === undefined) throw new LoadPending(call.pos, path);
        if (!loaded.ok) throw new RuntimeError(call.pos, `Couldn't load ${path}: ${loaded.error}`);
        return loaded.value;
      }
    }
    throw new RuntimeError(call.pos, `\`${name}\` is not a function`);
  }

  /**
   * A named function (`share = p => ...`). Its body sees its parameters and
   * top-level names only; missing arguments are null. Nodes it makes are keyed
   * by the call site too, so two calls never share component state.
   */
  private callOwn(call: CallExpr, fn: ArrowExpr, scope: Scope | null): Value {
    const args = call.args.map((arg) => this.expr(arg, scope));
    let inner: Scope | null = null;
    for (const [index, name] of fn.params.entries()) {
      inner = { name, value: index < args.length ? args[index] : null, parent: inner };
    }
    const base = this.suffix;
    this.suffix = `${base}@${call.pos.line}:${call.pos.column}`;
    try {
      return this.expr(fn.body, inner);
    } finally {
      this.suffix = base;
    }
  }

  private method(call: Extract<Expr, { type: "method" }>, scope: Scope | null): Value {
    const receiver = this.expr(call.object, scope);
    if (isList(receiver) && LAMBDA_METHODS.has(call.name)) return this.lambdaMethod(receiver, call, scope);
    const args = call.args.map((arg) => this.expr(arg, scope));
    const label = `.${call.name}()`;
    const textAt = (index: number) => this.text(args[index], call.args[index].pos, label);
    const bounds = () => args.map((arg, index) => this.number(arg, call.args[index].pos, label));
    if (isList(receiver)) {
      switch (call.name) {
        case "join":
          return checkString(
            receiver.map((item) => toText(item, call.pos)).join(args.length > 0 ? textAt(0) : ","),
            call.pos,
          );
        case "slice":
          return receiver.slice(...bounds());
        case "includes":
          return receiver.includes(args[0]);
        case "indexOf":
          return receiver.indexOf(args[0]);
      }
    } else if (typeof receiver === "string") {
      switch (call.name) {
        case "includes":
          return receiver.includes(textAt(0));
        case "startsWith":
          return receiver.startsWith(textAt(0));
        case "endsWith":
          return receiver.endsWith(textAt(0));
        case "slice":
          return receiver.slice(...bounds());
        case "split":
          return checkLength(receiver.split(textAt(0)), call.pos);
        case "trim":
          return receiver.trim();
        case "toUpperCase":
          return receiver.toUpperCase();
        case "toLowerCase":
          return receiver.toLowerCase();
      }
    } else if (typeof receiver === "number" && call.name === "toFixed") {
      const digits = args.length > 0 ? this.digits(args[0], call.args[0].pos, label) : 0;
      return roundTo(receiver, digits).toFixed(digits);
    }
    throw new RuntimeError(call.pos, `\`${label}\` is not available on ${describe(receiver)}`);
  }

  private lambdaMethod(list: readonly Value[], call: Extract<Expr, { type: "method" }>, scope: Scope | null): Value {
    checkLength(list, call.pos);
    const fn = call.args[0];
    if (fn?.type !== "arrow") throw new RuntimeError(call.pos, `\`.${call.name}()\` takes a function, as in \`x => x.price\``);
    const [itemName, indexName] = fn.params;
    const apply = (item: Value, index: number): Value => {
      let inner = scope;
      if (itemName !== undefined) inner = { name: itemName, value: item, parent: inner };
      if (indexName !== undefined) inner = { name: indexName, value: index, parent: inner };
      return this.expr(fn.body, inner);
    };
    switch (call.name) {
      case "map": {
        const base = this.suffix;
        const out = list.map((item, index) => {
          this.suffix = `${base}#${index}`;
          return apply(item, index);
        });
        this.suffix = base;
        return out;
      }
      case "filter":
        return list.filter((item, index) => truthy(apply(item, index)));
      case "find":
        return list.find((item, index) => truthy(apply(item, index))) ?? null;
      case "some":
        return list.some((item, index) => truthy(apply(item, index)));
      default:
        return list.every((item, index) => truthy(apply(item, index)));
    }
  }
}

/** `$state` initial values in declaration order; an initializer that fails yields null. */
export function initialState(program: Program, data = NO_DATA): Record<string, Value> {
  const values: Record<string, Value> = {};
  const interpreter = new Interpreter(program, values, data);
  for (const decl of program.states) {
    try {
      values[decl.name] = interpreter.expr(decl.value, null);
    } catch (error) {
      interpreter.recover(error, 0, "");
      values[decl.name] = null;
    }
  }
  return values;
}

/** Renders the program's roots against `state`, with `data` holding the files `Load` and `Snippet` read (keyed by `dataKey`). Failures become Error nodes plus diagnostics. */
export function evaluate(
  program: Program,
  state: UiState,
  data = NO_DATA,
): { roots: UiNode[]; diagnostics: Diagnostic[] } {
  const interpreter = new Interpreter(program, state, data);
  const roots: UiNode[] = [];
  for (const expr of program.roots) {
    const key = `${expr.pos.line}:${expr.pos.column}`;
    try {
      roots.push(...interpreter.children(interpreter.expr(expr, null), expr.pos, "a bare expression", key));
    } catch (error) {
      const failure = interpreter.recover(error, 0, "");
      roots.push(
        failure instanceof LoadPending
          ? { kind: "node", type: "Loading", key, props: { path: failure.path, component: null } }
          : { kind: "node", type: "Error", key, props: { message: failure.message } },
      );
      if (failure instanceof LimitError) break;
    }
  }
  return { roots, diagnostics: interpreter.diagnostics.items };
}
