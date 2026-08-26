import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { ensureGithubRepoHook } from "../lib/github-hooks.ts";
import type { GhRunner } from "../lib/gh-cli.ts";

function runner(
  hooks: unknown,
  onPatch?: (body: unknown) => void,
): GhRunner {
  return {
    async run(args) {
      const path = args.at(-1) ?? "";
      const methodIndex = args.indexOf("--method");
      const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
      if (path.includes("/hooks/") && method === "PATCH") {
        const inputIndex = args.indexOf("--input");
        const inputPath = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
        if (inputPath !== undefined && onPatch !== undefined) {
          onPatch(JSON.parse(await readFile(inputPath, "utf8")));
        }
        return { stdout: "{}", stderr: "", exitCode: 0 };
      }
      if (path.includes("/hooks") && method === "GET") {
        return { stdout: JSON.stringify(hooks), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    },
  };
}

describe("ensureGithubRepoHook", () => {
  const url = "https://ours.trycloudflare.com/github-webhook";
  const repo = { owner: "acme", repo: "app" };

  it("PATCHes the secret even when URL and events already match", async () => {
    let patched: unknown = null;
    const result = await ensureGithubRepoHook(
      runner(
        [
          {
            id: 9,
            events: [
              "pull_request",
              "pull_request_review",
              "pull_request_review_comment",
              "issue_comment",
              "check_suite",
              "deployment_status",
            ],
            config: { url },
          },
        ],
        (body) => {
          patched = body;
        },
      ),
      repo,
      url,
      "new-secret",
    );
    assert.equal(result, "unchanged");
    assert.equal(
      (patched as { config?: { secret?: string } } | null)?.config?.secret,
      "new-secret",
    );
  });
});
