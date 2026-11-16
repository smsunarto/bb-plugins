import { Deferred, Effect, ManagedRuntime } from "effect";
import { expect, test } from "vitest";
import type { ChangeKey } from "../core/ids.ts";
import { reviewAnswerSchema, reviewReadSchema } from "../contract/host.ts";
import type { ReviewRead } from "../forge/review.ts";
import { ForgeUnavailable, type ForgeSites } from "./forge-sites.ts";
import { SharedWork } from "./shared.ts";
import {
  createPrImages,
  fromAnotherSite,
  GONE_KEPT_MS,
  imageProblem,
  imageResponse,
  signedUntil,
  UNSEEN_KEPT_MS,
  type ImageAnswer,
  type Visibility,
} from "./pr-images.ts";

const KEY = "gh:argus-labs/rampage-client:argus-labs:scott/scene-router" as ChangeKey;
const UPLOAD = "https://github.com/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c";
const SIGNED = "https://github-production-user-asset-6210df.s3.amazonaws.com/1/2.png?sig=1";

type ImageRead = Extract<ReviewRead, { kind: "image" }>;
type Found = { location: string | null; gone: boolean };
const signed = (location = SIGNED): Found => ({ location, gone: false });
const UNSEEN: Found = { location: null, gone: false };
const GONE: Found = { location: null, gone: true };

function world(
  options: {
    visibility?: Visibility;
    answer?: (read: ImageRead) => Effect.Effect<Found, ForgeUnavailable>;
    read?: (key: ChangeKey) => boolean;
  } = {},
) {
  const reads: ImageRead[] = [];
  const probes: string[] = [];
  let now = 1_000_000;
  const sites = {
    imageRead: (read: ImageRead) => {
      reads.push(read);
      return options.answer?.(read) ?? Effect.succeed(signed());
    },
  } as unknown as ForgeSites;
  const images = createPrImages({
    sites,
    share: (_key, work) => work,
    placementsFor: () => [],
    pullRequest: (key) => ((options.read ?? (() => true))(key) ? { baseRef: "main" } : null),
    now: () => now,
    probe: async (url) => {
      probes.push(url);
      return options.visibility ?? "private";
    },
  });
  const image = (key: string | undefined, src: string | undefined) =>
    Effect.runPromise(images.image(key, src)) as Promise<ImageAnswer>;
  return { reads, probes, image, tick: (ms: number) => (now += ms) };
}

test("anything but a GitHub image of a GitHub Change is a 400, before any network call", async () => {
  const { reads, probes, image } = world();
  for (const [key, src] of [
    [KEY, "https://evil.example/a.png"],
    [KEY, "http://github.com/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c"],
    [KEY, undefined],
    // A committed file from another repository is not this pull request's.
    [KEY, "https://github.com/someone/else/blob/main/a.png?raw=true"],
    ["local:host:/repo/.git:main", UPLOAD],
    [undefined, UPLOAD],
  ] as const) {
    const answer = await image(key, src);
    expect(answer.kind, `${key} ${src}`).toBe("rejected");
    expect(imageResponse(answer).status).toBe(400);
  }
  expect(probes).toEqual([]);
  expect(reads).toEqual([]);
});

test("a Change bb has not read gets no image, before any network call", async () => {
  const { reads, probes, image } = world({ read: (key) => key !== KEY });
  expect(await image(KEY, UPLOAD)).toMatchObject({ kind: "rejected" });
  expect(probes).toEqual([]);
  expect(reads).toEqual([]);
});

test("an encoded path that climbs out of the repository, or a file that is not an image, is refused", async () => {
  const { reads, probes, image } = world();
  for (const src of [
    "https://github.com/argus-labs/rampage-client/raw/trunk/x%2F..%2F..%2F..%2F..%2Fcli%2Fcli%2Fcontents%2FREADME.md",
    "https://github.com/argus-labs/rampage-client/raw/trunk/x%2F..%2F..%2Fa.png",
    "https://github.com/argus-labs/rampage-client/raw/main/README.md",
    "https://github.com/argus-labs/rampage-client/raw/main/.env",
  ])
    expect((await image(KEY, src)).kind, src).toBe("rejected");
  expect(probes).toEqual([]);
  expect(reads).toEqual([]);
});

