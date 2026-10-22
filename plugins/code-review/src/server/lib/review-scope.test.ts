import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("Code Review supplies the review skill to authors and withholds it from answering children", async () => {
  const f = createFakePluginHost({ pluginId: "code-review", agentSkillIds: ["review"] });
  await plugin(f.bb);
  try {
    const author = await f.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );
    assert.deepEqual(author.skills, ["review"]);
    const skill = readFileSync(new URL("../../../skills/review/SKILL.md", import.meta.url), "utf8");
    const titles = [...skill.matchAll(/--title "([^"\n]+)"/g)].map((match) =>
      match[1]!
        .replaceAll("$review_label", "auth fix @ abc123")
        .replaceAll("$review_run", "bb-review.XYZ123"),
    );
    assert.equal(titles.length, 2);
    for (const title of [...titles, "Arena (Claude)", "Arena (Codex)"]) {
      const child = await f.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ thread: { title, parentThreadId: "author" } }),
      );
      assert.deepEqual(child.skills, [], title);
    }
    for (const pluginId of ["side-chat", "review"]) {
      const result = await f.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ origin: { kind: null, pluginId } }),
      );
      assert.deepEqual(result.skills, [], pluginId);
    }
    const panelReview = await f.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        pluginMetadata: { kind: "review", pr: "cli/cli#9000" },
      }),
    );
    assert.deepEqual(panelReview.skills, []);
    assert.ok(panelReview.tools.some((tool) => tool.name === "code_review_report_findings"));
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
