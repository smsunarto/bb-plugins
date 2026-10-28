// What a Form answers: a `Label: answer` line per field, which the answer
// sheet (ui/answerSheet.ts) puts in the user's message as they fill it in.
import type { ComponentName } from "./catalog";
import type { Binding, UiNode, Value } from "./types";

/** The inputs a Form collects, in any layout inside it. */
const FIELDS: Partial<Record<ComponentName, true>> = {
  Slider: true,
  Stepper: true,
  Toggle: true,
  Choice: true,
  Radio: true,
  Select: true,
  Checklist: true,
  ListEditor: true,
  Input: true,
  TextArea: true,
  DateInput: true,
  Rating: true,
  OptionCards: true,
  // Only a bound Swatches is a field; a palette has no value to send.
  Swatches: true,
};

/** Fields the user types into: their answer waits for a pause in the typing. */
const TYPED: Partial<Record<ComponentName, true>> = { Input: true, TextArea: true, ListEditor: true, DateInput: true };

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function isNode(value: Value): value is UiNode {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "node";
}

function isBinding(value: Value | undefined): value is Binding {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "binding";
}

/** A field value as message text; "" when empty. */
function answer(value: Value): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? NUMBER.format(value) : "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(answer).filter((item) => item !== "").join(", ");
  return JSON.stringify(value);
}

/** The values a multi-select offers: Checklist scalars, or OptionCards `{value}` (its title when it has none). */
function optionValues(options: Value | undefined): Value[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option): Value[] => {
    if (option === null) return [];
    if (typeof option !== "object") return [option];
    if (Array.isArray(option) || "kind" in option) return [];
    const record: Readonly<Record<string, Value>> = option;
    const value = record.value;
    if (value !== undefined && value !== null && typeof value !== "object") return [value];
    return typeof record.title === "string" && record.title.trim() !== "" ? [record.title] : [];
  });
}

/**
 * A multi-select's answer: what was picked, in option order, and what was
 * not, so the agent learns both: `CSV, JSON (not: XLSX, PDF)`; nothing
 * picked says so with the options; everything picked says `(all)`.
 */
function picks(picked: readonly Value[], options: readonly Value[]): string {
  const shown = (values: readonly Value[]) => values.map(answer).filter((item) => item !== "").join(", ");
  if (options.length === 0) return shown(picked);
  const chosen = [...options.filter((option) => picked.includes(option)), ...picked.filter((value) => !options.includes(value))];
  const left = options.filter((option) => !picked.includes(option));
  if (chosen.length === 0) return `none (options: ${shown(options)})`;
  if (left.length === 0) return `${shown(chosen)} (all)`;
  return `${shown(chosen)} (not: ${shown(left)})`;
}

/** A field of a Form: the state it binds and how its line reads. */
export interface FormField {
  readonly name: string;
  /** The user types into it (Input, TextArea, ListEditor, DateInput). */
  readonly typed: boolean;
  readonly line: string;
}

/** Every field at any depth, in document order. */
function collect(value: Value, fields: FormField[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, fields);
    return;
  }
  if (!isNode(value)) return;
  const binding = value.props.value;
  if (value.type !== "Error" && value.type !== "Loading" && FIELDS[value.type] && isBinding(binding)) {
    const label = typeof value.props.label === "string" ? value.props.label.trim() : "";
    // An unrated Rating holds 0: no answer, not a zero.
    const given = value.type === "Rating" && binding.value === 0 ? null : binding.value;
    // A list state with options to pick from is a multi-select (Checklist, OptionCards).
    const multi = Array.isArray(given) && (value.type === "Checklist" || value.type === "OptionCards");
    const text = multi ? picks(given, optionValues(value.props.options)) : answer(given);
    const name = label || binding.name;
    // A label that is a question or ends in a colon already reads as a prompt.
    const line = `${name}${/[?:]$/.test(name) ? "" : ":"} ${text || "—"}`;
    fields.push({ name: binding.name, typed: TYPED[value.type] === true, line });
    return;
  }
  for (const prop of Object.values(value.props)) collect(prop, fields);
}

/** A Form's fields in document order, each with its answer line. */
export function formFields(form: UiNode): FormField[] {
  const fields: FormField[] = [];
  collect(form.props.children ?? null, fields);
  return fields;
}

/**
 * A Form's answer: `label: value` per field inside it (label, else state
 * name; lists joined; a multi-select's picks and the rest; Yes/No; empty "—").
 */
export function formMessage(form: UiNode): string {
  return formFields(form)
    .map((field) => field.line)
    .join("\n");
}
