import type { Expression, Node, Program, Property, SpreadElement } from "estree";
import type { JsonValue } from "../shared/document.ts";

export type FoldResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly reason: string; readonly offset: number };

type Rejection = { readonly ok: false; readonly reason: string; readonly offset: number };

function offsetOf(node: Node): number {
  const acorn = node as { start?: number; range?: readonly [number, number] };
  return acorn.start ?? acorn.range?.[0] ?? 0;
}

function reject(node: Node, construct: string, hint = "write the value inline"): Rejection {
  return {
    ok: false,
    reason: `${construct} is not a value a canvas can hold; ${hint}`,
    offset: offsetOf(node),
  };
}

function foldNumber(node: Node, value: number): FoldResult {
  if (!Number.isFinite(value)) {
    return reject(node, "a non-finite number", "use a finite number or null");
  }
  return { ok: true, value };
}

function foldProperty(property: Property | SpreadElement): FoldResult & { key?: string } {
  if (property.type === "SpreadElement") {
    return reject(property, "a spread", "list each key explicitly");
  }
  if (property.kind !== "init") {
    return reject(property, "a getter or setter", "use a plain key and value");
  }
  if (property.computed) {
    return reject(property.key, "a computed key", "use a plain identifier or string key");
  }
  let key: string;
  if (property.key.type === "Identifier") {
    key = property.key.name;
  } else if (property.key.type === "Literal" && typeof property.key.value === "string") {
    key = property.key.value;
  } else {
    return reject(property.key, "this object key", "use a plain identifier or string key");
  }
  const value = foldExpression(property.value as Expression);
  return value.ok ? { ok: true, value: value.value, key } : value;
}

function foldExpression(node: Expression): FoldResult {
  switch (node.type) {
    case "Literal": {
      const value = node.value;
      if (value === null) return { ok: true, value: null };
      if (typeof value === "string" || typeof value === "boolean") return { ok: true, value };
      if (typeof value === "number") return foldNumber(node, value);
      if (typeof value === "bigint") return reject(node, "a bigint", "use a plain number");
      return reject(node, "a regular expression", "use a string");
    }
    case "TemplateLiteral": {
      if (node.expressions.length > 0) {
        return reject(node, "a template literal with substitutions", "use a plain string");
      }
      const cooked = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
      return { ok: true, value: cooked };
    }
    case "UnaryExpression": {
      if (node.operator !== "-" && node.operator !== "+") {
        return reject(node, `the unary operator ${node.operator}`, "use a plain literal");
      }
      const argument = foldExpression(node.argument);
      if (!argument.ok) return argument;
      if (typeof argument.value !== "number") {
        return reject(node, "a sign applied to a non-number", "use a plain number");
      }
      return foldNumber(node, node.operator === "-" ? -argument.value : argument.value);
    }
    case "ArrayExpression": {
      const items: JsonValue[] = [];
      for (const element of node.elements) {
        if (element === null) return reject(node, "a hole in an array", "fill every slot");
        if (element.type === "SpreadElement") {
          return reject(element, "a spread", "list each item explicitly");
        }
        const folded = foldExpression(element);
        if (!folded.ok) return folded;
        items.push(folded.value);
      }
      return { ok: true, value: items };
    }
    case "ObjectExpression": {
      const record: Record<string, JsonValue> = {};
      for (const property of node.properties) {
        const folded = foldProperty(property);
        if (!folded.ok) return folded;
        if (folded.key !== undefined) record[folded.key] = folded.value;
      }
      return { ok: true, value: record };
    }
    case "Identifier": {
      if (node.name === "undefined")
        return reject(node, "`undefined`", "use null or omit the prop");
      return reject(node, `the identifier \`${node.name}\``, "write the data inline");
    }
    case "CallExpression":
      return reject(node, "a function call");
    case "MemberExpression":
      return reject(node, "a property access");
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return reject(node, "a function");
    case "BinaryExpression":
    case "LogicalExpression":
      return reject(node, "an arithmetic or logical expression", "write the computed value");
    case "ConditionalExpression":
      return reject(node, "a conditional expression", "write the chosen value");
    case "NewExpression":
      return reject(node, "a constructor call");
    case "TaggedTemplateExpression":
      return reject(node, "a tagged template");
    case "AwaitExpression":
      return reject(node, "an await expression");
    default:
      return reject(node, `a ${node.type}`);
  }
}

export function foldLiteral(program: Program): FoldResult {
  const [statement, extra] = program.body;
  if (statement === undefined) {
    return { ok: false, reason: "an empty expression is not a value; write a literal", offset: 0 };
  }
  if (extra !== undefined) {
    return reject(extra, "a second statement", "keep one literal per prop");
  }
  if (statement.type !== "ExpressionStatement") {
    return reject(statement, `a ${statement.type}`, "use a literal expression");
  }
  return foldExpression(statement.expression);
}
