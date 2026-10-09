import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { findProject, gitHubRepository, requireProject, reviewEnvironment } from "./projects.ts";

test("reads owner/repo from every github.com remote form", () => {
  expect(
    [
      "https://github.com/Cli/CLI.git",
      "https://github.com/cli/cli",
      "https://x-access-token:abc@github.com/cli/cli.git/",
      "git@github.com:cli/cli.git",
      "ssh://git@github.com/cli/cli.git",
      "ssh://git@github.com:22/cli/cli",
      "https://gitlab.com/cli/cli.git",
      "git@github.com:cli",
    ].map(gitHubRepository),
  ).toEqual(["cli/cli", "cli/cli", "cli/cli", "cli/cli", "cli/cli", "cli/cli", null, null]);
});

const source = (hostId: string, isDefault: boolean) => ({
  id: `s-${hostId}`,
  hostId,
  isDefault,
  path: "/work",
  projectId: "p-cli",
  type: "local_path" as const,
  createdAt: 0,
  updatedAt: 0,
});

function host(environments: { id: string; branchName: string | null; status: string }[] = []) {
  const projects = [
    { id: "p-docs", gitRemoteUrl: null, sources: [] },
    {
      id: "p-cli",
      gitRemoteUrl: "git@github.com:Cli/Cli.git",
      sources: [source("h1", false), source("h2", true)],
    },
  ];
  return createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      projects: { list: async () => projects },
      environments: { list: async () => environments },
    },
  });
}

test("finds the project by its remote, case-insensitively, and names the fix when there is none", async () => {
  const { bb } = host();
  expect((await findProject(bb, "cli", "cli"))?.id).toBe("p-cli");
  expect(await findProject(bb, "acme", "api")).toBeNull();
  await expect(requireProject(bb, "acme", "api")).rejects.toThrow(
    "Add acme/api as a bb project to review it with Codex.",
  );
});

test("reuses a ready environment on the branch, and otherwise starts a worktree on the default machine", async () => {
  const { bb, harness } = host([{ id: "env-1", branchName: "feature", status: "ready" }]);
  const project = (await findProject(bb, "cli", "cli"))!;

  expect(await reviewEnvironment(bb, project, { headRefName: "feature", isFork: false })).toEqual({
    environment: { type: "reuse", environmentId: "env-1" },
    reused: true,
  });
  expect(harness.sdk.callsTo("environments.list")).toEqual([
    [{ projectId: "p-cli", status: "ready" }],
  ]);

  const fresh = {
    environment: {
      type: "host" as const,
      hostId: "h2",
      workspace: { type: "managed-worktree" as const, baseBranch: { kind: "default" as const } },
    },
    reused: false,
  };
  expect(await reviewEnvironment(bb, project, { headRefName: "other", isFork: false })).toEqual(
    fresh,
  );
  // A fork's `feature` is a different branch from this repository's `feature`.
  expect(await reviewEnvironment(bb, project, { headRefName: "feature", isFork: true })).toEqual(
    fresh,
  );
});
