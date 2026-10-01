import { expect, test } from "bun:test";
import { actionArgs } from "./actions.ts";

test("push names the branch and forces only when asked", () => {
  expect(actionArgs({ kind: "push", branch: "scott/top", force: false })).toEqual([
    "push",
    "scott/top",
  ]);
  expect(actionArgs({ kind: "push", branch: "scott/top", force: true })).toEqual([
    "push",
    "scott/top",
    "--with-force",
  ]);
});

test("a review's title and body become one message, title first", () => {
  expect(
    actionArgs({
      kind: "createReview",
      branch: "scott/top",
      title: "Add the thing",
      body: "Why it matters.\n",
      draft: true,
    }),
  ).toEqual(["pr", "--draft", "new", "scott/top", "-m", "Add the thing\n\nWhy it matters."]);
  expect(
    actionArgs({
      kind: "createReview",
      branch: "b",
      title: "Only a title",
      body: " ",
      draft: false,
    }),
  ).toEqual(["pr", "new", "b", "-m", "Only a title"]);
});

test("land skips the CLI's confirmation and rename rewords the branch", () => {
  expect(actionArgs({ kind: "land", branch: "scott/top" })).toEqual(["land", "scott/top", "--yes"]);
  expect(actionArgs({ kind: "rename", branch: "scott/top", name: "scott/better" })).toEqual([
    "reword",
    "scott/top",
    "-m",
    "scott/better",
  ]);
});
