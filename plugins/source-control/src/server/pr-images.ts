/**
 * The `/pr-image` route the page points a pull request's GitHub images at.
 * An image GitHub serves to anyone redirects to its own URL. Otherwise the
 * route asks the site that reads the Change's repository, the bb server or a
 * checkout's host, for the short-lived URL GitHub gives a signed-in reader,
 * and redirects there. Image bytes never pass through bb, and the signed URL
 * lives only in memory, for less time than GitHub signs it for.
 *
 * bb serves plugin routes behind its own access checks: from this machine,
 * or through bb Connect after its sign-in, like every other bb request.
 */
import { Effect, Semaphore } from "effect";
import { describeProblem, type Problem } from "../core/change.ts";
import { changeKeySchema, type ChangeKey } from "../core/ids.ts";
import {
  imageIdentity,
  parseGitHubImage,
  servesImage,
  type GitHubImage,
} from "../core/pr-images.ts";
import { parseChangeKey } from "../core/review.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

/** GitHub signs a URL for 300 s: kept here for 120 s, then by the browser for at most 60 s more. */
export const SIGNED_KEPT_MS = 120_000;
export const REDIRECT_MAX_AGE_S = 60;
/** Whether an image is public changes rarely. */
const PUBLIC_KEPT_MS = 10 * 60_000;
/** The anonymous check is one HEAD request, given little time. */
const PROBE_DEADLINE_MS = 3_000;
/** A failed or missing image is not asked about again for this long. */
export const FAILED_KEPT_MS = 30_000;
/**
 * How long one image request waits before answering the failed state. The
 * resolution goes on and is kept for the next load; the browser's few
 * connections to bb are not held for a slow repository.
 */
export const WAIT_MS = 8_000;
/** Signed reads at once for one repository; other repositories have their own. */
const PER_REPO = 4;
const KEPT = 500;

/** What GitHub answers anyone signed out: served, refused, or no answer to go by. */
export type Visibility = "public" | "private" | "unknown";
export type Probe = (url: string, signal: AbortSignal) => Promise<Visibility>;

/** Whether GitHub serves `url` without signing in: one HEAD request whose redirect is not followed. */
export const anonymousProbe: Probe = async (url, signal) => {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_DEADLINE_MS)]),
    });
    if (response.status >= 200 && response.status < 400) return "public";
    return [401, 403, 404].includes(response.status) ? "private" : "unknown";
  } catch {
    return "unknown";
  }
};

export type ImageAnswer =
  | { kind: "redirect"; location: string; maxAgeS: number }
  | { kind: "rejected"; reason: string }
  | { kind: "failed"; problem: Problem };

/**
 * What one resolution found. A failure is kept too, so a missing image does
 * not ask every account on each load. `original`: no account could sign it
 * and GitHub never said it is private, so the browser tries it as written.
 */
type Kept =
  | { at: number; kind: "public" | "signed" | "original"; location: string }
  | { at: number; kind: "failed"; problem: Problem };

const KEPT_MS: Record<Kept["kind"], number> = {
  public: PUBLIC_KEPT_MS,
  signed: SIGNED_KEPT_MS,
  original: FAILED_KEPT_MS,
  failed: FAILED_KEPT_MS,
};

/** No account here sees the image: GitHub answered the site, but not with an image. */
const MISSING: Problem = {
  kind: "auth",
  site: "GitHub",
  detail: "No signed-in GitHub account can see this image.",
};

const SLOW_DETAIL = "GitHub is taking too long for this image.";
const SLOW: Problem = { kind: "failed", site: "GitHub", detail: SLOW_DETAIL };

