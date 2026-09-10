import { expect, test } from "bun:test";
import { quoteOffset } from "./text-selection.ts";
import { commentsFileSchema } from "../shared/comments.ts";
test("quote selectors follow text moves and distinguish repeated passages", () => {
  expect(
    quoteOffset("Before first quote. After second quote.", { quote: "quote", prefix: "second " }),
  ).toBe(33);
  expect(quoteOffset("quote and quote", { quote: "quote" })).toBeNull();
  expect(quoteOffset("Changed context quote", { quote: "quote", prefix: "old " })).toBe(16);
  expect(quoteOffset("Deleted passage", { quote: "quote" })).toBeNull();
});
test("agents can write quote-only anchors without opaque block IDs", () => {
  expect(
    commentsFileSchema.safeParse({
      version: 1,
      threads: [
        {
          id: "cmt_abcdefghij",
          anchor: { quote: "Selected passage" },
          resolvedAtMs: null,
          messages: [
            { id: "agent-reply", author: "agent", createdAtMs: 1, body: "Evidence attached." },
          ],
        },
      ],
    }).success,
  ).toBe(true);
});