test("a public image redirects to its own URL without asking a site", async () => {
  const { reads, image } = world({ visibility: "public" });
  expect(await image(KEY, UPLOAD)).toMatchObject({ kind: "redirect", location: UPLOAD });
  expect(reads).toEqual([]);
});

test("a private image redirects to the signed URL, read with the pull request's branches as ref hints", async () => {
  const { reads, image } = world();
  const response = imageResponse(await image(KEY, UPLOAD));
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(SIGNED);
  // GitHub states no life in this URL: handed out for 180 s at most, browser cache included.
  expect(response.headers.get("cache-control")).toBe("private, max-age=180");
  expect(response.headers.get("vary")).toBe("Sec-Fetch-Site");
  expect(reads).toEqual([
    {
      kind: "image",
      repo: { owner: "argus-labs", name: "rampage-client" },
      src: UPLOAD,
      refs: ["scott/scene-router", "main"],
    },
  ]);
});

test("a committed file of the head's fork is read from the fork", async () => {
  const fork = "gh:o/r:fork:topic" as ChangeKey;
  const { reads, image } = world();
  await image(fork, "https://github.com/Fork/R/blob/abc/a.png?raw=true");
  expect(reads[0]).toMatchObject({ repo: { owner: "fork", name: "r" } });
});

test("a signed URL is handed out until shortly before GitHub stops honouring it, never after", async () => {
  // Signed by GitHub at 1_000 s on our clock, for 300 s.
  const s3 = `https://github-production-user-asset-6210df.s3.amazonaws.com/1/2.png?X-Amz-Date=19700101T001640Z&X-Amz-Expires=300&X-Amz-Signature=x`;
  const { reads, image, tick } = world({ answer: () => Effect.succeed(signed(s3)) });
  expect(await image(KEY, UPLOAD)).toMatchObject({ kind: "redirect", maxAgeS: 270 });
  tick(200_000);
  // Kept: the browser may replay it 70 s more, which ends 30 s before GitHub's 300 s.
  expect(await image(KEY, UPLOAD)).toMatchObject({ kind: "redirect", location: s3, maxAgeS: 70 });
  expect(reads).toHaveLength(1);
  tick(60_000);
  // Too little life left to hand out: signed again.
  await image(KEY, UPLOAD);
  expect(reads).toHaveLength(2);
});

test("a signed URL's life is read from GitHub's own stamp and ours, whichever ends first", () => {
  const at = Date.UTC(2026, 10, 15, 12, 0, 0);
  const s3 = (date: string) =>
    `https://x.s3.amazonaws.com/a.png?X-Amz-Date=${date}&X-Amz-Expires=300&X-Amz-Signature=s`;
  expect(signedUntil(s3("20261115T120000Z"), at)).toBe(at + 270_000);
  // GitHub's clock behind ours: its stamp ends first.
  expect(signedUntil(s3("20261115T115900Z"), at)).toBe(at + 210_000);
  // GitHub's clock ahead: ours does.
  expect(signedUntil(s3("20261115T121000Z"), at)).toBe(at + 270_000);
  const jwt = (claims: object) =>
    `https://private-user-images.githubusercontent.com/1/a.png?jwt=h.${btoa(JSON.stringify(claims)).replaceAll("=", "")}.s`;
  const nbf = at / 1000;
  expect(signedUntil(jwt({ nbf, exp: nbf + 300 }), at)).toBe(at + 270_000);
  expect(signedUntil(jwt({ nbf: nbf - 100, exp: nbf + 200 }), at)).toBe(at + 170_000);
  // No stated life, or one that cannot be read: 180 s, as before.
  expect(signedUntil("https://raw.githubusercontent.com/o/r/a.png?token=T", at)).toBe(at + 180_000);
  expect(signedUntil(jwt({ exp: "soon" }), at)).toBe(at + 180_000);
  expect(signedUntil(`${s3("20261115T120000Z")}&X-Amz-Expires=x`, at)).toBe(at + 270_000);
});

