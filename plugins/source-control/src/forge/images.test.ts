import { expect, test } from "vitest";
import { parseGitHubImage } from "../core/pr-images.ts";
import type { Exec } from "./github.ts";
import { resolveImage, type Fetch } from "./images.ts";
import { runReviewRead } from "./review.ts";

const UPLOAD = "https://github.com/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c";
const SIGNED =
  "https://github-production-user-asset-6210df.s3.amazonaws.com/1/2-0993b262.png?X-Amz-Expires=300";

const token: Exec = async (args) =>
  args[0] === "auth"
    ? { code: 0, stdout: "gho_secret\n", stderr: "" }
    : { code: 1, stdout: "", stderr: "unexpected" };

function answering(status: number, location: string | null) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status, headers: location ? { location } : {} });
  };
  return { calls, fetchImpl };
}

test("an upload resolves to GitHub's signed redirect, the token sent only to github.com in a header", async () => {
  const { calls, fetchImpl } = answering(302, SIGNED);
  const location = await resolveImage(token, parseGitHubImage(UPLOAD)!, undefined, fetchImpl);
  expect(location).toBe(SIGNED);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(UPLOAD);
  expect(calls[0]!.init).toMatchObject({
    method: "HEAD",
    redirect: "manual",
    headers: { authorization: "token gho_secret" },
  });
});

test("an upload that redirects anywhere but GitHub's image hosts is refused", async () => {
  for (const location of [
    "https://evil.example/x.png",
    "http://github-production-user-asset-6210df.s3.amazonaws.com/x.png",
    "https://evil.s3.amazonaws.com/x.png",
    null,
  ]) {
    const { fetchImpl } = answering(302, location);
    await expect(
      resolveImage(token, parseGitHubImage(UPLOAD)!, undefined, fetchImpl),
    ).rejects.toMatchObject({ code: "failed" });
  }
});

test("an upload this account cannot see is not-found, so the next account is tried", async () => {
  const { fetchImpl } = answering(404, null);
  await expect(
    resolveImage(token, parseGitHubImage(UPLOAD)!, undefined, fetchImpl),
  ).rejects.toMatchObject({ code: "not-found" });
});

test("a committed file resolves through the contents API's download URL", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push([...args]);
    return {
      code: 0,
      stdout: "https://raw.githubusercontent.com/o/r/abc/docs/a%20b.png?token=TEMP\n",
      stderr: "",
    };
  };
  const image = parseGitHubImage("https://github.com/O/R/blob/abc/docs/a%20b.png?raw=true")!;
  expect(await resolveImage(exec, image)).toBe(
    "https://raw.githubusercontent.com/o/r/abc/docs/a%20b.png?token=TEMP",
  );
  expect(calls).toEqual([
    ["api", "repos/o/r/contents/docs/a%20b.png?ref=abc", "--jq", ".download_url"],
  ]);

  const elsewhere: Exec = async () => ({
    code: 0,
    stdout: "https://evil.example/a.png",
    stderr: "",
  });
  await expect(resolveImage(elsewhere, image)).rejects.toMatchObject({ code: "failed" });
});

test("an image this account cannot see is answered as missing, so the repository's account is kept", async () => {
  const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  expect(
    await runReviewRead(exec, {
      kind: "image",
      repo: { owner: "o", name: "r" },
      src: "https://github.com/o/r/blob/abc/a.png?raw=true",
    }),
  ).toEqual({ kind: "image", location: null });
  await expect(
    runReviewRead(exec, {
      kind: "image",
      repo: { owner: "o", name: "r" },
      src: "https://evil.example/a.png",
    }),
  ).rejects.toMatchObject({ code: "not-found" });
});

test("a committed file's path is checked again where the token is", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push([...args]);
    return { code: 0, stdout: "https://raw.githubusercontent.com/o/r/a.png", stderr: "" };
  };
  for (const path of ["x/../../other/repo/a.png", "./a.png", "a\\b.png", "a//b.png"])
    await expect(
      resolveImage(exec, {
        kind: "file",
        url: "",
        repo: { owner: "o", name: "r" },
        ref: "main",
        path,
      }),
    ).rejects.toMatchObject({ code: "failed" });
  expect(calls).toEqual([]);
});
