// Declarative input validation (`checks:`): pure built-in validators and
// expression checks evaluated identically by the core evaluator, Form answer
// staging, interaction prober, and React input components.
import { toNumber } from "./evaluate";
import type { Binding, UiNode, Value } from "./types";

export const SHORTHAND_CHECKS = ["required", "email", "url", "numeric"] as const;

export const CHECK_TYPES = [
  "required",
  "requiredIf",
  "email",
  "url",
  "numeric",
  "minLength",
  "maxLength",
  "min",
  "max",
  "pattern",
  "matches",
  "equalTo",
  "lessThan",
  "greaterThan",
] as const;

export type CheckType = (typeof CHECK_TYPES)[number];

const CHECK_TYPE_SET: ReadonlySet<string> = new Set(CHECK_TYPES);
const SHORTHAND_SET: ReadonlySet<string> = new Set(SHORTHAND_CHECKS);

/** Required parameter keys for parameterized check types (first is canonical). */
export const CHECK_REQUIRED_KEYS: Readonly<Partial<Record<CheckType, readonly string[]>>> = {
  minLength: ["min", "value"],
  maxLength: ["max", "value"],
  min: ["min", "value"],
  max: ["max", "value"],
  pattern: ["pattern", "regex", "value"],
  matches: ["other", "value"],
  equalTo: ["other", "value"],
  lessThan: ["other", "value"],
  greaterThan: ["other", "value"],
  requiredIf: ["when", "field", "enabled"],
};

const MAX_PATTERN_LENGTH = 256;
/** Pragmatic email check: one `@`, non-empty local part, domain with a 2+ char TLD, no spaces. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Catches obvious ReDoS nested quantifiers like `(a+)+`, `(a*)*`, `(\w+){2,}`. */
const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)[+*{]/;

type PlainObject = { readonly [key: string]: Value };

function isPlainObject(value: Value | undefined): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(
      "kind" in value &&
      (value.kind === "node" ||
        value.kind === "action" ||
        value.kind === "binding" ||
        value.kind === "function")
    )
  );
}

function isBinding(value: Value | undefined): value is Binding {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "binding";
}

function isTruthy(value: Value | undefined): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== "";
}

/** Whether a field value counts as empty for validation. */
export function isEmptyValue(value: Value, componentType?: string): boolean {
  if (value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "boolean") return value === false;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return true;
    return componentType === "Rating" ? value <= 0 : false;
  }
  return false;
}