/** The image `src` from the Change `key`'s pull request, or why it is not served. */
export function createPrImages(deps: {
  sites: ForgeSites;
  share: Share;
  placementsFor: (key: ChangeKey) => ReturnType<Store["checkouts"]>;
  /** The Change's pull request as bb last read it; images are served for those only. */
  pullRequest: (key: ChangeKey) => { baseRef: string } | null;
  now: () => number;
  probe?: Probe;
  waitMs?: number;
}) {
  const probe = deps.probe ?? anonymousProbe;
  const kept = new Map<string, Kept>();
  const permits = new Map<string, Semaphore.Semaphore>();
  const permitsFor = (repo: string) => {
    let semaphore = permits.get(repo);
    if (!semaphore) permits.set(repo, (semaphore = Semaphore.makeUnsafe(PER_REPO)));
    return semaphore;
  };

  const keep = (id: string, entry: Kept) => {
    kept.delete(id);
    kept.set(id, entry);
    if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
  };
  const fresh = (id: string) => {
    const entry = kept.get(id);
    if (!entry) return null;
    return deps.now() - entry.at < KEPT_MS[entry.kind] ? entry : null;
  };

  const resolve = (
    key: ChangeKey,
    image: GitHubImage,
    repo: { owner: string; name: string },
    refs: string[],
  ) =>
    Effect.gen(function* () {
      const visibility = yield* Effect.tryPromise((signal) => probe(image.url, signal)).pipe(
        Effect.orElseSucceed((): Visibility => "unknown"),
      );
      if (visibility === "public")
        return { at: deps.now(), kind: "public", location: image.url } satisfies Kept;
      const parsed = parseChangeKey(key);
      const location = yield* deps.sites
        .imageRead(
          { kind: "image", repo, src: image.url, refs },
          deps.placementsFor(key),
          parsed?.kind === "gh" ? parsed.repo : undefined,
        )
        .pipe(
          // Only the signed read waits its turn, and only behind its own repository's.
          permitsFor(`${repo.owner}/${repo.name}`).withPermit,
          Effect.map((found): Kept | null =>
            found ? { at: deps.now(), kind: "signed", location: found } : null,
          ),
          Effect.catchTag("ForgeUnavailable", (error) =>
            Effect.succeed<Kept>({ at: deps.now(), kind: "failed", problem: error.problem }),
          ),
        );
      if (location?.kind === "signed") return location;
      // Never shown to be private: let the browser try it, as it did before bb routed it.
      if (visibility === "unknown")
        return { at: deps.now(), kind: "original", location: image.url } satisfies Kept;
      return location ?? ({ at: deps.now(), kind: "failed", problem: MISSING } satisfies Kept);
    });

  return {
    image: (rawKey: string | undefined, src: string | undefined) =>
      Effect.gen(function* () {
        const key = changeKeySchema.safeParse(rawKey);
        const parsed = key.success ? parseChangeKey(key.data) : null;
        if (!key.success || parsed?.kind !== "gh")
          return { kind: "rejected", reason: "Not a GitHub Change." } satisfies ImageAnswer;
        const pr = deps.pullRequest(key.data);
        if (!pr)
          return {
            kind: "rejected",
            reason: "bb has not read this pull request.",
          } satisfies ImageAnswer;
        const image = src ? parseGitHubImage(src) : null;
        if (!image)
          return { kind: "rejected", reason: "Not a GitHub image." } satisfies ImageAnswer;
        // A committed file is read only from the pull request's own repository or its head's fork.
        if (!servesImage(image, parsed.repo, parsed.headOwner))
          return {
            kind: "rejected",
            reason: "The image is in another repository.",
          } satisfies ImageAnswer;
        const repo = image.kind === "file" ? image.repo : parsed.repo;
        const id = `${repo.owner}/${repo.name}:${imageIdentity(image)}`.toLowerCase();
        const known = fresh(id);
        if (known) return answerOf(known, deps.now());
        const refs = [parsed.branch, pr.baseRef].filter(Boolean);
        const work = resolve(key.data, image, repo, refs).pipe(
          Effect.tap((entry) => Effect.sync(() => keep(id, entry))),
        );
        // The resolution is shared and outlives this request; this request waits a bounded time.
        const entry = yield* deps.share(`pr-image:${id}`, work).pipe(
          Effect.timeoutOrElse({
            duration: deps.waitMs ?? WAIT_MS,
            orElse: () => Effect.succeed<Kept>({ at: deps.now(), kind: "failed", problem: SLOW }),
          }),
        );
        return answerOf(entry, deps.now());
      }),
  };
}

function answerOf(entry: Kept, now: number): ImageAnswer {
  if (entry.kind === "failed") return { kind: "failed", problem: entry.problem };
  if (entry.kind === "public")
    return { kind: "redirect", location: entry.location, maxAgeS: PUBLIC_KEPT_MS / 1000 };
  if (entry.kind === "original") return { kind: "redirect", location: entry.location, maxAgeS: 0 };
  const left = Math.floor((SIGNED_KEPT_MS - (now - entry.at)) / 1000);
  return {
    kind: "redirect",
    location: entry.location,
    maxAgeS: Math.max(0, Math.min(REDIRECT_MAX_AGE_S, left)),
  };
}

/** The route's answer as an HTTP response. */
export function imageResponse(answer: ImageAnswer): Response {
  switch (answer.kind) {
    case "redirect":
      return new Response(null, {
        status: 302,
        headers: {
          location: answer.location,
          "cache-control":
            answer.maxAgeS > 0 ? `private, max-age=${answer.maxAgeS}` : "private, no-store",
          "referrer-policy": "no-referrer",
        },
      });
    case "rejected":
      return new Response(answer.reason, {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    case "failed":
      // An image, so the page shows why in the image's place instead of a broken icon.
      return new Response(unavailableSvg(imageProblem(answer.problem)), {
        status: 200,
        headers: { "content-type": "image/svg+xml", "cache-control": "no-store" },
      });
  }
}

/** Why the image is missing, in the image's terms: an account that sees the repository may not see a deleted upload. */
export function imageProblem(problem: Problem): string {
  if (problem.kind === "auth" && problem.detail.startsWith("No signed-in GitHub account can see"))
    return "No signed-in GitHub account can see this image.";
  if (problem.kind === "failed" && problem.detail === SLOW_DETAIL) return SLOW_DETAIL;
  return describeProblem(problem);
}

const escapeXml = (text: string) =>
  text.replace(
    /[<>&"']/g,
    (char) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot", "'": "apos" }[char]};`,
  );

/** The failed state: a muted box that reads in light and dark, sized like a small screenshot. */
export function unavailableSvg(detail: string): string {
  const line = detail.length > 90 ? `${detail.slice(0, 89)}…` : detail;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120" viewBox="0 0 640 120" font-family="system-ui, sans-serif"><rect x="0.5" y="0.5" width="639" height="119" rx="8" fill="#80808014" stroke="#80808059" stroke-dasharray="4 4"/><text x="320" y="54" text-anchor="middle" font-size="15" font-weight="600" fill="#909090">Image unavailable</text><text x="320" y="80" text-anchor="middle" font-size="12" fill="#909090">${escapeXml(line)}</text></svg>`;
}
