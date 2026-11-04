import { expect, it } from "vitest";
import { buildPrompt } from "./dispatch";
import { toPullRequest } from "./gh";
import { ruleSchema } from "./types";

it.each(["live", "shadow"])("restricts review evidence in %s orchestrator prompts", (mode) => {
  const rule = ruleSchema.parse({
    id: "evidence-rule",
    name: "evidence",
    repo: "owner/repo",
    enabled: true,
    mode,
    triggers: ["ready_for_review"],
    commentKeywords: [],
    conditions: [],
    authorTrust: "write_access",
    requesterTrust: "write_access",
    commentTriggerEnabledAt: null,
    prompt: "Review the pinned source.",
    request: null,
    dedupe: "once_per_pr",
    reviewStrategy: "update",
    visibility: "visible",
    createdAt: 0,
    updatedAt: 0,
  });
  const prompt = buildPrompt({
    rule,
    target: toPullRequest({ number: 1, head: { sha: "abc123" }, base: { ref: "main" } }),
    runId: "evidence-run",
  });
  expect(prompt).toContain(
    "Do not read existing PR reviews, review comments, or review discussions written by other humans or agents.",
  );
  expect(prompt).toContain(
    "Do not inspect GitHub CI checks, commit statuses, workflow runs, logs, or artifacts.",
  );
  expect(prompt).toContain("Pass these restrictions to every reviewer, lens, and tool subagent");
});
