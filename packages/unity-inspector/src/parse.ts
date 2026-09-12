import { LineCounter, parseDocument } from "yaml";
import type { UnityDiff, UnityCitation } from "./model.ts";
import { changedUnityLines } from "./patch.ts";

type RecordValue = Record<string, unknown>;
type Field = { value: unknown; first: number; last: number; label?: string; target?: string };
type UnityObject = {
  id: string;
  type: string;
  data: RecordValue;
  fields: Map<string, Field>;
  first: number;
  last: number;
};

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reference(value: unknown): string | null {
  return record(value) && value.fileID !== undefined ? String(value.fileID) : null;
}
function printable(value: unknown): string {
  if (typeof value === "bigint") return String(value);
  if (record(value))
    return `{${Object.keys(value)
      .sort((a, b) => {
        const order = "xyzwrgba";
        return order.includes(a) && order.includes(b)
          ? order.indexOf(a) - order.indexOf(b)
          : a.localeCompare(b);
      })
      .map((key) => `${key}: ${printable(value[key])}`)
      .join(", ")}}`;
  if (Array.isArray(value)) return `[${value.map(printable).join(", ")}]`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function atomic(value: unknown): boolean {
  return (
    record(value) &&
    ("fileID" in value ||
      Object.keys(value).every((key) => ["x", "y", "z", "w", "r", "g", "b", "a"].includes(key)))
  );
}
function entriesOf(value: unknown): [string | number, unknown][] {
  if (record(value)) return Object.entries(value);
  if (Array.isArray(value)) return value.map((item, index) => [index, item]);
  return [];
}
function fieldPath(keys: (string | number)[]): string {
  return keys
    .map((key, i) => (typeof key === "number" ? `[${key}]` : `${i ? "." : ""}${key}`))
    .join("");
}
function overrideField(
  item: unknown,
): { path: string; label: string; target: string; value: unknown } | null {
  if (!record(item) || typeof item.propertyPath !== "string" || reference(item.target) === null)
    return null;
  if (
    Object.keys(item).some(
      (key) => !["target", "propertyPath", "value", "objectReference"].includes(key),
    )
  )
    return null;
  const id = reference(item.objectReference);
  const value = id !== null && id !== "0" ? item.objectReference : (item.value ?? "");
  return {
    path: `Overrides/${printable(item.target)}/${item.propertyPath}`,
    label: item.propertyPath,
    target: reference(item.target)!,
    value,
  };
}
function flattenFields(
  values: RecordValue,
  type: string,
  doc: ReturnType<typeof parseDocument>,
  counter: LineCounter,
  first: number,
): Map<string, Field> {
  const fields = new Map<string, Field>();
  const lineRange = (keys: (string | number)[]) => {
    const node = doc.getIn([type, ...keys], true) as { range?: readonly number[] } | undefined;
    const [start = 0, end = start + 1] = node?.range ?? [];
    return {
      first: first + counter.linePos(start).line,
      last: first + counter.linePos(Math.max(start, end - 1)).line,
    };
  };
  const visit = (
    value: unknown,
    keys: (string | number)[],
    depth: number,
    arrayRange?: { first: number; last: number },
  ) => {
    if (depth > 40 || fields.size > 20_000) throw new Error("Unity object is too complex");
    const range = lineRange(keys);
    if (
      type === "PrefabInstance" &&
      keys.length === 3 &&
      keys[0] === "m_Modification" &&
      keys[1] === "m_Modifications"
    ) {
      const override = overrideField(value);
      if (override) {
        if (fields.has(override.path))
          throw new Error("Duplicate prefab override target and property");
        fields.set(override.path, {
          value: override.value,
          label: override.label,
          target: override.target,
          ...range,
        });
        return;
      }
    }
    const entries = entriesOf(value);
    if (entries.length && !atomic(value)) {
      // Inserting a sequence item can change subsequent indices without changing their YAML lines.
      const scope = Array.isArray(value) ? range : arrayRange;
      for (const [key, item] of entries) visit(item, [...keys, key], depth + 1, scope);
      return;
    }
    fields.set(fieldPath(keys), { value, ...(arrayRange ?? range) });
  };
  for (const [key, value] of Object.entries(values)) visit(value, [key], 0);
  return fields;
}

/** Parse each Unity-tagged document independently. IDs stay strings, including 64-bit IDs. */
export function parseUnityObjects(source: string): Map<string, UnityObject> {
  const objects = new Map<string, UnityObject>();
  if (!source.trim()) return objects;
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const headers = [...text.matchAll(/^--- !u!(\d+) &(-?\d+)(?: stripped)?[ \t]*$/gm)];
  if (
    !headers.length ||
    text
      .slice(0, headers[0]!.index)
      .split("\n")
      .some((line) => line.trim() && !line.startsWith("%"))
  ) {
    throw new Error("Not a Unity text asset");
  }
  let first = text.slice(0, headers[0]!.index).split("\n").length;
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index]!;
    const start = header.index! + header[0].length + 1;
    const end = headers[index + 1]?.index ?? text.length;
    const body = text.slice(start, end);
    const counter = new LineCounter();
    const doc = parseDocument(body, { lineCounter: counter, intAsBigInt: true, uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw new Error("Unsupported Unity YAML");
    const data: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!record(data) || Object.keys(data).length !== 1) throw new Error("Invalid Unity document");
    const type = Object.keys(data)[0]!;
    const values = data[type];
    if (!record(values)) throw new Error("Invalid Unity object");
    const fields = flattenFields(values, type, doc, counter, first);
    const id = header[2]!;
    if (objects.has(id)) throw new Error("Duplicate Unity file ID");
    const last = first + body.split("\n").length - 1;
    objects.set(id, { id, type, data: values, fields, first, last });
    first = last + 1;
  }
  return objects;
}

