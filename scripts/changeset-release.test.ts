import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  githubReleaseState,
  hasChangelogVersion,
  missingReleaseEvents,
  releaseTag,
} from "./changeset-release";
import type { WorkspacePlugin } from "./plugin-package";
import { publishableWorkspacePlugins } from "./publish";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function plugin(overrides: Partial<WorkspacePlugin> = {}): WorkspacePlugin {
  return {
    directory: "gh-stack",
    dir: `${ROOT}/plugins/gh-stack`,
    id: "gh-stack",
    name: "@smsunarto/bb-plugin-gh-stack",
    manifest: {
      name: "@smsunarto/bb-plugin-gh-stack",
      version: "1.2.3",
    },
    ...overrides,
  };
}

function queuedFetch(...responses: Response[]): {
  fetcher: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  }) as typeof fetch;
  return { fetcher, urls };
}

const githubOptions = {
  repository: "smsunarto/bb-plugins",
  token: "test-token",
  apiUrl: "https://api.github.test/",
};

describe("Changesets release routing", () => {
  test("routes each package to its matching plugin directory", () => {
    expect(releaseTag(plugin())).toBe("gh-stack/v1.2.3");
    expect(() => releaseTag(plugin({ id: "other" }))).toThrow(
      "resolves to plugin id",
    );
  });

  test("emits only missing releases in the action's NDJSON shape", async () => {
    const amp = plugin({
      directory: "amp",
      id: "amp",
      name: "@smsunarto/bb-plugin-amp",
      manifest: { name: "@smsunarto/bb-plugin-amp", version: "2.0.0" },
    });
    const calls: string[] = [];
    const events = await missingReleaseEvents(
      [plugin(), amp],
      async (tag) => {
        calls.push(tag);
        return tag.startsWith("gh-stack/") ? "missing" : "complete";
      },
    );

    expect(calls).toEqual(["gh-stack/v1.2.3", "amp/v2.0.0"]);
    expect(events).toEqual([{
      type: "git-tag",
      tag: "gh-stack/v1.2.3",
      packageName: "@smsunarto/bb-plugin-gh-stack",
    }]);
  });

  test("never emits a private package", async () => {
    const privatePlugin = plugin({
      manifest: {
        name: "@smsunarto/bb-plugin-gh-stack",
        version: "1.2.3",
        private: true,
      },
    });
    await expect(missingReleaseEvents(
      [privatePlugin],
      async () => "missing",
    )).rejects.toThrow("private");
  });

  test("the shared publish policy excludes only private workspace plugins", () => {
    const plugins = publishableWorkspacePlugins(ROOT);
    expect(plugins.map((candidate) => candidate.directory)).toEqual([
      "agent-proxy",
      "agentation",
      "amp",
      "gh-stack",
      "gtd-sidebar",
      "monokai",
      "notify",
    ]);
    expect(plugins.every((candidate) => candidate.manifest.private !== true)).toBe(true);
  });

  test("recognizes only an exact changelog version heading", () => {
    const changelog = "# Package\n\n## 1.2.3\n\n### Minor Changes\n";
    expect(hasChangelogVersion(changelog, "1.2.3")).toBe(true);
    expect(hasChangelogVersion(changelog, "1.2")).toBe(false);
    expect(hasChangelogVersion("Version 1.2.3", "1.2.3")).toBe(false);
  });
});

describe("GitHub release state", () => {
  test("treats only a missing release as incomplete", async () => {
    const { fetcher, urls } = queuedFetch(new Response(null, { status: 404 }));
    await expect(githubReleaseState("gh-stack/v1.2.3", {
      ...githubOptions,
      fetcher,
    })).resolves.toBe("missing");
    expect(urls).toEqual([
      "https://api.github.test/repos/smsunarto/bb-plugins/releases/tags/gh-stack%2Fv1.2.3",
    ]);
  });

  test("requires both a published release and its tag ref", async () => {
    const { fetcher } = queuedFetch(
      Response.json({ tag_name: "gh-stack/v1.2.3", draft: false }),
      Response.json({ ref: "refs/tags/gh-stack/v1.2.3" }),
    );
    await expect(githubReleaseState("gh-stack/v1.2.3", {
      ...githubOptions,
      fetcher,
    })).resolves.toBe("complete");
  });

  test("fails instead of mistaking API errors for missing releases", async () => {
    const { fetcher } = queuedFetch(
      Response.json({ message: "rate limited" }, { status: 403 }),
    );
    await expect(githubReleaseState("gh-stack/v1.2.3", {
      ...githubOptions,
      fetcher,
    })).rejects.toThrow("failed (403)");
  });

  test("rejects draft releases and completed releases with an invalid tag", async () => {
    const draft = queuedFetch(
      Response.json({ tag_name: "gh-stack/v1.2.3", draft: true }),
    );
    await expect(githubReleaseState("gh-stack/v1.2.3", {
      ...githubOptions,
      fetcher: draft.fetcher,
    })).rejects.toThrow("is a draft");

    const missingTag = queuedFetch(
      Response.json({ tag_name: "gh-stack/v1.2.3", draft: false }),
      Response.json({ message: "Not Found" }, { status: 404 }),
    );
    await expect(githubReleaseState("gh-stack/v1.2.3", {
      ...githubOptions,
      fetcher: missingTag.fetcher,
    })).rejects.toThrow("tag lookup");
  });
});
