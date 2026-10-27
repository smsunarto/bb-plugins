import { expect, test } from "bun:test";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fakeContext } from "../../../test/fake-gh.ts";
import { watchPr } from "./watch-pr.ts";

const tool = { threadId: "thr_a", projectId: "p-api", signal: new AbortController().signal };

test("authors get the tool; answering reviewers leave watching to their parent", () => {
  const { ctx } = fakeContext();
  const enabled = (overrides: Parameters<typeof makePluginAgentConfigurationContext>[0]) =>
    watchPr.enabled!(ctx, makePluginAgentConfigurationContext(overrides));
  expect(enabled({})).toBe(true);
  expect(enabled({ pluginMetadata: { kind: "fix", pr: "acme/api#7" } })).toBe(true);
  expect(enabled({ pluginMetadata: { kind: "review", pr: "acme/api#7" } })).toBe(false);
  expect(enabled({ thread: { title: "Review (Codex) — x @ abc", parentThreadId: "thr_a" } })).toBe(
    false,
  );
});

test("parses the reference and stops a watch the thread does not hold", async () => {
  const { ctx } = fakeContext();
  await expect(
    watchPr.execute({ ...ctx, tool }, { reference: "javascript:alert(1)" }),
  ).rejects.toThrow("GitHub pull request URL");
  expect(
    await watchPr.execute(
      { ...ctx, tool },
      { reference: "https://github.com/acme/api/pull/7/checks", stop: true },
    ),
  ).toBe("This thread was not watching acme/api#7.");
});
