/**
 * GitHub webhook signature, URL, and payload helpers.
 *
 * Plugin HTTP `auth: "none"` is only for signature-verified webhooks. The
 * secret lives in plugin KV. A dedicated trycloudflare listener serves
 * `/github-webhook`; a manual public origin that forwards to bb uses
 * `/api/v1/plugins/<id>/http/github-webhook`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { parseRestPull, sidebarPrFromRest, type RestPull } from "./pr-index.ts";
import type { GithubRepo } from "./github-repo.ts";

export const GITHUB_WEBHOOK_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_suite",
  "deployment_status",
] as const;

export const SNOOZE_WAKE_EVENTS = new Set<string>([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "check_suite",
  "deployment_status",
]);

export function githubWebhookPath(): string {
  return "/github-webhook";
}

export function githubWebhookUrl(baseUrl: string, pluginId: string): string {
  const origin = baseUrl.trim().replace(/\/+$/u, "");
  return `${origin}/api/v1/plugins/${pluginId}/http/github-webhook`;
}

/** Public URL for the dedicated webhook-only listener (not the bb API). */
export function dedicatedGithubWebhookUrl(origin: string): string {
  return `${origin.trim().replace(/\/+$/u, "")}${githubWebhookPath()}`;
}

/**
 * Prefer a user-supplied unauthenticated origin that forwards to bb. Session-
 * gated getbb.app URLs are skipped so a live trycloudflare tunnel can win.
 */
export function resolveWebhookDeliveryUrl(args: {
  configuredOrigin: string;
  tunnelOrigin: string | null;
  pluginId: string;
}): string | null {
  const configured = args.configuredOrigin.trim();
  if (configured.length > 0 && !isSessionGatedWebhookOrigin(configured)) {
    return githubWebhookUrl(configured, args.pluginId);
  }
  if (args.tunnelOrigin !== null && args.tunnelOrigin.length > 0) {
    return dedicatedGithubWebhookUrl(args.tunnelOrigin);
  }
  return null;
}

/** Start a trycloudflare tunnel only when the setting is on and no usable manual origin exists. */
export function shouldStartCloudflareTunnel(
  enabled: boolean,
  configuredOrigin: string,
): boolean {
  if (!enabled) return false;
  const configured = configuredOrigin.trim();
  if (configured.length === 0) return true;
  return isSessionGatedWebhookOrigin(configured);
}

export function isTrycloudflareWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.toLowerCase().endsWith(".trycloudflare.com") &&
      parsed.pathname === githubWebhookPath()
    );
  } catch {
    return false;
  }
}

/**
 * bb connect (`*.getbb.app`) requires an owner session before the request
 * reaches the plugin. GitHub's webhook delivery cannot sign in, so those
 * origins must not be registered as hook targets.
 */
export function isSessionGatedWebhookOrigin(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
    return hostname === "getbb.app" || hostname.endsWith(".getbb.app");
  } catch {
    return false;
  }
}

export function verifyGithubSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
): boolean {
  if (header === undefined || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = header.slice("sha256=".length);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(got, "utf8"));
}

export interface WebhookPullRef {
  owner: string;
  repo: string;
  pull: RestPull;
}

export function parseRepoFromPayload(payload: unknown): GithubRepo | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const repository = (payload as Record<string, unknown>).repository;
  if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
    return null;
  }
  const record = repository as Record<string, unknown>;
  const name = record.name;
  const ownerValue = record.owner;
  const ownerLogin =
    typeof ownerValue === "object" && ownerValue !== null && !Array.isArray(ownerValue)
      ? (ownerValue as Record<string, unknown>).login
      : null;
  if (typeof name !== "string" || typeof ownerLogin !== "string") return null;
  if (name.trim().length === 0 || ownerLogin.trim().length === 0) return null;
  return { owner: ownerLogin, repo: name };
}

export function parseWebhookPull(payload: unknown): WebhookPullRef | null {
  const repo = parseRepoFromPayload(payload);
  if (repo === null) return null;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const pull = parseRestPull((payload as Record<string, unknown>).pull_request);
  if (pull === null) return null;
  return { owner: repo.owner, repo: repo.repo, pull };
}

export function webhookPrNumbers(event: string, payload: unknown): number[] {
  const fromPull = parseWebhookPull(payload);
  if (fromPull !== null) return [fromPull.pull.number];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  if (event === "issue_comment") {
    const issue = record.issue;
    if (typeof issue === "object" && issue !== null && !Array.isArray(issue)) {
      const issueRecord = issue as Record<string, unknown>;
      if (issueRecord.pull_request != null && typeof issueRecord.number === "number") {
        return [issueRecord.number];
      }
    }
  }
  if (event === "check_suite") {
    const suite = record.check_suite;
    if (typeof suite === "object" && suite !== null && !Array.isArray(suite)) {
      const pulls = (suite as Record<string, unknown>).pull_requests;
      if (Array.isArray(pulls)) {
        return pulls.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
          const number = (entry as Record<string, unknown>).number;
          return typeof number === "number" && Number.isInteger(number) && number > 0
            ? [number]
            : [];
        });
      }
    }
  }
  if (event === "deployment_status") {
    const deployment = record.deployment;
    if (typeof deployment === "object" && deployment !== null && !Array.isArray(deployment)) {
      const sha = (deployment as Record<string, unknown>).sha;
      if (typeof sha === "string") {
        // Number is not on the deployment; callers GET by repo list or skip.
        return [];
      }
    }
  }
  return [];
}

export function webhookHookBody(url: string, secret: string): unknown {
  return {
    name: "web",
    active: true,
    events: [...GITHUB_WEBHOOK_EVENTS],
    config: {
      url,
      content_type: "json",
      secret,
      insecure_ssl: "0",
    },
  };
}

export function matchingGithubHook(
  hooks: unknown,
  url: string,
): { id: number; events: string[]; url: string } | null {
  if (!Array.isArray(hooks)) return null;
  for (const entry of hooks) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const config = record.config;
    if (typeof id !== "number" || typeof config !== "object" || config === null) continue;
    const hookUrl = (config as Record<string, unknown>).url;
    if (hookUrl !== url) continue;
    const events = Array.isArray(record.events)
      ? record.events.filter((event): event is string => typeof event === "string")
      : [];
    return { id, events, url };
  }
  return null;
}

/**
 * Find the hook we manage: the current URL, or the previous URL this plugin
 * persisted. Do not claim some other integration's trycloudflare hook.
 */
export function matchingManagedGithubHook(
  hooks: unknown,
  url: string,
  previousUrl?: string | null,
): { id: number; events: string[]; url: string } | null {
  const exact = matchingGithubHook(hooks, url);
  if (exact !== null) return exact;
  if (typeof previousUrl === "string" && previousUrl.length > 0 && previousUrl !== url) {
    return matchingGithubHook(hooks, previousUrl);
  }
  return null;
}

export function eventsMatch(have: readonly string[], want: readonly string[]): boolean {
  if (have.length !== want.length) return false;
  const set = new Set(have);
  return want.every((event) => set.has(event));
}

export function indexedRowFromPull(
  environmentId: string,
  owner: string,
  repo: string,
  pull: RestPull,
  now: number,
) {
  const sidebar = sidebarPrFromRest(pull);
  return {
    environmentId,
    owner,
    repo,
    number: sidebar.number,
    title: sidebar.title,
    url: sidebar.url,
    state: sidebar.state,
    attention: sidebar.attention,
    fetchedAt: now,
  };
}
