import { expect, test } from "vitest";
import { groupDirective, parseDirective, parseGroup } from "./directive.ts";
import { changeKeySchema } from "./ids.ts";

const a = changeKeySchema.parse("gh:acme/api:scott:scott/one");
const b = changeKeySchema.parse("local:host-a:/repo/.git:scott/two");

const attributes = (directive: string) => {
  const match = /changes="([^"]*)"/.exec(directive);
  return { changes: match?.[1] };
};

test("a grouped card names each Change and the head it was shared at", () => {
  const directive = groupDirective([
    { key: a, revision: "abc1234" },
    { key: b, revision: "not a sha" },
  ]);
  expect(directive.startsWith("::source-control{changes=")).toBe(true);
  expect(parseGroup(attributes(directive))).toEqual([
    { key: a, revision: "abc1234" },
    { key: b, revision: null },
  ]);
  // A one-Change directive is not a group, and a group is not a one-Change directive.
  expect(parseGroup({ key: encodeURIComponent(a) })).toBeNull();
  expect(parseDirective(attributes(directive))).toBeNull();
});

test("a group's untrusted attributes must name 2 to 25 distinct valid Changes", () => {
  const encode = (list: unknown) => encodeURIComponent(JSON.stringify(list));
  expect(parseGroup({ changes: encode([[a, null]]) })).toBeNull();
  expect(
    parseGroup({
      changes: encode([
        [a, null],
        [a, "abc1234"],
      ]),
    }),
  ).toBeNull();
  expect(
    parseGroup({
      changes: encode([
        [a, null],
        [42, null],
      ]),
    }),
  ).toBeNull();
  expect(parseGroup({ changes: encode(Array.from({ length: 26 }, () => [a, null])) })).toBeNull();
  expect(parseGroup({ changes: "%7Bnot json" })).toBeNull();
});
