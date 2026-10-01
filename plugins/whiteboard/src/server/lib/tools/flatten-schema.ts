import type { JsonObject, JsonValue } from "../../../shared/vendor/json/src/index.ts";

/**
 * Cut `$ref` cycles from an upstream tool input schema so bb accepts it
 * (design §3.5). bb rejects any recursive local `$ref` at registration
 * (`assertNoRecursiveJsonSchemaReferences`), because some model providers
 * reject a whole tool list over one recursive schema. Upstream zod emits
 * self-recursive `$defs` for `session_edit` (blocks, database fields, JSON
 * values) and `session_upload` (map data-store schemas).
 *
 * - A JSON-value def (`z.json()`) recurses through arrays and records of
 *   itself; replacing those self-references with `{}` (any value) keeps its
 *   meaning exactly.
 * - Any other self-recursive def is unrolled `UNROLL_LEVELS` levels as an
 *   acyclic chain `D → D_depth1 → D_depth2`, so content nested two levels
 *   deep (a section in a section) keeps its full shape. Below the last level
 *   the reference becomes a stub (`type: "object"` when the def only admits
 *   objects) that says so. Union branches
 *   that never recurse are hoisted into shared defs first, so each level adds
 *   only the recursive branches instead of a full copy.
 * - Every other part of the schema is unchanged, and the root stays
 *   `type: "object"`. The tool route still validates input with upstream's
 *   zod schema, so nesting below the cut is checked when the tool runs.
 */

export const UNROLL_LEVELS = 2;

/** Advertised in place of the reference below the last unrolled level. */
export const CUT_DESCRIPTION =
  "Same shape as the matching item one level up. The schema stops expanding here; the tool still validates the full shape.";

const DEFS_PREFIX = "#/$defs/";

type Node = JsonValue;

function isObject(value: Node | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refTarget(node: Node | undefined): string | undefined {
  if (!isObject(node) || typeof node.$ref !== "string" || !node.$ref.startsWith(DEFS_PREFIX))
    return undefined;
  return node.$ref.slice(DEFS_PREFIX.length);
}

/** Every def name a node references, directly. */
function referencedDefs(node: Node, into = new Set<string>()): Set<string> {
  const target = refTarget(node);
  if (target !== undefined) into.add(target);
  if (Array.isArray(node)) for (const item of node) referencedDefs(item, into);
  else if (isObject(node)) for (const value of Object.values(node)) referencedDefs(value, into);
  return into;
}

/** A deep copy with every `$ref` to `name` replaced by `replacement` (copied per site). */
function replaceRefs(node: Node, name: string, replacement: Node): Node {
  if (refTarget(node) === name) return structuredClone(replacement);
  if (Array.isArray(node)) return node.map((item) => replaceRefs(item, name, replacement));
  if (isObject(node)) {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node))
      out[key] = replaceRefs(value, name, replacement);
    return out;
  }
  return node;
}

const JSON_SCALARS = new Set(["string", "number", "boolean", "null"]);

/** `z.json()`: anyOf string | number | boolean | null | array of self | record of self. */
function isJsonValueDef(def: Node, name: string): boolean {
  if (!isObject(def) || !Array.isArray(def.anyOf) || Object.keys(def).length !== 1) return false;
  const kinds = new Set<string>();
  for (const branch of def.anyOf) {
    if (!isObject(branch) || typeof branch.type !== "string") return false;
    if (JSON_SCALARS.has(branch.type)) kinds.add(branch.type);
    else if (branch.type === "array" && refTarget(branch.items) === name) kinds.add("array");
    else if (branch.type === "object" && refTarget(branch.additionalProperties) === name)
      kinds.add("object");
    else return false;
  }
  return kinds.size === 6;
}

/** True when every value the def admits is an object, so the cut can say `type: "object"`. */
function isObjectOnly(node: Node, defs: JsonObject, seen = new Set<string>()): boolean {
  const target = refTarget(node);
  if (target !== undefined) {
    if (seen.has(target)) return true;
    const def = defs[target];
    return def !== undefined && isObjectOnly(def, defs, new Set([...seen, target]));
  }
  if (!isObject(node)) return false;
  if (node.type === "object") return true;
  const union = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : [];
  return union.length > 0 && union.every((branch) => isObjectOnly(branch, defs, seen));
}

/** The stub advertised in place of a cut reference. */
function cutFor(def: Node, defs: JsonObject, seen?: Set<string>): JsonObject {
  return isObjectOnly(def, defs, seen)
    ? { type: "object", description: CUT_DESCRIPTION }
    : { description: CUT_DESCRIPTION };
}

function freshName(defs: JsonObject, base: string): string {
  let name = base;
  for (let n = 2; name in defs; n++) name = `${base}_${n}`;
  return name;
}

/**
 * Hoist union branches of `node` that never reference `name` into shared
 * defs, recursing into nested unions. Returns the rewritten node.
 */
function hoistInvariantBranches(
  node: Node,
  name: string,
  defs: JsonObject,
  counter: { n: number },
): Node {
  if (!isObject(node)) return node;
  const out: JsonObject = { ...node };
  for (const key of ["anyOf", "oneOf"] as const) {
    const union = node[key];
    if (!Array.isArray(union)) continue;
    out[key] = union.map((branch) => {
      if (referencedDefs(branch).has(name))
        return hoistInvariantBranches(branch, name, defs, counter);
      const shared = freshName(defs, `${name}_branch${++counter.n}`);
      defs[shared] = branch;
      return { $ref: `${DEFS_PREFIX}${shared}` };
    });
  }
  return out;
}

function unroll(defs: JsonObject, name: string): void {
  const body = hoistInvariantBranches(defs[name]!, name, defs, { n: 0 });
  const cut = cutFor(body, defs, new Set([name]));
  const levels = [name];
  for (let depth = 1; depth <= UNROLL_LEVELS; depth++)
    levels.push(freshName(defs, `${name}_depth${depth}`));
  levels.forEach((level, index) => {
    const next = levels[index + 1];
    defs[level] = replaceRefs(
      body,
      name,
      next === undefined ? cut : { $ref: `${DEFS_PREFIX}${next}` },
    );
  });
}

/** Replace any reference that still closes a cycle (through several defs) with a cut. */
function cutRemainingCycles(root: JsonObject, defs: JsonObject): void {
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): void => {
    state.set(name, "visiting");
    for (const target of referencedDefs(defs[name]!)) {
      if (!(target in defs)) continue;
      if (state.get(target) === "visiting") {
        defs[name] = replaceRefs(defs[name]!, target, cutFor(defs[target]!, defs));
      } else if (!state.has(target)) visit(target);
    }
    state.set(name, "done");
  };
  for (const name of referencedDefs({ ...root, $defs: null })) if (!state.has(name)) visit(name);
  for (const name of Object.keys(defs)) if (!state.has(name)) visit(name);
}

export function flattenSchema(schema: JsonObject): JsonObject {
  const root = structuredClone(schema);
  const defs = root.$defs;
  if (isObject(defs)) {
    for (const name of Object.keys(defs)) {
      const def = defs[name]!;
      if (!referencedDefs(def).has(name)) continue;
      if (isJsonValueDef(def, name)) defs[name] = replaceRefs(def, name, {});
      else unroll(defs, name);
    }
    cutRemainingCycles(root, defs);
  }
  root.type = "object";
  return root;
}
