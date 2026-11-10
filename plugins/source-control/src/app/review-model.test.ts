import { expect, test } from "vitest";
import type { ReviewItem } from "../core/items.ts";
import { itemTitle } from "./review-model.ts";

const item = (body: string) => ({ title: null, body }) as ReviewItem;

test("a comment's title is the first line GitHub would show, without bot markers or HTML", () => {
  expect(
    itemTitle(
      item("<!-- cubic:v=49d760f0 -->\n\n<details>\n<summary>P2: Lockfile drift</summary>\n\nMore"),
    ),
  ).toBe("P2: Lockfile drift");
  expect(itemTitle(item("## Missing null check\nbody"))).toBe("Missing null check");
  expect(itemTitle(item("<!-- only a marker -->"))).toBe("Comment");
  expect(itemTitle(item("Plain first line\nsecond"))).toBe("Plain first line");
});
