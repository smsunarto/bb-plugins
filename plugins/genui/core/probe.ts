// Tries a spec's inputs the way a reader would, before the reader does: each
// slider and stepper at its ends, each toggle flipped, each option picked,
// lists emptied and filled, text cleared, each Set button pressed. A block
// that renders cleanly at its initial state can still fail on the first drag
// (`100 / $n` at `$n = 0`, a price table missing the option just picked);
// check_ui reports those so the agent fixes them before replying.
import type { Program } from "./ast";
import type { LoadedData } from "./data";
import { evaluate } from "./evaluate";
import type { Binding, Diagnostic, UiNode, UiState, Value } from "./types";

/** Interactions tried per block, as in Zeron's visual preflight. */
export const MAX_PROBES = 24;

/** Rating's star count when the spec gives none (ui/components/fieldLogic.ts). */
const RATING_MAX_DEFAULT = 5;

export interface Probe {
  /** State name without the `$`. */
  readonly name: string;
  readonly value: Value;
  /** How the reader gets there, e.g. `setting $n to 0`. */
  readonly describe: string;
}

export interface ProbeFailure {
  readonly probe: Probe;
  /** Errors this interaction causes that the initial render doesn't have. */
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProbeReport {
  /** Interactions tried, at most MAX_PROBES. */
  readonly tried: number;
  readonly failures: readonly ProbeFailure[];
}

/**
 * Evaluates `program` once per interaction its inputs offer, each from
 * `state`, and returns the errors each one adds to `initial` (the evaluation
 * at `state`).
 */
export function probeInteractions(
  program: Program,
  state: UiState,
  initial: { readonly roots: readonly UiNode[]; readonly diagnostics: readonly Diagnostic[] },
  data?: ReadonlyMap<string, LoadedData>,
): ProbeReport {
  const baseline = new Set(initial.diagnostics.map(diagnosticKey));
  const probes = interactions(initial.roots, state).slice(0, MAX_PROBES);
  const failures: ProbeFailure[] = [];
  for (const probe of probes) {
    const { diagnostics } = evaluate(program, { ...state, [probe.name]: probe.value }, data);
    const added = diagnostics.filter((d) => d.severity === "error" && !baseline.has(diagnosticKey(d)));
    if (added.length > 0) failures.push({ probe, diagnostics: added });
  }
  return { tried: probes.length, failures };
}

/** The distinct interactions the inputs in `roots` offer, minus ones that change nothing. */
export function interactions(roots: readonly UiNode[], state: UiState): Probe[] {
  const probes: Probe[] = [];
  const seen = new Set<string>();
  const add = (name: string, value: Value, describe: string) => {
    const key = `${name}=${JSON.stringify(value)}`;
    if (seen.has(key) || JSON.stringify(state[name] ?? null) === JSON.stringify(value)) return;
    seen.add(key);
    probes.push({ name, value, describe });
  };
  visit(roots, (node) => {
    for (const [name, value, describe] of nodeProbes(node)) add(name, value, describe);
  });
  return probes;
}

function nodeProbes(node: UiNode): [string, Value, string][] {
  const { props } = node;
  if (node.type === "Button") return setActions(props.action);
  const binding = isBinding(props.value) ? props.value : null;
  if (binding === null) return [];
  const $ = `$${binding.name}`;
  const to = (value: Value, describe = `setting ${$} to ${show(value)}`): [string, Value, string] => [binding.name, value, describe];
  switch (node.type) {
    case "Slider": {
      const min = finite(props.min) ?? 0;
      return [to(min), to(Math.max(min, finite(props.max) ?? 100))];
    }
    case "Stepper":
      return [finite(props.min), finite(props.max)].filter((end): end is number => end !== null).map((end) => to(end));
    case "Rating":
      return [to(0), to(Math.max(1, Math.round(finite(props.max) ?? RATING_MAX_DEFAULT)))];
    case "Toggle":
      return [to(binding.value !== true)];
    case "Choice":
    case "Radio":
    case "Select":
      return list(props.options).map((option) => to(optionValue(option), `picking ${show(optionValue(option))} for ${$}`));
    case "OptionCards": {
      const values = list(props.options).map(optionValue);
      if (Array.isArray(binding.value)) return [to([], `clearing ${$}`), to(values, `picking every option for ${$}`)];
      return values.map((value) => to(value, `picking ${show(value)} for ${$}`));
    }
    case "Swatches":
      return list(props.colors).map((color) => to(optionValue(color), `picking ${show(optionValue(color))} for ${$}`));
    case "Checklist":
      return [to([], `clearing ${$}`), to(list(props.options).map(optionValue), `checking every option for ${$}`)];
    case "ListEditor":
    case "EditableTable":
      return [to([], `removing every row of ${$}`)];
    case "Input":
    case "TextArea":
    case "DateInput":
      return [to("", `clearing ${$}`)];
    default:
      return [];
  }
}

function setActions(action: Value | undefined): [string, Value, string][] {
  return list(action).flatMap((item): [string, Value, string][] =>
    isObject(item) && item.kind === "action" && item.type === "set" && typeof item.name === "string"
      ? [[item.name, item.value ?? null, `pressing a button that sets $${item.name} to ${show(item.value ?? null)}`]]
      : [],
  );
}

function visit(value: Value | readonly UiNode[], onNode: (node: UiNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, onNode);
    return;
  }
  if (!isObject(value) || value.kind !== "node") return;
  const node = value as unknown as UiNode;
  onNode(node);
  for (const prop of Object.values(node.props)) visit(prop, onNode);
}

/** An option is its own value, or an object's `value`. */
function optionValue(option: Value): Value {
  return isObject(option) && "value" in option ? (option.value ?? null) : option;
}

function show(value: Value): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function diagnosticKey(d: Diagnostic): string {
  return `${d.line}:${d.column}:${d.message}`;
}

function finite(value: Value | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: Value | undefined): readonly Value[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: Value | undefined): value is { readonly [key: string]: Value } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBinding(value: Value | undefined): value is Binding {
  return isObject(value) && value.kind === "binding" && typeof value.name === "string";
}