/** Returns a reason `pattern` cannot be used safely as a RegExp, or null when safe. */
export function regexProblem(pattern: string): string | null {
  if (pattern.length === 0) return "`pattern` cannot be empty";
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `\`pattern\` is longer than ${MAX_PATTERN_LENGTH} characters`;
  }
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    return "`pattern` has nested quantifiers that can backtrack exponentially; simplify it";
  }
  try {
    new RegExp(pattern);
    return null;
  } catch (error) {
    return `invalid \`pattern\` regex: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Reads a check parameter from top-level keys or json-render's nested `args: { ... }` object. */
function checkArg(rule: PlainObject, keys: readonly string[]): Value | undefined {
  for (const key of keys) {
    if (Object.hasOwn(rule, key) && rule[key] !== undefined) return rule[key];
  }
  const args = rule.args;
  if (isPlainObject(args)) {
    const record: PlainObject = args;
    for (const key of keys) {
      if (Object.hasOwn(record, key) && record[key] !== undefined) return record[key];
    }
  }
  return undefined;
}

function customMessage(rule: PlainObject): string | null {
  return typeof rule.message === "string" && rule.message.trim() !== ""
    ? rule.message.trim()
    : null;
}

function isValidUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function compareValues(left: Value, right: Value): number | null {
  const a = toNumber(left);
  const b = toNumber(right);
  if (a !== null && b !== null) return a === b ? 0 : a < b ? -1 : 1;
  if (typeof left === "string" && typeof right === "string") {
    const lt = left.trim();
    const rt = right.trim();
    if (lt === "" || rt === "") return null;
    return lt === rt ? 0 : lt < rt ? -1 : 1;
  }
  return null;
}

function sameValue(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  const na = toNumber(a);
  const nb = toNumber(b);
  return na !== null && nb !== null && na === nb;
}

function lengthOf(value: Value): number | null {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  return null;
}

function formatBound(value: Value): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** Validates an evaluated `checks` list at runtime; returns the first structural error or null. */
export function validateCheckListRuntime(checks: readonly Value[]): string | null {
  for (const item of checks) {
    if (item === null || item === false) continue;
    if (typeof item === "string") {
      if (!SHORTHAND_SET.has(item)) {
        return `unknown check "${item}"; use ${SHORTHAND_CHECKS.join(", ")} or an object check`;
      }
      continue;
    }
    if (!isPlainObject(item)) {
      return 'each check must be a string (such as "required") or an object ({type: ...} or {valid: ...})';
    }
    const rule: PlainObject = item;
    const hasExpr = Object.hasOwn(rule, "valid") || Object.hasOwn(rule, "ok");
    const type = rule.type;
    if (type === undefined) {
      if (!hasExpr) return "check object needs `type` or `valid`";
      continue;
    }
    if (typeof type !== "string" || !CHECK_TYPE_SET.has(type)) {
      return `unknown check type ${JSON.stringify(type)}; allowed: ${CHECK_TYPES.join(", ")}`;
    }
    const checkType = type as CheckType;
    if (checkType === "pattern") {
      const raw = checkArg(rule, ["pattern", "regex", "value"]);
      if (typeof raw !== "string") return "`pattern` check needs a string `pattern`";
      const problem = regexProblem(raw);
      if (problem !== null) return problem;
    } else if (checkType === "minLength" || checkType === "maxLength") {
      const key = checkType === "minLength" ? "min" : "max";
      const bound = checkArg(rule, [key, "value"]);
      if (typeof bound !== "number" || !Number.isFinite(bound) || bound < 0) {
        return `\`${checkType}\` check needs a non-negative number \`${key}\``;
      }
    } else if (checkType === "min" || checkType === "max") {
      const key = checkType;
      const bound = checkArg(rule, [key, "value"]);
      if (
        bound === undefined ||
        bound === null ||
        (typeof bound !== "number" && typeof bound !== "string")
      ) {
        return `\`${checkType}\` check needs a number or string \`${key}\``;
      }
    } else if (
      checkType === "matches" ||
      checkType === "equalTo" ||
      checkType === "lessThan" ||
      checkType === "greaterThan"
    ) {
      const hasOther = checkArg(rule, ["other", "value"]) !== undefined;
      if (!hasOther) return `\`${checkType}\` check needs \`other\``;
    }
  }
  return null;
}

