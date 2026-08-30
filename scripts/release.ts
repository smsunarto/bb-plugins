#!/usr/bin/env bun
/**
 * Publish npm versions only after Release Please has created their GitHub
 * Release and tag.
 *
 * GitHub and npm are durable stores. This script runs after every successful
 * Release Please pass, skips package versions that do not have a release yet,
 * and lets the npm publisher reconcile partial scoped or mirror publishes.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { WorkspacePlugin } from "./plugin-package";
import { publishableWorkspacePlugins } from "./publish";
import { publishableWorkspacePackages, type WorkspacePackage } from "./workspace-package";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface ReleaseTargetBase {
  component: string;
  relativePath: string;
  dir: string;
  name: string;
  manifest: {
    version?: string;
    private?: boolean;
  };
}

export type ReleaseTarget =
  | (ReleaseTargetBase & { readonly kind: "plugin"; readonly publishId: string })
  | (ReleaseTargetBase & { readonly kind: "package"; readonly publishDirectory: string });

export function pluginReleaseTarget(plugin: WorkspacePlugin): ReleaseTarget {
  if (plugin.directory !== plugin.id) {
    throw new Error(
      `${plugin.name} resolves to plugin id "${plugin.id}" but lives at plugins/${plugin.directory}`,
    );
  }
  return {
    kind: "plugin",
    component: plugin.id,
    relativePath: `plugins/${plugin.directory}`,
    dir: plugin.dir,
    name: plugin.name,
    manifest: plugin.manifest,
    publishId: plugin.id,
  };
}

export function packageReleaseTarget(candidate: WorkspacePackage): ReleaseTarget {
  return {
    kind: "package",
    component: candidate.directory,
    relativePath: `packages/${candidate.directory}`,
    dir: candidate.dir,
    name: candidate.name,
    manifest: candidate.manifest,
    publishDirectory: candidate.directory,
  };
}

export function releaseTargets(root: string): ReleaseTarget[] {
  return [
    ...publishableWorkspacePlugins(root).map(pluginReleaseTarget),
    ...publishableWorkspacePackages(root).map(packageReleaseTarget),
  ];
}

export function releaseTag(target: ReleaseTarget): string {
  const version = target.manifest.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`${target.name} has no package version`);
  }
  return `${target.component}/v${version}`;
}

export type ReleaseState = "complete" | "missing";
export type ReleaseStateLookup = (tag: string) => Promise<ReleaseState>;

/** Select packages whose current version Release Please has already released. */
export async function releasedTargets(
  targets: readonly ReleaseTarget[],
  releaseState: ReleaseStateLookup,
): Promise<ReleaseTarget[]> {
  const released: ReleaseTarget[] = [];
  for (const target of targets) {
    if (target.manifest.private === true) {
      throw new Error(`${target.name} is private and cannot receive a release`);
    }
    if ((await releaseState(releaseTag(target))) === "complete") released.push(target);
  }
  return released;
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
 * tag ref or the repository needs manual repair.
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
  if (!releaseResponse.ok) return githubError(releaseResponse, `release lookup for ${tag}`);

  const release = (await releaseResponse.json()) as {
    draft?: unknown;
    tag_name?: unknown;
  };
  if (release.tag_name !== tag) throw new Error(`GitHub returned the wrong release for ${tag}`);
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

function publishPackages(targets: readonly ReleaseTarget[]): void {
  if (targets.length === 0) {
    console.log("no package version has a completed GitHub Release");
    return;
  }

  const pluginIds: string[] = [];
  const packageDirectories: string[] = [];
  for (const target of targets) {
    switch (target.kind) {
      case "plugin":
        pluginIds.push(target.publishId);
        break;
      case "package":
        packageDirectories.push(target.publishDirectory);
        break;
      default: {
        const exhaustive: never = target;
        throw new Error(`unhandled release target: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  const runPublisher = (args: string[]): void => {
    execFileSync("bun", args, {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
    });
  };
  if (packageDirectories.length > 0) {
    runPublisher([
      "scripts/publish-framework.ts",
      ...packageDirectories.flatMap((directory) => ["--package", directory]),
    ]);
  }
  if (pluginIds.length > 0) {
    runPublisher([
      "scripts/publish.ts",
      ...pluginIds.flatMap((pluginId) => ["--plugin", pluginId]),
    ]);
  }
}

async function main(): Promise<void> {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const token = requiredEnvironment("GITHUB_TOKEN");
  const targets = await releasedTargets(releaseTargets(ROOT), (tag) =>
    githubReleaseState(tag, {
      repository,
      token,
      apiUrl: process.env.GITHUB_API_URL,
    }),
  );
  publishPackages(targets);
}

if (import.meta.main) await main();
