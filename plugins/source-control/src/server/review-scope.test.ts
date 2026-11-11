import { readFileSync } from "node:fs";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import { ownsPullRequests } from "./moved.ts";

test("a reviewer child the request-review skill starts is not an author; its parent is", () => {
  const skill = readFileSync(new URL("../../skills/request-review/SKILL.md", import.meta.url), "utf8");
  expect(skill).toMatch(/^name: request-review$/m);
  const templates = [...skill.matchAll(/--title "([^"\n]+)"/g)].map((match) => match[1]!);
  expect(templates).toHaveLength(1);
  const titles = ["Claude", "Codex"].map((reviewer) =>
    templates[0]!
      .replaceAll("$reviewer_name", reviewer)
      .replaceAll("$review_label", "auth fix @ abc123")
      .replaceAll("$review_run", "bb-review.XYZ123"),
  );
  for (const title of [...titles, "Arena (Claude)", "Arena (Codex)"]) {
    const child = makePluginAgentConfigurationContext({ thread: { title, parentThreadId: "author" } });
    expect(ownsPullRequests(child), title).toBe(false);
  }
  const author = makePluginAgentConfigurationContext({ thread: { title: "Fix login" } });
  expect(ownsPullRequests(author)).toBe(true);
});
