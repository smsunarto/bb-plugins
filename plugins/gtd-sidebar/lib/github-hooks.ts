import type { GithubRepo } from "./github-repo.ts";
import {
  eventsMatch,
  GITHUB_WEBHOOK_EVENTS,
  matchingManagedGithubHook,
  webhookHookBody,
} from "./github-webhook.ts";
import { githubRestJson, type GhRunner } from "./gh-cli.ts";

export type EnsureHookResult = "created" | "updated" | "unchanged" | "denied" | "error";

export async function ensureGithubRepoHook(
  gh: GhRunner,
  repo: GithubRepo,
  url: string,
  secret: string,
  previousUrl?: string | null,
): Promise<EnsureHookResult> {
  const listPath = `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/hooks?per_page=100`;
  const listed = await githubRestJson(gh, listPath, 15_000);
  if (listed.exitCode === 403) return "denied";
  if (listed.exitCode !== 0) return "error";
  const existing = matchingManagedGithubHook(listed.raw, url, previousUrl);
  const createBody = webhookHookBody(url, secret);
  if (existing === null) {
    const created = await githubRestJson(
      gh,
      `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/hooks`,
      15_000,
      { method: "POST", body: createBody },
    );
    if (created.exitCode === 403) return "denied";
    if (created.exitCode !== 0) return "error";
    return "created";
  }
  const needsUrl = existing.url !== url;
  const needsEvents = !eventsMatch(existing.events, GITHUB_WEBHOOK_EVENTS);
  if (!needsUrl && !needsEvents) return "unchanged";
  const patched = await githubRestJson(
    gh,
    `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/hooks/${existing.id}`,
    15_000,
    {
      method: "PATCH",
      body: needsUrl
        ? createBody
        : { events: [...GITHUB_WEBHOOK_EVENTS], active: true },
    },
  );
  if (patched.exitCode === 403) return "denied";
  if (patched.exitCode !== 0) return "error";
  return "updated";
}
