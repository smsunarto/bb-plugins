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
import { parseGitHubImage, servesImage, type GitHubImage } from "../core/pr-images.ts";
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
/** Images resolved at once; the rest wait their turn. */
const RESOLVE_CONCURRENCY = 4;
const KEPT = 500;

export type Probe = (url: string, signal: AbortSignal) => Promise<boolean>;

/** Whether GitHub serves `url` without signing in: one HEAD request whose redirect is not followed. */
export const anonymousProbe: Probe = async (url, signal) => {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_DEADLINE_MS)]),
    });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
};

export type ImageAnswer =
  | { kind: "redirect"; location: string; maxAgeS: number }
  | { kind: "rejected"; reason: string }
  | { kind: "failed"; problem: Problem };

/** What one resolution found. A failure is kept too, so a missing image does not ask every account on each load. */
type Kept =
  | { at: number; kind: "public" | "signed"; location: string }
  | { at: number; kind: "failed"; problem: Problem };

const KEPT_MS: Record<Kept["kind"], number> = {
  public: PUBLIC_KEPT_MS,
  signed: SIGNED_KEPT_MS,
  failed: FAILED_KEPT_MS,
};

/** No account here sees the image: GitHub answered the site, but not with an image. */
const MISSING: Problem = {
  kind: "auth",
  site: "GitHub",
  detail: "No signed-in GitHub account can see this image.",
};

/** The image `src` from the Change `key`'s pull request, or why it is not served. */
export function createPrImages(deps: {
  sites: ForgeSites;
  share: Share;
  placementsFor: (key: ChangeKey) => ReturnType<Store["checkouts"]>;
  now: () => number;
  probe?: Probe;
}) {
  const probe = deps.probe ?? anonymousProbe;
  const kept = new Map<string, Kept>();
  const permits = Semaphore.makeUnsafe(RESOLVE_CONCURRENCY);

  const keep = (url: string, entry: Kept) => {
    kept.delete(url);
    kept.set(url, entry);
    if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
  };
  const fresh = (url: string) => {
    const entry = kept.get(url);
    if (!entry) return null;
    const age = deps.now() - entry.at;
    return age < KEPT_MS[entry.kind] ? entry : null;
  };

  const resolve = (key: ChangeKey, image: GitHubImage, repo: { owner: string; name: string }) =>
    Effect.gen(function* () {
      const open = yield* Effect.tryPromise((signal) => probe(image.url, signal)).pipe(
        Effect.orElseSucceed(() => false),
      );
      if (open) return { at: deps.now(), kind: "public", location: image.url } satisfies Kept;
      const answer = yield* deps.sites.repoRead(
        { kind: "image", repo, src: image.url },
        deps.placementsFor(key),
      );
      return answer.kind === "image" && answer.location !== null
        ? ({ at: deps.now(), kind: "signed", location: answer.location } satisfies Kept)
        : ({ at: deps.now(), kind: "failed", problem: MISSING } satisfies Kept);
    }).pipe(
      Effect.catchTag("ForgeUnavailable", (error) =>
        Effect.succeed({ at: deps.now(), kind: "failed", problem: error.problem } satisfies Kept),
      ),
      Effect.tap((entry) => Effect.sync(() => keep(image.url, entry))),
      permits.withPermit,
    );

  return {
    image: (rawKey: string | undefined, src: string | undefined) =>
      Effect.gen(function* () {
        const key = changeKeySchema.safeParse(rawKey);
        const parsed = key.success ? parseChangeKey(key.data) : null;
        if (!key.success || parsed?.kind !== "gh")
          return { kind: "rejected", reason: "Not a GitHub Change." } satisfies ImageAnswer;
        const image = src ? parseGitHubImage(src) : null;
        if (!image)
          return { kind: "rejected", reason: "Not a GitHub image." } satisfies ImageAnswer;
        // A committed file is read only from the pull request's own repository or its head's fork.
        if (image.kind === "file" && !servesImage(image, parsed.repo, parsed.headOwner))
          return {
            kind: "rejected",
            reason: "The image is in another repository.",
          } satisfies ImageAnswer;
        const repo = image.kind === "file" ? image.repo : parsed.repo;
        const entry =
          fresh(image.url) ??
          (yield* deps.share(
            `pr-image:${repo.owner}/${repo.name}:${image.url}`,
            resolve(key.data, image, repo),
          ));
        return answerOf(entry, deps.now());
      }),
  };
}

function answerOf(entry: Kept, now: number): ImageAnswer {
  if (entry.kind === "failed") return { kind: "failed", problem: entry.problem };
  if (entry.kind === "public")
    return { kind: "redirect", location: entry.location, maxAgeS: PUBLIC_KEPT_MS / 1000 };
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
