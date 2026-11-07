import { expect, it } from "vitest";
import { EXCERPT_MAX_CHARS, messageExcerpt } from "../lib/message-excerpt";

it("keeps a message's readable text on one line", () => {
  expect(messageExcerpt("- Fixed `parse()`\n- See _notes_\n\n```ui\nCard()\n```")).toBe(
    "Fixed parse() See notes",
  );
  expect(messageExcerpt("```ts\nonly code\n```")).toBeNull();
  expect(messageExcerpt(null)).toBeNull();
});

it("clips long messages with an ellipsis", () => {
  const excerpt = messageExcerpt("word ".repeat(100))!;
  expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
  expect(excerpt.endsWith("…")).toBe(true);
});