function gameObject(
  object: UnityObject,
  objects: Map<string, UnityObject>,
): UnityObject | undefined {
  return object.type === "GameObject"
    ? object
    : objects.get(reference(object.data.m_GameObject) ?? "");
}
function objectName(object: UnityObject): string {
  if (object.type === "PrefabInstance") {
    const name = [...object.fields.entries()].find(
      ([key]) => key.startsWith("Overrides/") && key.endsWith("/m_Name"),
    )?.[1].value;
    if (typeof name === "string" && name) return name;
  }
  return typeof object.data.m_Name === "string" && object.data.m_Name
    ? object.data.m_Name
    : `${object.type} #${object.id}`;
}
function hierarchy(object: UnityObject, objects: Map<string, UnityObject>): string {
  const transforms = new Map<string, UnityObject>();
  for (const item of objects.values()) {
    if (item.type === "Transform" || item.type === "RectTransform")
      transforms.set(reference(item.data.m_GameObject) ?? "", item);
  }
  const names: string[] = [];
  const visited = new Set<string>([object.id]);
  let current = object;
  for (let depth = 0; depth < 64; depth++) {
    const parentTransform = objects.get(reference(transforms.get(current.id)?.data.m_Father) ?? "");
    const parent = parentTransform && gameObject(parentTransform, objects);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id);
    names.unshift(objectName(parent));
    current = parent;
  }
  return names.join(" / ");
}
function display(value: unknown, objects: Map<string, UnityObject>): string {
  const id = reference(value);
  if (id === null || !record(value)) return printable(value);
  // A GUID reference belongs to another asset. Never resolve its fileID against this scene.
  if (value.guid && !/^0+$/.test(String(value.guid))) return printable(value);
  if (id === "0") return "None";
  const target = objects.get(id);
  if (!target) return printable(value);
  const owner = gameObject(target, objects);
  const name = objectName(owner ?? target);
  const type = owner && owner.id !== target.id ? ` · ${target.type}` : "";
  return `${name}${type} (#${id})`;
}
function touches(field: Field | UnityObject | undefined, lines: Set<number>): boolean {
  if (!field) return false;
  for (const line of lines) if (line >= field.first && line <= field.last) return true;
  return false;
}

