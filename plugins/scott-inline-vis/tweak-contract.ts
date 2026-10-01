/** The host receives descriptions and values. Bound objects and callbacks stay in the frame. */
export const TWEAK_LIMITS = {
  groups: 24,
  controls: 12,
  options: 12,
  label: 160,
  value: 160,
} as const;

export type TweakValue = string | number | boolean;

interface ControlBase<T extends TweakValue> {
  id: string;
  label: string;
  value: T;
  initialValue: T;
  reference?: string;
}

export type TweakControl =
  | (ControlBase<number> & {
      type: "slider";
      min: number;
      max: number;
      step: number;
      unit?: string;
    })
  | (ControlBase<string> & { type: "color" })
  | (ControlBase<boolean> & { type: "toggle" })
  | (ControlBase<string> & {
      type: "select";
      options: { label: string; value: string }[];
    });

export interface TweakGroup {
  id: string;
  title: string;
  variant: string | null;
  visible: boolean;
  controls: TweakControl[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= TWEAK_LIMITS.label;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

type Description = Pick<ControlBase<TweakValue>, "id" | "label" | "reference">;

function parseSlider(control: Record<string, unknown>, base: Description): TweakControl | null {
  const min = control.min;
  const max = control.max;
  if (!finite(min) || !finite(max) || max <= min || !finite(control.step) || control.step <= 0)
    return null;
  if (
    ![control.value, control.initialValue].every(
      (value) => finite(value) && value >= min && value <= max,
    )
  )
    return null;
  if (
    !(
      control.unit === undefined ||
      (typeof control.unit === "string" && control.unit.length <= TWEAK_LIMITS.label)
    )
  )
    return null;
  return {
    ...base,
    type: "slider",
    value: control.value as number,
    initialValue: control.initialValue as number,
    min,
    max,
    step: control.step,
    ...(control.unit !== undefined ? { unit: control.unit as string } : {}),
  };
}

function parseSelect(control: Record<string, unknown>, base: Description): TweakControl | null {
  if (
    !Array.isArray(control.options) ||
    control.options.length === 0 ||
    control.options.length > TWEAK_LIMITS.options
  )
    return null;
  const options: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const option of control.options) {
    if (!record(option) || !text(option.label) || !text(option.value) || seen.has(option.value))
      return null;
    seen.add(option.value);
    options.push({ label: option.label, value: option.value });
  }
  if (
    ![control.value, control.initialValue].every(
      (value) => typeof value === "string" && seen.has(value),
    )
  )
    return null;
  return {
    ...base,
    type: "select",
    value: control.value as string,
    initialValue: control.initialValue as string,
    options,
  };
}

function parseControl(control: unknown): TweakControl | null {
  if (!record(control) || !text(control.id) || !text(control.label)) return null;
  if (!(control.reference === undefined || text(control.reference))) return null;
  const base = {
    id: control.id,
    label: control.label,
    ...(control.reference !== undefined ? { reference: control.reference } : {}),
  };
  const values = [control.value, control.initialValue];
  switch (control.type) {
    case "slider":
      return parseSlider(control, base);
    case "select":
      return parseSelect(control, base);
    case "color":
      return values.every((value) => typeof value === "string" && /^#[\da-f]{6}$/iu.test(value))
        ? {
            ...base,
            type: "color",
            value: control.value as string,
            initialValue: control.initialValue as string,
          }
        : null;
    case "toggle":
      return values.every((value) => typeof value === "boolean")
        ? {
            ...base,
            type: "toggle",
            value: control.value as boolean,
            initialValue: control.initialValue as boolean,
          }
        : null;
    default:
      return null;
  }
}

function parseGroup(group: unknown): TweakGroup | null {
  if (!record(group) || !text(group.id) || !text(group.title) || typeof group.visible !== "boolean")
    return null;
  if (!(group.variant === null || text(group.variant))) return null;
  if (!Array.isArray(group.controls) || group.controls.length > TWEAK_LIMITS.controls) return null;
  const controls: TweakControl[] = [];
  const seen = new Set<string>();
  for (const input of group.controls) {
    const control = parseControl(input);
    if (!control || seen.has(control.id)) return null;
    seen.add(control.id);
    controls.push(control);
  }
  return {
    id: group.id,
    title: group.title,
    variant: group.variant,
    visible: group.visible,
    controls,
  };
}

/** Reject malformed descriptions instead of allowing frame code to shape host UI arbitrarily. */
export function parseTweakGroups(input: unknown): TweakGroup[] | null {
  if (!Array.isArray(input) || input.length > TWEAK_LIMITS.groups) return null;
  const groups: TweakGroup[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const group = parseGroup(value);
    if (!group || seen.has(group.id)) return null;
    seen.add(group.id);
    groups.push(group);
  }
  return groups;
}
