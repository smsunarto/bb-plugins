/**
 * The short-lived URL GitHub gives a signed-in reader for an image in a
 * private repository's pull request, read as one `gh` account on whichever
 * site runs it. The token stays on that site: it goes only to github.com, in
 * a header, and the redirect it earns is read, not followed. No image bytes
 * are fetched.
 */
import { refSplits, type GitHubImage } from "../core/pr-images.ts";
import { classifyFailure, GhError, type Exec } from "./github.ts";

/** How long GitHub may take to answer before the image counts as unavailable. */
const DEADLINE_MS = 8_000;

/** Where GitHub sends a signed-in reader for an upload: S3 or its own image host. */
const ATTACHMENT_HOSTS =
  /^(?:github-production-user-asset-[a-z0-9]+\.s3\.amazonaws\.com|private-user-images\.githubusercontent\.com|objects\.githubusercontent\.com)$/;

/** `location` when it is an https URL on a host `allowed` accepts, else null. */
export function allowedLocation(location: string | null, allowed: RegExp): string | null {
  if (!location) return null;
  try {
    const url = new URL(location);
    return url.protocol === "https:" && allowed.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The signed URL for `image`, as the account `exec` runs as. `refs` are
 * branches a committed file's ref is likely to be: the pull request's head and
 * base. Throws a `GhError`.
 */
export async function resolveImage(
  exec: Exec,
  image: GitHubImage,
  signal?: AbortSignal,
  fetchImpl: Fetch = fetch,
  refs: readonly string[] = [],
): Promise<string> {
  return image.kind === "attachment"
    ? resolveAttachment(exec, image.url, signal, fetchImpl)
    : resolveFile(exec, image, refs, signal);
}

async function resolveAttachment(
  exec: Exec,
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: Fetch,
): Promise<string> {
  const answer = await exec(
    ["auth", "token", "--hostname", "github.com"],
    signal ? { signal } : {},
  );
  const token = answer.stdout.trim();
  if (answer.code !== 0 || token === "") throw classifyFailure(answer);
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { authorization: `token ${token}` },
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  } catch {
    // The request's own error can name the URL; the caller needs only the kind.
    throw new GhError("failed", "GitHub did not answer for the image.");
  }
  if (response.status === 404) throw new GhError("not-found", "GitHub has no such image here.");
  if (response.status === 401 || response.status === 403)
    throw new GhError("forbidden", "This account cannot see the image.");
  if (response.status === 429) throw new GhError("rate-limited", "GitHub rate-limited the image.");
  const location = allowedLocation(response.headers.get("location"), ATTACHMENT_HOSTS);
  if (response.status < 300 || response.status >= 400 || !location)
    throw new GhError("failed", `GitHub answered ${response.status} for the image.`);
  return location;
}

/** Where the contents API sends a reader: the raw host, or the LFS media host for a file in Git LFS. */
const FILE_HOSTS = /^(?:raw|media)\.githubusercontent\.com$/;

/** A committed file's download URL, trying each way its ref may end until GitHub knows one. */
async function resolveFile(
  exec: Exec,
  image: Extract<GitHubImage, { kind: "file" }>,
  refs: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  // Checked again where the token is: each part names one step inside the repository.
  if (image.segments.some((part) => !part || part === "." || part === ".." || /[/\\]/.test(part)))
    throw new GhError("failed", "Not a file in the repository.");
  for (const { ref, path } of refSplits(image.segments, refs)) {
    const endpoint = `repos/${image.repo.owner}/${image.repo.name}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${encodeURIComponent(ref)}`;
    const result = await exec(["api", endpoint, "--jq", ".download_url"], signal ? { signal } : {});
    if (result.code !== 0 || result.failure) {
      const error = classifyFailure(result);
      if (error.code !== "not-found") throw error;
      // No such ref: this account reads the repository, and another split may name the file.
      if (NO_REF.test(result.stderr)) continue;
      // The ref exists and has no such file, or this account cannot see the repository: ask which.
      if (await seesRepo(exec, image.repo, signal)) throw new ImageGone();
      throw error;
    }
    const location = allowedLocation(result.stdout.trim(), FILE_HOSTS);
    if (!location) throw new GhError("failed", "GitHub gave no download for the image.");
    return location;
  }
  // This account reads the repository and none of the refs exists: no other account will find it.
  throw new ImageGone();
}

/** What GitHub answers this account for a ref the repository does not have. */
const NO_REF = /No commit found for the ref/i;

/** Whether this account can read `repo` at all. */
async function seesRepo(
  exec: Exec,
  repo: { owner: string; name: string },
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const result = await exec(
    ["api", `repos/${repo.owner}/${repo.name}`, "--jq", ".id"],
    signal ? { signal } : {},
  );
  if (result.code === 0 && !result.failure) return true;
  const error = classifyFailure(result);
  if (error.code === "not-found" || error.code === "forbidden") return false;
  throw error;
}

/** A committed image an account that reads its repository does not find: a dead link, not a hidden one. */
export class ImageGone extends GhError {
  constructor() {
    super("not-found", "The repository has no such image.");
  }
}
