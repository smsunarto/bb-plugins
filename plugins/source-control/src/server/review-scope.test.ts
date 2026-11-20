import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import { ownsPullRequests } from "./moved.ts";

test("an answering reviewer child is not an author; its parent is", () => {
  const titles = [
    "Review (Claude) — auth fix @ abc123 [bb-review.XYZ123]",
    "Review (Codex) — auth fix @ abc123 [bb-review.XYZ123]",
    "Arena (Claude)",
    "Arena (Codex)",
  ];
  for (const title of titles) {
    const child = makePluginAgentConfigurationContext({
      thread: { title, parentThreadId: "author" },
    });
    expect(ownsPullRequests(child), title).toBe(false);
  }
  const author = makePluginAgentConfigurationContext({ thread: { title: "Fix login" } });
  expect(ownsPullRequests(author)).toBe(true);
});