type Group = UnityDiff["groups"][number];
type Component = Group["components"][number];
function changeStatus(left: unknown, right: unknown): Component["status"] {
  if (!left) return "added";
  return right ? "modified" : "removed";
}
function propertyDiff(
  left: UnityObject | undefined,
  right: UnityObject | undefined,
  old: Map<string, UnityObject>,
  next: Map<string, UnityObject>,
  changed: ReturnType<typeof changedUnityLines>,
): Component["properties"] {
  const properties: Component["properties"] = [];
  for (const path of new Set([...(left?.fields.keys() ?? []), ...(right?.fields.keys() ?? [])])) {
    const a = left?.fields.get(path);
    const b = right?.fields.get(path);
    if (a && b && printable(a.value) === printable(b.value)) continue;
    if (left && right && !touches(a, changed.old) && !touches(b, changed.new)) continue;
    const label = b?.label ?? a?.label;
    const target = b?.target ?? a?.target;
    properties.push({
      path,
      ...(label ? { label } : {}),
      ...(target ? { target } : {}),
      before: a ? display(a.value, old) : null,
      after: b ? display(b.value, next) : null,
    });
  }
  if (left && right && left.type !== right.type)
    properties.unshift({ path: "Component type", before: left.type, after: right.type });
  return properties;
}
function componentDiff(
  left: UnityObject | undefined,
  right: UnityObject | undefined,
  old: Map<string, UnityObject>,
  next: Map<string, UnityObject>,
  changed: ReturnType<typeof changedUnityLines>,
): Component | null {
  if (!touches(left, changed.old) && !touches(right, changed.new)) return null;
  const object = right ?? left!;
  const status = changeStatus(left, right);
  const properties = propertyDiff(left, right, old, next, changed);
  if (!properties.length && status === "modified") return null;
  const script =
    typeof object.data.m_EditorClassIdentifier === "string"
      ? object.data.m_EditorClassIdentifier.split("::").at(-1)
      : "";
  const type = object.type === "PrefabInstance" ? "Prefab overrides" : object.type;
  return { id: object.id, type: script || type, status, properties };
}

/** The selected patch controls property scope, including deleted properties and array elements. */
export function buildUnityDiff(before: string, after: string, selectedPatch: string): UnityDiff {
  const old = parseUnityObjects(before);
  const next = parseUnityObjects(after);
  const changed = changedUnityLines(selectedPatch);
  const groups = new Map<string, Group>();
  let propertyCount = 0;
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const left = old.get(id);
    const right = next.get(id);
    const component = componentDiff(left, right, old, next, changed);
    if (!component) continue;
    propertyCount += component.properties.length;
    if (propertyCount > 5_000 || groups.size > 500) throw new Error("Unity diff is too large");
    const object = right ?? left!;
    const source = right ? next : old;
    const owner = gameObject(object, source) ?? object;
    let group = groups.get(owner.id);
    if (!group) {
      group = {
        id: owner.id,
        name: objectName(owner),
        hierarchy: hierarchy(owner, source),
        status: changeStatus(old.get(owner.id), next.get(owner.id)),
        components: [],
      };
      groups.set(owner.id, group);
    }
    group.components.push(component);
  }
  return { groups: [...groups.values()], propertyCount };
}

/** Read current values without constructing or exposing a before/after diff. */
export function buildUnityCitation(
  source: string,
  start = 1,
  end = Number.MAX_SAFE_INTEGER,
): UnityCitation {
  const objects = parseUnityObjects(source);
  const groups = new Map<string, UnityCitation["groups"][number]>();
  let propertyCount = 0;
  for (const object of objects.values()) {
    if (object.last < start || object.first > end) continue;
    const properties = [...object.fields.entries()]
      .filter(([, field]) => field.last >= start && field.first <= end)
      .map(([path, field]) => {
        const property: UnityCitation["groups"][number]["components"][number]["properties"][number] =
          { path, value: display(field.value, objects) };
        if (field.label) property.label = field.label;
        if (field.target) property.target = field.target;
        return property;
      });
    if (!properties.length) continue;
    propertyCount += properties.length;
    if (propertyCount > 5_000 || groups.size > 500) throw new Error("Unity citation is too large");
    const owner = gameObject(object, objects) ?? object;
    let group = groups.get(owner.id);
    if (!group) {
      group = {
        id: owner.id,
        name: objectName(owner),
        hierarchy: hierarchy(owner, objects),
        components: [],
      };
      groups.set(owner.id, group);
    }
    const script =
      typeof object.data.m_EditorClassIdentifier === "string"
        ? object.data.m_EditorClassIdentifier.split("::").at(-1)
        : "";
    group.components.push({
      id: object.id,
      type: script || (object.type === "PrefabInstance" ? "Prefab overrides" : object.type),
      properties,
    });
  }
  return { groups: [...groups.values()], propertyCount };
}
