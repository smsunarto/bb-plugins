#!/usr/bin/env bun
/**
 * Publish every unpublished scoped package and unscoped mirror, then tell the
 * Changesets action which plugin-specific GitHub Releases are still missing.
 *
 * npm and GitHub are both treated as durable stores. A retry skips package
 * versions that reached npm and release tags that already have a non-draft
 * GitHub Release, so a failure at any point can converge on the next run.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspacePlugin } from "./plugin-package";
import { publishableWorkspacePlugins } from "./publish";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface ChangesetOutputEvent {
  type: "git-tag";
  tag: string;
  packageName: string;
}

export function releaseTag(plugin: WorkspacePlugin): string {
  const version = plugin.manifest.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`${plugin.name} has no package version`);
  }
  if (plugin.directory !== plugin.id) {
    throw new Error(
      `${plugin.name} resolves to plugin id "${plugin.id}" but lives at plugins/${plugin.directory}`,
    );
  }
  return `${plugin.directory}/v${version}`;
}

/** True when the changelog has the exact version heading the action reads. */
export function hasChangelogVersion(changelog: string, version: string): boolean {
  for (const match of changelog.matchAll(/^#{1,6}\s+(.*)$/gm)) {
    const heading = match[1];
    if (heading !== undefined && heading.trim() === version) return true;
  }
  return false;
}

export type ReleaseState = "complete" | "missing";
export type ReleaseStateLookup = (tag: string) => Promise<ReleaseState>;

/** Build the action events for releases that GitHub does not have yet. */
export async function missingReleaseEvents(
  plugins: readonly WorkspacePlugin[],
  releaseState: ReleaseStateLookup,
): Promise<ChangesetOutputEvent[]> {
  const events: ChangesetOutputEvent[] = [];
  for (const plugin of plugins) {
    if (plugin.manifest.private === true) {
      throw new Error(`${plugin.name} is private and cannot receive a release`);
    }
    const tag = releaseTag(plugin);
    if ((await releaseState(tag)) === "missing") {
      events.push({ type: "git-tag", tag, packageName: plugin.name });
    }
  }
  return events;
}

interface GitHubReleaseOptions {
  repository: string;
  token: string;
  apiUrl?: string;
  fetcher?: typeof fetch;
}

async function githubError(response: Response, operation: string): Promise<never> {
  const detail = (await response.text()).trim();
  throw new Error(`GitHub ${operation} failed (${response.status})${detail ? `: ${detail}` : ""}`);
}

/**
 * Check the durable GitHub state for one release.
 *
 * A 404 release is the only "missing" result. Authentication, rate-limit, and
 * server failures stop publication. A completed release must also retain its
 * tag ref; otherwise the repository is inconsistent and needs manual repair.
 */
export async function githubReleaseState(
  tag: string,
  options: GitHubReleaseOptions,
): Promise<ReleaseState> {
  const repositoryParts = options.repository.split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => part === "")) {
    throw new Error(`invalid GitHub repository: ${options.repository}`);
  }
  const repository = repositoryParts.map(encodeURIComponent).join("/");
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetcher = options.fetcher ?? fetch;
  const request = (path: string): Promise<Response> =>
    fetcher(`${apiUrl}/repos/${repository}/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

  const encodedTag = encodeURIComponent(tag);
  const releaseResponse = await request(`releases/tags/${encodedTag}`);
  if (releaseResponse.status === 404) return "missing";
  if (!releaseResponse.ok) {
    return githubError(releaseResponse, `release lookup for ${tag}`);
  }
  const release = (await releaseResponse.json()) as {
    draft?: unknown;
    tag_name?: unknown;
  };
  if (release.tag_name !== tag) {
    throw new Error(`GitHub returned the wrong release for ${tag}`);
  }
  if (release.draft !== false) {
    throw new Error(`GitHub Release ${tag} is a draft; publish or delete it before retrying`);
  }

  const refResponse = await request(`git/ref/tags/${encodedTag}`);
  if (!refResponse.ok) {
    return githubError(refResponse, `tag lookup for completed release ${tag}`);
  }
  const ref = (await refResponse.json()) as { ref?: unknown };
  if (ref.ref !== `refs/tags/${tag}`) {
    throw new Error(`GitHub returned the wrong tag ref for ${tag}`);
  }
  return "complete";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the release workflow`);
  return value;
}

function assertChangelogs(plugins: readonly WorkspacePlugin[]): void {
  for (const plugin of plugins) {
    const version = plugin.manifest.version;
    if (typeof version !== "string" || version.trim() === "") {
      throw new Error(`${plugin.name} has no package version`);
    }
    const changelogPath = join(plugin.dir, "CHANGELOG.md");
    let changelog: string;
    try {
      changelog = readFileSync(changelogPath, "utf8");
    } catch {
      throw new Error(`${plugin.name} has no CHANGELOG.md for GitHub Releases`);
    }
    if (!hasChangelogVersion(changelog, version)) {
      throw new Error(`${plugin.name} CHANGELOG.md has no heading for ${version}`);
    }
  }
}

function publishPackages(): void {
  execFileSync("bun", ["scripts/publish.ts"], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
}

async function main(): Promise<void> {
  const actionOutput = process.env.CHANGESETS_OUTPUT;
  if (!actionOutput) {
    publishPackages();
    return;
  }

  const plugins = publishableWorkspacePlugins(ROOT);
  assertChangelogs(plugins);
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const token = requiredEnvironment("GITHUB_TOKEN");
  const events = await missingReleaseEvents(plugins, (tag) =>
    githubReleaseState(tag, {
      repository,
      token,
      apiUrl: process.env.GITHUB_API_URL,
    }),
  );

  publishPackages();

  // changesets/action reads this NDJSON after the command exits. Create the
  // file even when no event remains, so a successful no-op retry is quiet.
  writeFileSync(
    actionOutput,
    events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : ""),
    { flag: "a" },
  );
}

if (import.meta.main) {
  await main();
}
