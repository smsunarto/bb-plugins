import { Deferred, Effect, ManagedRuntime } from "effect";
import { expect, test } from "vitest";
import type { ChangeKey } from "../core/ids.ts";
import type { ReviewRead } from "../forge/review.ts";
import { ForgeUnavailable, type ForgeSites } from "./forge-sites.ts";
import { SharedWork } from "./shared.ts";
import {
  createPrImages,
  FAILED_KEPT_MS,
  imageProblem,
  imageResponse,
  REDIRECT_MAX_AGE_S,
  SIGNED_KEPT_MS,
  type ImageAnswer,
} from "./pr-images.ts";

const KEY = "gh:argus-labs/rampage-client:argus-labs:scott/scene-router" as ChangeKey;
const UPLOAD = "https://github.com/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c";
const SIGNED = "https://github-production-user-asset-6210df.s3.amazonaws.com/1/2.png?sig=1";

function world(
  options: { open?: boolean; answer?: () => Effect.Effect<unknown, ForgeUnavailable> } = {},
) {
  const reads: ReviewRead[] = [];
  const probes: string[] = [];
  let now = 1_000_000;
  const sites = {
    repoRead: (read: ReviewRead) => {
      reads.push(read);
      return (options.answer?.() ?? Effect.succeed({ kind: "image", location: SIGNED })) as never;
    },
  } as unknown as ForgeSites;
  const images = createPrImages({
    sites,
    share: (_key, work) => work,
    placementsFor: () => [],
    now: () => now,
    probe: async (url) => {
      probes.push(url);
      return options.open ?? false;
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

test("a public image redirects to its own URL without asking a site", async () => {
  const { reads, image } = world({ open: true });
  const answer = await image(KEY, UPLOAD);
  expect(answer).toMatchObject({ kind: "redirect", location: UPLOAD });
  expect(reads).toEqual([]);
});

test("a private image redirects to the signed URL its repository's site resolves", async () => {
  const { reads, image } = world();
  const response = imageResponse(await image(KEY, UPLOAD));
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(SIGNED);
  expect(response.headers.get("cache-control")).toBe(`private, max-age=${REDIRECT_MAX_AGE_S}`);
  expect(reads).toEqual([
    { kind: "image", repo: { owner: "argus-labs", name: "rampage-client" }, src: UPLOAD },
  ]);
});

test("a committed file of the head's fork is read from the fork", async () => {
  const fork = "gh:o/r:fork:topic" as ChangeKey;
  const { reads, image } = world();
  await image(fork, "https://github.com/Fork/R/blob/abc/a.png?raw=true");
  expect(reads[0]).toMatchObject({ repo: { owner: "fork", name: "r" } });
});

test("a signed URL is kept briefly and never handed out past GitHub's 300 s", async () => {
  const { reads, image, tick } = world();
  await image(KEY, UPLOAD);
  tick(SIGNED_KEPT_MS - 30_000);
  const late = await image(KEY, UPLOAD);
  expect(reads).toHaveLength(1);
  // Kept for 120 s here, then at most 30 s by the browser: well inside 300 s.
  expect(late).toMatchObject({ kind: "redirect", maxAgeS: 30 });
  tick(30_000);
  await image(KEY, UPLOAD);
  expect(reads).toHaveLength(2);
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

test("an image no signed-in account can see says so, not that gh is signed out", () => {
  expect(
    imageProblem({
      kind: "auth",
      site: "dev-pc",
      detail: "No signed-in GitHub account can see o/r.",
    }),
  ).toBe("No signed-in GitHub account can see this image.");
});

test("concurrent requests for one image resolve once, and at most four images resolve at a time", async () => {
  const runtime = ManagedRuntime.make(SharedWork.layer);
  const share = await runtime.runPromise(Effect.service(SharedWork));
  const gate = await Effect.runPromise(Deferred.make<void>());
  let running = 0;
  let most = 0;
  const reads: string[] = [];
  const sites = {
    repoRead: (read: Extract<ReviewRead, { kind: "image" }>) =>
      Effect.gen(function* () {
        reads.push(read.src);
        running += 1;
        most = Math.max(most, running);
        yield* Deferred.await(gate);
        running -= 1;
        return { kind: "image", location: SIGNED };
      }),
  } as unknown as ForgeSites;
  const images = createPrImages({
    sites,
    share,
    placementsFor: () => [],
    now: () => 0,
    probe: async () => false,
  });
  const ids = Array.from({ length: 6 }, (_, n) => `0993b262-b0ae-4631-b40a-65c93ae1420${n}`);
  const asked = [
    UPLOAD,
    UPLOAD,
    UPLOAD,
    ...ids.map((id) => `https://github.com/user-attachments/assets/${id}`),
  ];
  const answers = Promise.all(asked.map((src) => runtime.runPromise(images.image(KEY, src))));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(most).toBe(4);
  await Effect.runPromise(Deferred.succeed(gate, undefined));
  expect((await answers).every((answer) => answer.kind === "redirect")).toBe(true);
  expect(reads.filter((src) => src === UPLOAD)).toHaveLength(1);
  expect(reads).toHaveLength(7);
  await runtime.dispose();
});

test("an image no account sees is the failed state, kept briefly so loads do not re-ask every account", async () => {
  const { reads, image, tick } = world({
    answer: () => Effect.succeed({ kind: "image", location: null }) as never,
  });
  const first = await image(KEY, UPLOAD);
  expect(first).toMatchObject({ kind: "failed" });
  expect(imageProblem((first as Extract<ImageAnswer, { kind: "failed" }>).problem)).toBe(
    "No signed-in GitHub account can see this image.",
  );
  await image(KEY, UPLOAD);
  expect(reads).toHaveLength(1);
  tick(FAILED_KEPT_MS);
  await image(KEY, UPLOAD);
  expect(reads).toHaveLength(2);
});
