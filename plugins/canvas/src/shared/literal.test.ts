import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Program } from "estree";
import { Parser } from "acorn";
import { foldLiteral } from "./literal.ts";

function program(source: string): Program {
  return Parser.parse(source, { ecmaVersion: 2024, sourceType: "module" }) as unknown as Program;
}

function fold(source: string) {
  return foldLiteral(program(source));
}

test("folds every JSON literal shape", () => {
  assert.deepEqual(fold('"a"'), { ok: true, value: "a" });
  assert.deepEqual(fold("1.5"), { ok: true, value: 1.5 });
  assert.deepEqual(fold("true"), { ok: true, value: true });
  assert.deepEqual(fold("null"), { ok: true, value: null });
  assert.deepEqual(fold("[1, 'b', [null]]"), { ok: true, value: [1, "b", [null]] });
  assert.deepEqual(fold("({ a: 1, 'b-c': [2], d: { e: false } })"), {
    ok: true,
    value: { a: 1, "b-c": [2], d: { e: false } },
  });
});

test("folds unary signs and substitution-free template literals", () => {
  assert.deepEqual(fold("-2"), { ok: true, value: -2 });
  assert.deepEqual(fold("+3"), { ok: true, value: 3 });
  assert.deepEqual(fold("[-1, +0.5]"), { ok: true, value: [-1, 0.5] });
  assert.deepEqual(fold("`plain text`"), { ok: true, value: "plain text" });
});

test("rejects identifiers, calls, member access, and functions with the construct named", () => {
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    ["foo", /identifier `foo`/],
    ["undefined", /`undefined`/],
    ["load()", /function call/],
    ["a.b", /property access/],
    ["x => x", /a function/],
    ["(function () {})", /a function/],
    ["1 + 2", /arithmetic/],
    ["a ? 1 : 2", /conditional/],
    ["`a${b}`", /template literal with substitutions/],
    ["[...xs]", /spread/],
    ["({ ...o })", /spread/],
    ["({ [k]: 1 })", /computed key/],
    ["-'x'", /sign applied to a non-number/],
    ["!true", /unary operator !/],
    ["1n", /bigint/],
    ["/re/", /regular expression/],
    ["[1,,2]", /hole/],
  ];
  for (const [source, pattern] of cases) {
    const result = fold(source);
    assert.equal(result.ok, false, source);
    if (!result.ok) assert.match(result.reason, pattern, source);
  }
});

test("reports the offset of the offending node, not the root", () => {
  const result = fold("[1, load(), 3]");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.offset, 4);
});

test("rejects empty and multi-statement programs", () => {
  const empty = foldLiteral({ type: "Program", sourceType: "module", body: [] });
  assert.equal(empty.ok, false);
  const multi = fold("1; 2");
  assert.equal(multi.ok, false);
  if (!multi.ok) assert.match(multi.reason, /second statement/);
});
