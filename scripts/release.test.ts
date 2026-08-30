import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  githubReleaseState,
  pluginReleaseTarget,
  releasedTargets,
  releaseTag,
  releaseTargets,
} from "./release";
import type { WorkspacePlugin } from "./plugin-package";

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

describe("Release Please routing", () => {
  test("routes each package to its matching plugin tag", () => {
    expect(releaseTag(pluginReleaseTarget(plugin()))).toBe("gh-stack/v1.2.3");
    expect(() => pluginReleaseTarget(plugin({ id: "other" }))).toThrow("resolves to plugin id");
  });

  test("publishes only packages with a completed GitHub Release", async () => {
    const ghStack = pluginReleaseTarget(plugin());
    const amp = pluginReleaseTarget(
      plugin({
        directory: "amp",
        id: "amp",
        name: "@smsunarto/bb-plugin-amp",
        manifest: { name: "@smsunarto/bb-plugin-amp", version: "2.0.0" },
      }),
    );
    const calls: string[] = [];
    const released = await releasedTargets([ghStack, amp], async (tag) => {
      calls.push(tag);
      return tag.startsWith("gh-stack/") ? "missing" : "complete";
    });

    expect(calls).toEqual(["gh-stack/v1.2.3", "amp/v2.0.0"]);
    expect(released).toEqual([amp]);
  });

  test("never publishes a private package", async () => {
    const privatePlugin = plugin({
      manifest: {
        name: "@smsunarto/bb-plugin-gh-stack",
        version: "1.2.3",
        private: true,
      },
    });
    await expect(
      releasedTargets([pluginReleaseTarget(privatePlugin)], async () => "missing"),
    ).rejects.toThrow("private");
  });

  test("the release inventory includes plugins and framework packages", () => {
    expect(releaseTargets(ROOT).map(({ kind, relativePath }) => ({ kind, relativePath }))).toEqual([
      { kind: "plugin", relativePath: "plugins/agent-proxy" },
      { kind: "plugin", relativePath: "plugins/agentation" },
      { kind: "plugin", relativePath: "plugins/amp" },
      { kind: "plugin", relativePath: "plugins/gh-stack" },
      { kind: "plugin", relativePath: "plugins/gtd-sidebar" },
      { kind: "plugin", relativePath: "plugins/monokai" },
      { kind: "plugin", relativePath: "plugins/nanocodex" },
      { kind: "plugin", relativePath: "plugins/notify" },
      { kind: "package", relativePath: "packages/bb-kit-core" },
    ]);
  });
});

describe("GitHub release state", () => {
  test("treats only a missing release as incomplete", async () => {
    const { fetcher, urls } = queuedFetch(new Response(null, { status: 404 }));
    await expect(
      githubReleaseState("gh-stack/v1.2.3", {
        ...githubOptions,
        fetcher,
      }),
    ).resolves.toBe("missing");
    expect(urls).toEqual([
      "https://api.github.test/repos/smsunarto/bb-plugins/releases/tags/gh-stack%2Fv1.2.3",
    ]);
  });

  test("requires both a published release and its tag ref", async () => {
    const { fetcher } = queuedFetch(
      Response.json({ tag_name: "gh-stack/v1.2.3", draft: false }),
      Response.json({ ref: "refs/tags/gh-stack/v1.2.3" }),
    );
    await expect(
      githubReleaseState("gh-stack/v1.2.3", {
        ...githubOptions,
        fetcher,
      }),
    ).resolves.toBe("complete");
  });

  test("fails instead of mistaking API errors for missing releases", async () => {
    const { fetcher } = queuedFetch(Response.json({ message: "rate limited" }, { status: 403 }));
    await expect(
      githubReleaseState("gh-stack/v1.2.3", {
        ...githubOptions,
        fetcher,
      }),
    ).rejects.toThrow("failed (403)");
  });

  test("rejects draft releases and completed releases with an invalid tag", async () => {
    const draft = queuedFetch(Response.json({ tag_name: "gh-stack/v1.2.3", draft: true }));
    await expect(
      githubReleaseState("gh-stack/v1.2.3", {
        ...githubOptions,
        fetcher: draft.fetcher,
      }),
    ).rejects.toThrow("is a draft");

    const missingTag = queuedFetch(
      Response.json({ tag_name: "gh-stack/v1.2.3", draft: false }),
      Response.json({ message: "Not Found" }, { status: 404 }),
    );
    await expect(
      githubReleaseState("gh-stack/v1.2.3", {
        ...githubOptions,
        fetcher: missingTag.fetcher,
      }),
    ).rejects.toThrow("tag lookup");
  });
});