/** Evaluates one check item; returns an error message or null when valid/skipped. */
function evaluateOne(value: Value, item: Value, componentType?: string): string | null {
  if (item === null || item === false) return null;
  const empty = isEmptyValue(value, componentType);
  if (typeof item === "string") {
    switch (item) {
      case "required":
        return empty ? "Required" : null;
      case "email":
        return empty
          ? null
          : typeof value === "string" && EMAIL_RE.test(value.trim())
            ? null
            : "Enter a valid email";
      case "url":
        return empty
          ? null
          : typeof value === "string" && isValidUrl(value)
            ? null
            : "Enter a valid URL";
      case "numeric":
        return empty ? null : toNumber(value) !== null ? null : "Enter a valid number";
      default:
        return null;
    }
  }
  if (!isPlainObject(item)) return null;
  const rule: PlainObject = item;

  const msg = customMessage(rule);
  const type = typeof rule.type === "string" ? (rule.type as CheckType) : undefined;

  // Conditional guard (`when:` or json-render's `enabled:`) skips the check when falsy.
  if (type !== "requiredIf") {
    const hasGuard = Object.hasOwn(rule, "when") || Object.hasOwn(rule, "enabled");
    if (hasGuard) {
      const guard = Object.hasOwn(rule, "when") ? rule.when : rule.enabled;
      if (!isTruthy(guard)) return null;
    }
  }

  // Expression check: `{valid: expr, message?: "..."}` (alias `ok:`).
  if (type === undefined) {
    if (Object.hasOwn(rule, "valid")) return isTruthy(rule.valid) ? null : (msg ?? "Invalid value");
    if (Object.hasOwn(rule, "ok")) return isTruthy(rule.ok) ? null : (msg ?? "Invalid value");
    return null;
  }

  switch (type) {
    case "required":
      return empty ? (msg ?? "Required") : null;
    case "requiredIf": {
      const cond = checkArg(rule, ["when", "field", "enabled"]);
      return isTruthy(cond) && empty ? (msg ?? "Required") : null;
    }
    case "email":
      return empty
        ? null
        : typeof value === "string" && EMAIL_RE.test(value.trim())
          ? null
          : (msg ?? "Enter a valid email");
    case "url":
      return empty
        ? null
        : typeof value === "string" && isValidUrl(value)
          ? null
          : (msg ?? "Enter a valid URL");
    case "numeric":
      return empty ? null : toNumber(value) !== null ? null : (msg ?? "Enter a valid number");
    case "minLength": {
      if (empty) return null;
      const min = checkArg(rule, ["min", "value"]);
      const len = lengthOf(value);
      if (typeof min !== "number" || len === null) return null;
      const unit = Array.isArray(value)
        ? min === 1
          ? "item"
          : "items"
        : min === 1
          ? "character"
          : "characters";
      return len >= min ? null : (msg ?? `At least ${min} ${unit}`);
    }
    case "maxLength": {
      if (empty) return null;
      const max = checkArg(rule, ["max", "value"]);
      const len = lengthOf(value);
      if (typeof max !== "number" || len === null) return null;
      const unit = Array.isArray(value)
        ? max === 1
          ? "item"
          : "items"
        : max === 1
          ? "character"
          : "characters";
      return len <= max ? null : (msg ?? `At most ${max} ${unit}`);
    }
    case "min": {
      if (empty) return null;
      const min = checkArg(rule, ["min", "value"]);
      if (min === undefined || min === null) return null;
      const cmp = compareValues(value, min);
      if (cmp === null) return msg ?? `Must be at least ${formatBound(min)}`;
      return cmp >= 0 ? null : (msg ?? `Must be at least ${formatBound(min)}`);
    }
    case "max": {
      if (empty) return null;
      const max = checkArg(rule, ["max", "value"]);
      if (max === undefined || max === null) return null;
      const cmp = compareValues(value, max);
      if (cmp === null) return msg ?? `Must be at most ${formatBound(max)}`;
      return cmp <= 0 ? null : (msg ?? `Must be at most ${formatBound(max)}`);
    }
    case "pattern": {
      if (empty) return null;
      const source = checkArg(rule, ["pattern", "regex", "value"]);
      if (typeof source !== "string" || regexProblem(source) !== null) return null;
      const str = typeof value === "string" ? value : String(value);
      return new RegExp(source).test(str) ? null : (msg ?? "Invalid format");
    }
    case "matches":
    case "equalTo": {
      const other = checkArg(rule, ["other", "value"]);
      if (other === undefined) return null;
      if (empty && isEmptyValue(other)) return null;
      return sameValue(value, other) ? null : (msg ?? "Values must match");
    }
    case "lessThan": {
      const other = checkArg(rule, ["other", "value"]);
      if (empty || other === undefined || isEmptyValue(other)) return null;
      const cmp = compareValues(value, other);
      return cmp !== null && cmp < 0 ? null : (msg ?? `Must be less than ${formatBound(other)}`);
    }
    case "greaterThan": {
      const other = checkArg(rule, ["other", "value"]);
      if (empty || other === undefined || isEmptyValue(other)) return null;
      const cmp = compareValues(value, other);
      return cmp !== null && cmp > 0 ? null : (msg ?? `Must be greater than ${formatBound(other)}`);
    }
  }
}

/** Evaluates every check on a field value and returns unique failing error messages in order. */
export function evaluateChecks(
  value: Value,
  checks: readonly Value[] | undefined,
  componentType?: string,
): string[] {
  if (!Array.isArray(checks) || checks.length === 0) return [];
  const errors: string[] = [];
  for (const item of checks) {
    const message = evaluateOne(value, item, componentType);
    if (message !== null && !errors.includes(message)) errors.push(message);
  }
  return errors;
}

/** Validation errors for a bound input node, or [] when valid / unchecked. */
export function fieldErrors(node: UiNode): string[] {
  const props: Readonly<Record<string, Value>> = node.props;
  const binding = props.value;
  const checks = props.checks;
  if (!isBinding(binding) || !Array.isArray(checks)) return [];
  return evaluateChecks(binding.value, checks, node.type);
}

/** Whether any active check marks the field as required (for `aria-required`). */
export function isFieldRequired(checks: readonly Value[] | undefined): boolean {
  if (!Array.isArray(checks)) return false;
  return checks.some((item) => {
    if (item === "required") return true;
    if (!isPlainObject(item)) return false;
    const rule: PlainObject = item;
    if (rule.type === "required") {
      const hasGuard = Object.hasOwn(rule, "when") || Object.hasOwn(rule, "enabled");
      return !hasGuard || isTruthy(Object.hasOwn(rule, "when") ? rule.when : rule.enabled);
    }
    if (rule.type === "requiredIf") {
      return isTruthy(checkArg(rule, ["when", "field", "enabled"]));
    }
    return false;
  });
}