test("one image is cached once, whatever query or fragment its URL carries", async () => {
  const { reads, image } = world();
  for (const src of [UPLOAD, `${UPLOAD}?v=1`, `${UPLOAD}?v=2`, `${UPLOAD}#a`])
    await image(KEY, src);
  expect(reads).toHaveLength(1);
});

test("an unreachable site answers the failed state as an image, not a redirect", async () => {
  const { image } = world({
    answer: () =>
      Effect.fail(new ForgeUnavailable({ problem: { kind: "host-offline", host: "laptop" } })),
  });
  const answer = await image(KEY, UPLOAD);
  expect(answer).toEqual({ kind: "failed", problem: { kind: "host-offline", host: "laptop" } });
  const response = imageResponse(answer);
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const svg = await response.text();
  expect(svg).toContain("Image unavailable");
  expect(svg).toContain("laptop is not answering.");
});

test("an image never shown to be private goes to its own URL when no account can sign it", async () => {
  const { image } = world({ visibility: "unknown", answer: () => Effect.succeed(UNSEEN) });
  expect(await image(KEY, UPLOAD)).toMatchObject({
    kind: "redirect",
    location: UPLOAD,
    maxAgeS: 0,
  });
});

test("an image no account sees is the failed state, kept briefly so loads do not re-ask every account", async () => {
  const { reads, image, tick } = world({ answer: () => Effect.succeed(UNSEEN) });
  const first = await image(KEY, UPLOAD);
  expect(first).toMatchObject({ kind: "failed" });
  expect(imageProblem((first as Extract<ImageAnswer, { kind: "failed" }>).problem)).toBe(
    "No signed-in GitHub account can see this image.",
  );
  await image(KEY, UPLOAD);
  expect(reads).toHaveLength(1);
  tick(UNSEEN_KEPT_MS);
  await image(KEY, UPLOAD);
  expect(reads).toHaveLength(2);
});

test("a dead link in a repository an account reads is kept longer", async () => {
  const { reads, image, tick } = world({ answer: () => Effect.succeed(GONE) });
  const first = await image(KEY, "https://github.com/argus-labs/rampage-client/raw/main/gone.png");
  expect(imageProblem((first as Extract<ImageAnswer, { kind: "failed" }>).problem)).toBe(
    "The pull request's repository has no such image.",
  );
  tick(GONE_KEPT_MS - 1);
  await image(KEY, "https://github.com/argus-labs/rampage-client/raw/main/gone.png");
  expect(reads).toHaveLength(1);
  tick(1);
  await image(KEY, "https://github.com/argus-labs/rampage-client/raw/main/gone.png");
  expect(reads).toHaveLength(2);
});

test("a transient failure is not kept: the next load asks again", async () => {
  let offline = true;
  const { reads, image } = world({
    answer: () =>
      offline
        ? Effect.fail(new ForgeUnavailable({ problem: { kind: "host-offline", host: "laptop" } }))
        : Effect.succeed(signed()),
  });
  expect(imageResponse(await image(KEY, UPLOAD)).headers.get("cache-control")).toBe("no-store");
  offline = false;
  expect(await image(KEY, UPLOAD)).toMatchObject({ kind: "redirect", location: SIGNED });
  expect(reads).toHaveLength(2);
});

test("only a request from another site's page is refused", () => {
  const site = (value?: string) =>
    fromAnotherSite(new Headers(value ? { "sec-fetch-site": value } : {}));
  expect(site("cross-site")).toBe(true);
  expect(site("Cross-Site")).toBe(true);
  for (const value of [undefined, "same-origin", "same-site", "none"])
    expect(site(value)).toBe(false);
  expect(imageResponse({ kind: "rejected", reason: "x", status: 403 }).status).toBe(403);
});

test("an image no signed-in account can see says so, not that gh is signed out", () => {
  expect(
    imageProblem({
      kind: "auth",
      site: "dev-pc",
      detail: "No signed-in GitHub account can see o/r.",
    }),
  ).toBe("No signed-in GitHub account can see this image.");
});

