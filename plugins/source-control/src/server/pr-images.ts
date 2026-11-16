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

/** A signed URL is handed out until this long before GitHub stops honouring it. */
const SIGNED_MARGIN_MS = 30_000;
/** A signed URL whose life GitHub does not state (a raw file's token) is used for this long. */
const UNSTATED_LIFE_MS = 180_000;
/** Below this much life left, a signed URL is signed again rather than handed out. */
const SIGNED_MIN_LEFT_MS = 15_000;
/** Whether an image is public changes rarely. */
const PUBLIC_KEPT_MS = 10 * 60_000;
/** The anonymous check is one HEAD request, given little time. */
const PROBE_DEADLINE_MS = 3_000;
/** No signed-in account sees the image: asked again after this long. */
export const UNSEEN_KEPT_MS = 60_000;
/** An account that reads the repository found no such file: a dead link, asked again after this long. */
export const GONE_KEPT_MS = 5 * 60_000;
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

/**
 * When a signed URL received at `receivedAt` must stop being handed out: the
 * life GitHub states in it (S3's `X-Amz-Date` + `X-Amz-Expires`, or a JWT's
 * `nbf`/`exp`), counted from both its own clock and ours and taking the
 * earlier, less a margin. A URL that states none is used for 180 s.
 */
export function signedUntil(location: string, receivedAt: number): number {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return receivedAt;
  }
  const expires = Number(url.searchParams.get("X-Amz-Expires"));
  if (Number.isFinite(expires) && expires > 0) {
    const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
      url.searchParams.get("X-Amz-Date") ?? "",
    );
    const signed = stamp
      ? Date.UTC(+stamp[1]!, +stamp[2]! - 1, +stamp[3]!, +stamp[4]!, +stamp[5]!, +stamp[6]!)
      : receivedAt;
    return Math.min(receivedAt, signed) + expires * 1000 - SIGNED_MARGIN_MS;
  }
  const jwt = jwtLife(url.searchParams.get("jwt"));
  if (jwt) return Math.min(receivedAt + jwt.life, jwt.exp) - SIGNED_MARGIN_MS;
  return receivedAt + UNSTATED_LIFE_MS;
}

function jwtLife(token: string | null): { life: number; exp: number } | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as {
      exp?: number;
      nbf?: number;
    };
    if (typeof claims.exp !== "number" || typeof claims.nbf !== "number") return null;
    return { life: (claims.exp - claims.nbf) * 1000, exp: claims.exp * 1000 };
  } catch {
    return null;
  }
}

export type ImageAnswer =
  | { kind: "redirect"; location: string; maxAgeS: number }
  | { kind: "rejected"; reason: string; status?: 400 | 403 }
  | { kind: "failed"; problem: Problem };

/**
 * A definitive answer, kept so loads do not ask GitHub again: public, signed
 * (until shortly before its signature ends), or missing. Transient failures,
 * a slow read, an offline host, are never kept, so the next load asks again.
 */
type Kept =
  | { at: number; kind: "public"; location: string }
  | { at: number; kind: "signed"; location: string; until: number }
  | { at: number; kind: "missing"; problem: Problem; keepMs: number };

/** What one resolution found: kept, or a transient answer for this request only. */
type Resolved = { keep: true; entry: Kept } | { keep: false; answer: ImageAnswer };

/** No account here sees the image: GitHub answered the site, but not with an image. */
const UNSEEN: Problem = {
  kind: "auth",
  site: "GitHub",
  detail: "No signed-in GitHub account can see this image.",
};
const GONE_DETAIL = "The pull request's repository has no such image.";
const GONE: Problem = { kind: "failed", site: "GitHub", detail: GONE_DETAIL };

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
  const fresh = (id: string): Kept | null => {
    const entry = kept.get(id);
    const now = deps.now();
    if (!entry) return null;
    if (entry.kind === "signed") return entry.until - now >= SIGNED_MIN_LEFT_MS ? entry : null;
    const life = entry.kind === "public" ? PUBLIC_KEPT_MS : entry.keepMs;
    return now - entry.at < life ? entry : null;
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
      const at = deps.now();
      if (visibility === "public")
        return { keep: true, entry: { at, kind: "public", location: image.url } } as Resolved;
      const parsed = parseChangeKey(key);
      const read = yield* deps.sites
        .imageRead(
          { kind: "image", repo, src: image.url, refs },
          deps.placementsFor(key),
          parsed?.kind === "gh" ? parsed.repo : undefined,
        )
        .pipe(
          // Only the signed read waits its turn, and only behind its own repository's.
          permitsFor(`${repo.owner}/${repo.name}`).withPermit,
          Effect.result,
        );
      const now = deps.now();
      if (read._tag === "Success" && read.success.location) {
        const { location } = read.success;
        const entry: Kept = {
          at: now,
          kind: "signed",
          location,
          until: signedUntil(location, now),
        };
        return { keep: true, entry } as Resolved;
      }
      // Never shown to be private: let the browser try it, as it did before bb routed it.
      if (visibility === "unknown")
        return {
          keep: false,
          answer: { kind: "redirect", location: image.url, maxAgeS: 0 },
        } as Resolved;
      if (read._tag === "Failure")
        return {
          keep: false,
          answer: { kind: "failed", problem: read.failure.problem },
        } as Resolved;
      const entry: Kept = read.success.gone
        ? { at: now, kind: "missing", problem: GONE, keepMs: GONE_KEPT_MS }
        : { at: now, kind: "missing", problem: UNSEEN, keepMs: UNSEEN_KEPT_MS };
      return { keep: true, entry } as Resolved;
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
          Effect.tap((resolved) =>
            Effect.sync(() => {
              if (resolved.keep) keep(id, resolved.entry);
            }),
          ),
        );
        // The resolution is shared and outlives this request; this request waits a bounded time.
        const resolved = yield* deps.share(`pr-image:${id}`, work).pipe(
          Effect.timeoutOrElse({
            duration: deps.waitMs ?? WAIT_MS,
            orElse: () =>
              Effect.succeed<Resolved>({
                keep: false,
                answer: { kind: "failed", problem: SLOW },
              }),
          }),
        );
        return resolved.keep ? answerOf(resolved.entry, deps.now()) : resolved.answer;
      }),
  };
}

function answerOf(entry: Kept, now: number): ImageAnswer {
  switch (entry.kind) {
    case "missing":
      return { kind: "failed", problem: entry.problem };
    case "public":
      return { kind: "redirect", location: entry.location, maxAgeS: PUBLIC_KEPT_MS / 1000 };
    case "signed":
      // The browser may replay this redirect until `until`, never past it.
      return {
        kind: "redirect",
        location: entry.location,
        maxAgeS: Math.max(0, Math.floor((entry.until - now) / 1000)),
      };
  }
}

/**
 * Whether a request comes from another site's page: a foreign page that
 * embeds the route would otherwise show a private repository's images and
 * learn their sizes. bb's own page is same-origin; curl and the CLI send none.
 */
export function fromAnotherSite(headers: Headers): boolean {
  return headers.get("sec-fetch-site")?.toLowerCase() === "cross-site";
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
          // A kept redirect must not answer another site's page, which is refused.
          vary: "Sec-Fetch-Site",
          "referrer-policy": "no-referrer",
        },
      });
    case "rejected":
      return new Response(answer.reason, {
        status: answer.status ?? 400,
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
  if (problem.kind === "failed" && [SLOW_DETAIL, GONE_DETAIL].includes(problem.detail))
    return problem.detail;
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
