import { expect, test } from "bun:test";
import { conflictPrompt, reviewPrompt } from "./prompts.ts";

test("quotes the branch and path so the shell runs them as data", () => {
  // Git accepts every one of these characters in a branch name.
  const prompt = reviewPrompt("scott/ok;printf${IFS}it's", "/work/repos/a b");

  expect(prompt).toContain(
    "```sh\ncd '/work/repos/a b'\nbut show 'scott/ok;printf${IFS}it'\\''s'\n```",
  );
  expect(prompt).toContain("```sh\nbut pr new 'scott/ok;printf${IFS}it'\\''s' -F <file>\n```");
});

test("a backtick run in the branch cannot close the fence around it", () => {
  const prompt = reviewPrompt("a```b", "/work");
  expect(prompt).toContain("````sh\ncd '/work'\nbut show 'a```b'\n````");
});

test("the conflict prompt quotes the path so the shell runs it as data", () => {
  const prompt = conflictPrompt("/work/repos/it's here");
  expect(prompt).toContain("```sh\ncd '/work/repos/it'\\''s here'\nbut status\n```");
});