/** A server with real shared work, whose signed reads wait on a gate per repository. */
async function gated(waitMs?: number) {
  const runtime = ManagedRuntime.make(SharedWork.layer);
  const share = await runtime.runPromise(Effect.service(SharedWork));
  const gates = new Map<string, Deferred.Deferred<void>>();
  const gate = (repo: string) => {
    let deferred = gates.get(repo);
    if (!deferred) gates.set(repo, (deferred = Effect.runSync(Deferred.make<void>())));
    return deferred;
  };
  const running = new Map<string, number>();
  const most = new Map<string, number>();
  const reads: string[] = [];
  const sites = {
    imageRead: (read: ImageRead) =>
      Effect.gen(function* () {
        const repo = `${read.repo.owner}/${read.repo.name}`;
        reads.push(read.src);
        running.set(repo, (running.get(repo) ?? 0) + 1);
        most.set(repo, Math.max(most.get(repo) ?? 0, running.get(repo)!));
        yield* Deferred.await(gate(repo));
        running.set(repo, running.get(repo)! - 1);
        return signed();
      }),
  } as unknown as ForgeSites;
  const images = createPrImages({
    sites,
    share,
    placementsFor: () => [],
    pullRequest: () => ({ baseRef: "main" }),
    now: () => 0,
    probe: async () => "private",
    ...(waitMs === undefined ? {} : { waitMs }),
  });
  const open = (repo: string) => Effect.runPromise(Deferred.succeed(gate(repo), undefined));
  const ask = (key: string, src: string) => runtime.runPromise(images.image(key, src));
  return { runtime, reads, most, open, ask };
}

const upload = (n: number) =>
  `https://github.com/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae142${String(n).padStart(2, "0")}`;

test("requests for one image resolve once, and each repository signs at most four at a time", async () => {
  const { runtime, reads, most, open, ask } = await gated();
  const asked = [upload(0), upload(0), upload(0), ...[1, 2, 3, 4, 5, 6].map(upload)];
  const answers = Promise.all(asked.map((src) => ask(KEY, src)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(most.get("argus-labs/rampage-client")).toBe(4);
  await open("argus-labs/rampage-client");
  expect((await answers).every((answer) => answer.kind === "redirect")).toBe(true);
  expect(reads.filter((src) => src === upload(0))).toHaveLength(1);
  expect(reads).toHaveLength(7);
  await runtime.dispose();
});

test("a slow repository does not hold up another repository's images", async () => {
  const { runtime, open, ask } = await gated();
  const slow = Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ask(KEY, upload(n))));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await open("o/other");
  expect(await ask("gh:o/other:o:topic", upload(50))).toMatchObject({ kind: "redirect" });
  await open("argus-labs/rampage-client");
  await slow;
  await runtime.dispose();
});

test("a request waits a bounded time, answers the failed state, and the next load gets the result", async () => {
  const { runtime, open, ask } = await gated(30);
  const first = await ask(KEY, upload(1));
  expect(first).toMatchObject({ kind: "failed" });
  expect(imageProblem((first as Extract<ImageAnswer, { kind: "failed" }>).problem)).toBe(
    "GitHub is taking too long for this image.",
  );
  // The page loads it again on the next render, so the browser must not keep this answer.
  expect(imageResponse(first).headers.get("cache-control")).toBe("no-store");
  await open("argus-labs/rampage-client");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await ask(KEY, upload(1))).toMatchObject({ kind: "redirect", location: SIGNED });
  await runtime.dispose();
});

test("the host contract carries an image read's ref hints and its gone answer, bounded", () => {
  const read = { kind: "image", repo: { owner: "o", name: "r" }, src: UPLOAD };
  expect(reviewReadSchema.parse({ ...read, refs: ["topic", "main"] })).toMatchObject({
    refs: ["topic", "main"],
  });
  expect(reviewReadSchema.safeParse({ ...read, refs: ["a", "b", "c"] }).success).toBe(false);
  expect(reviewReadSchema.safeParse({ ...read, refs: ["x".repeat(256)] }).success).toBe(false);
  expect(reviewAnswerSchema.parse({ kind: "image", location: null, gone: true })).toEqual({
    kind: "image",
    location: null,
    gone: true,
  });
});
