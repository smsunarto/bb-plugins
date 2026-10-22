import { expect, test } from "vitest";
import {
  blockSchema,
  checkReferences,
} from "../../shared/vendor/review/src/review-api/document.ts";
import { files } from "./instructions.ts";

test("every published component example passes the real document schema and reference checks", () => {
  const examples = [...files.read("components").matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    (match) => blockSchema.parse(JSON.parse(match[1]!)),
  );
  expect(examples.map((example) => example.type)).toEqual([
    "section",
    "code_peek",
    "sequence",
    "flow_diagram",
    "call_stack_diff",
    "database_lens",
  ]);
  checkReferences(examples);
});
