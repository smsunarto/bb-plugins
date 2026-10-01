import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as upstreamVcs from "../../../shared/node/vendor/local-vcs/src/index.ts";
import { ReviewInputError } from "../../../shared/vendor/review/src/review-api/input-error.ts";
import { checkoutFs } from "./checkout-fs.ts";
import { invokeHost } from "./client.ts";
import * as hostFs from "./fs.ts";
import * as vcs from "./local-vcs.ts";
import { defaultPullRequestDeps, githubRemotes } from "./pull-request.ts";
import { resolveReviewBranchLinks } from "./review-branch-links.ts";
import { ensureReviewPinnedCheckout } from "./review-head-checkout.ts";
import { resolveReviewStackLayers } from "./review-stack.ts";
import { type GitFixture, gitFixture } from "./testing/git-fixture.ts";
import {
  IN_PROCESS_HOST_ID,
  type InProcessHostClient,
  installInProcessHostIo,
} from "./testing/in-process.ts";
import { VCS_HOST } from "./vcs-proxy.ts";
import * as worktree from "./worktree-source.ts";

let repo: GitFixture;
let client: InProcessHostClient;
let uninstall: () => void;

beforeAll(() => {
  repo = gitFixture();
  ({ client, uninstall } = installInProcessHostIo());
});

afterAll(() => {
  uninstall();
  repo.remove();
});

const callsTo = (method: string) => client.calls.filter((call) => call.method === method);

describe("local-vcs facade", () => {
  it("detectLocalVcs answers a proxy bound to the host, whose methods run there", async () => {
    const proxy = await vcs.detectLocalVcs(repo.root);
    expect(proxy).not.toBeNull();
    expect(proxy!.kind).toBe("git");
    expect(proxy!.rootPath).toBe(repo.root);
    expect((proxy as unknown as Record<symbol, string>)[VCS_HOST]).toBe(IN_PROCESS_HOST_ID);

    const before = callsTo("vcsCall").length;
    expect(await proxy!.currentHead()).toEqual({ commit: repo.head });
    expect(await proxy!.resolveRevision("HEAD~1")).toEqual({ commit: repo.base });
    expect(await proxy!.resolveRevision("no-such-ref")).toBeNull();
    expect(await proxy!.mergeBase(repo.base, repo.head)).toEqual({ commit: repo.base });
    expect((await proxy!.listTrackedFiles()).sort()).toEqual([
      "docs/readme.md",
      "src/a.ts",
      "src/c.ts",
    ]);
    expect((await proxy!.listTrackedFiles(repo.base)).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await proxy!.readFileAtRef(repo.base, "src/a.ts")).toBe("export const a = 1;\n");
    expect(await proxy!.readFileAtRef(repo.base, "missing.ts")).toBeNull();
    expect(await proxy!.diffNameStatus({ base: repo.base, head: repo.head })).toEqual(
      await (await upstreamVcs.detectLocalVcs(repo.root))!.diffNameStatus({
        base: repo.base,
        head: repo.head,
      }),
    );
    expect(await proxy!.diffFileSummaries({ base: repo.base, head: repo.head })).toEqual([
      { path: "docs/readme.md", status: "added", additions: 1, deletions: 0 },
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
      { path: "src/c.ts", previousPath: "src/b.ts", status: "renamed", additions: 0, deletions: 0 },
    ]);
    const patch = await proxy!.diff({ base: repo.base, head: repo.head, format: "git" });
    expect(patch).toContain("+export const a2 = 20;\n");
    expect(patch).toBe(
      await (await upstreamVcs.detectLocalVcs(repo.root))!.diff({
        base: repo.base,
        head: repo.head,
        format: "git",
      }),
    );
    expect(await proxy!.defaultBranch()).toEqual(
      await (await upstreamVcs.detectLocalVcs(repo.root))!.defaultBranch(),
    );
    expect(await proxy!.githubRemoteSlug()).toBeNull();
    expect(
      callsTo("vcsCall")
        .slice(before)
        .map((call) => (call.input as { method: string }).method),
    ).toEqual([
      "currentHead",
      "resolveRevision",
      "resolveRevision",
      "mergeBase",
      "listTrackedFiles",
      "listTrackedFiles",
      "readFileAtRef",
      "readFileAtRef",
      "diffNameStatus",
      "diffFileSummaries",
      "diff",
      "defaultBranch",
      "githubRemoteSlug",
    ]);
  });

  it("detectLocalVcs answers null outside a repository", async () => {
    const outside = path.dirname(repo.root);
    expect(await vcs.detectLocalVcs(outside)).toBe(upstreamVcs.detectLocalVcsSync(outside));
  });

  it("gitCommonDir, resolveRepoContext and the sync cache they prime", async () => {
    const common = path.join(repo.root, ".git");
    expect(await vcs.gitCommonDir(repo.root)).toBe(common);
    const fresh = path.join(repo.root, "src");
    // A miss answers null and primes the cache; the next read has the context.
    expect(vcs.resolveRepoContextSync(fresh)).toBeNull();
    await expect
      .poll(() => vcs.resolveRepoContextSync(fresh))
      .toEqual({
        commonDir: common,
        originUrl: null,
        githubSlug: null,
      });
    repo.git("remote", "add", "origin", "git@github.com:Example/Repo.git");
    vcs.forgetRepoContext();
    expect(await vcs.resolveRepoContext(repo.root)).toEqual({
      commonDir: common,
      originUrl: "git@github.com:Example/Repo.git",
      githubSlug: "Example/Repo",
    });
    expect(vcs.resolveRepoContextSync(repo.root)).toEqual({
      commonDir: common,
      originUrl: "git@github.com:Example/Repo.git",
      githubSlug: "Example/Repo",
    });
    repo.git("remote", "remove", "origin");
    vcs.forgetRepoContext();
  });

  it("git passes args and options, and allowFailure keeps the failure as data", async () => {
    expect(await vcs.git(repo.root, ["rev-parse", "HEAD"])).toEqual({
      ok: true,
      stdout: `${repo.head}\n`,
      stderr: "",
    });
    const failed = await vcs.git(repo.root, ["rev-parse", "--verify", "nope"], {
      allowFailure: true,
    });
    expect(failed.ok).toBe(false);
    expect(failed.stdout).toBe("");
    await expect(vcs.git(repo.root, ["rev-parse", "--verify", "nope"])).rejects.toThrow(
      "Command failed: git --git-dir",
    );
  });

  it("diff, diffTrees and diffWorkingTree equal upstream run in-process", async () => {
    const input = { rootPath: repo.root, baseRef: repo.base, headRef: repo.head };
    expect(await vcs.diff(input)).toBe(await upstreamVcs.diff(input));
    // Git's name-only output follows the rename, so `src/b.ts` is not listed.
    expect(await vcs.diff({ ...input, nameOnly: true })).toBe(
      "docs/readme.md\nsrc/a.ts\nsrc/c.ts\n",
    );
    expect(await vcs.diffTrees({ ...input, kind: "git" })).toBe(
      await upstreamVcs.diffTrees({ ...input, kind: "git" }),
    );
    repo.write("src/a.ts", "export const a = 11;\n");
    repo.write("untracked.txt", "new\n");
    try {
      const working = { rootPath: repo.root, kind: "git" as const, baseRef: repo.head };
      expect(await vcs.diffWorkingTree(working)).toBe(await upstreamVcs.diffWorkingTree(working));
      expect(await vcs.diffWorkingTree({ ...working, paths: ["untracked.txt"] })).toContain(
        "+new\n",
      );
      expect(await vcs.diffFileSummariesWorkingTree(working)).toEqual([
        { path: "src/a.ts", status: "modified", additions: 1, deletions: 2 },
        { path: "untracked.txt", status: "added", additions: 1, deletions: 0 },
      ]);
    } finally {
      repo.git("checkout", "--", "src/a.ts");
      repo.git("clean", "-fdq");
    }
  });

  it("diffFileSummariesTrees, listCommitRange and listTrackedFilesAtCommit", async () => {
    expect(
      await vcs.diffFileSummariesTrees({
        rootPath: repo.root,
        baseRef: repo.base,
        headRef: repo.head,
        paths: ["src/a.ts"],
      }),
    ).toEqual([{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1 }]);
    expect(
      await vcs.listCommitRange({ rootPath: repo.root, baseRef: repo.base, headRef: repo.head }),
    ).toEqual([
      {
        commit: repo.head,
        parentCommit: repo.base,
        subject: "Head",
        author: "Whiteboard Test",
        authoredAt: "2026-01-02T03:04:05Z",
        fileCount: 3,
        additions: 3,
        deletions: 1,
      },
    ]);
    expect(
      await vcs.listTrackedFilesAtCommit({ rootPath: repo.root, kind: "git", commit: repo.base }),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("readFileAtCommit reads through the batched reader or in one host call", async () => {
    const reader = vcs.createBlobBatchReader({ rootPath: repo.root, kind: "git" });
    const input = { rootPath: repo.root, kind: "git" as const, commit: repo.base };
    const before = callsTo("readBlobs").length;
    const [a, b, missing, tree] = await Promise.all([
      vcs.readFileAtCommit({ ...input, relativePath: "src/a.ts", reader }),
      vcs.readFileAtCommit({ ...input, relativePath: "src/b.ts", reader }),
      vcs.readFileAtCommit({ ...input, relativePath: "nope.ts", reader }),
      vcs.readFileAtCommit({ ...input, relativePath: "src", reader }),
    ]);
    expect([a, b, missing, tree]).toEqual([
      "export const a = 1;\n",
      "export const b = 2;\nexport const bb = 22;\n",
      null,
      null,
    ]);
    // Four reads in one tick are one host call.
    expect(callsTo("readBlobs").length - before).toBe(1);
    expect(await vcs.readFileAtCommit({ ...input, relativePath: "src/b.ts" })).toBe(
      "export const b = 2;\nexport const bb = 22;\n",
    );
    await reader.close();
    expect(await reader.read(repo.base, "src/a.ts")).toBeNull();
  });
});

describe("worktree-source facade", () => {
  it("localSourcePath, readWorkingFile, workingFiles and inspectWorktree run on the host", async () => {
    const proxy = (await vcs.detectLocalVcs(repo.root))!;
    expect(await worktree.localSourcePath(repo.root, "src/a.ts")).toBe(
      path.join(repo.root, "src/a.ts"),
    );
    expect(await worktree.readWorkingFile(repo.root, "src/c.ts")).toBe(
      "export const b = 2;\nexport const bb = 22;\n",
    );
    expect(await worktree.readWorkingFile(repo.root, "gone.ts")).toBeNull();
    repo.write("scratch.txt", "x\n");
    writeFileSync(path.join(repo.root, ".gitignore"), "ignored.log\n");
    writeFileSync(path.join(repo.root, "ignored.log"), "noise\n");
    symlinkSync("src/a.ts", path.join(repo.root, "link.ts"));
    try {
      expect(await worktree.workingFiles(proxy)).toEqual([
        ".gitignore",
        "docs/readme.md",
        "link.ts",
        "scratch.txt",
        "src/a.ts",
        "src/c.ts",
      ]);
      // Git's representation of a link: its target text.
      expect(await worktree.readWorkingFile(repo.root, "link.ts")).toBe("src/a.ts");
      const first = await worktree.inspectWorktree("repo-1", proxy);
      expect(first.commit).toBe(repo.head);
      expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
      const tree = await worktree.retainedWorktreeTree("repo-1", first.revision, proxy);
      expect(repo.git("show", `${tree}:scratch.txt`)).toBe("x\n");
      repo.write("scratch.txt", "changed and longer\n");
      expect((await worktree.inspectWorktree("repo-1", proxy)).revision).not.toBe(first.revision);
    } finally {
      repo.git("clean", "-fdqx");
    }
  });

  it("rehydrates ReviewInputError with its class and status", async () => {
    const outside = path.join(path.dirname(repo.root), `outside-${path.basename(repo.root)}.ts`);
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, path.join(repo.root, "escape.ts"));
    try {
      const error = await worktree.localSourcePath(repo.root, "escape.ts").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReviewInputError);
      expect(error).toMatchObject({
        message: "Source symlink leaves the selected worktree.",
        status: 400,
      });
      const directory = await worktree.localSourcePath(repo.root, "src").catch((e: unknown) => e);
      expect(directory).toBeInstanceOf(ReviewInputError);
      expect((directory as Error).message).toBe("Source is not a regular file.");
    } finally {
      repo.git("clean", "-fdqx");
    }
  });
});

describe("fs and checkoutFs facades", () => {
  it("carries bytes, bigint stats, errno codes and the Stats methods", async () => {
    const file = path.join(repo.root, "bytes.bin");
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    try {
      await hostFs.writeFile(file, bytes);
      expect([...readFileSync(file)]).toEqual([0, 1, 2, 250, 255]);
      const read = await hostFs.readFile(file);
      expect(Buffer.isBuffer(read)).toBe(true);
      expect([...read]).toEqual([0, 1, 2, 250, 255]);
      await hostFs.writeFile(file, "text\n");
      expect(await hostFs.readFile(file, "utf8")).toBe("text\n");
      // `mode` applies when the host creates the file, as in `node:fs`.
      await hostFs.writeFile(path.join(repo.root, "private.txt"), "p\n", { mode: 0o600 });
      expect(statSync(path.join(repo.root, "private.txt")).mode & 0o777).toBe(0o600);

      const big = await hostFs.stat(file, { bigint: true });
      const local = statSync(file, { bigint: true });
      expect(typeof big.ino).toBe("bigint");
      expect(big.ino).toBe(local.ino);
      expect(big.dev).toBe(local.dev);
      expect(big.birthtimeNs).toBe(local.birthtimeNs);
      expect(big.isFile()).toBe(true);
      const small = await hostFs.stat(repo.root);
      expect(small.isDirectory()).toBe(true);
      expect(small.mtime).toEqual(statSync(repo.root).mtime);
      // Fractional milliseconds round as node:fs rounds them.
      utimesSync(file, 1000.0007, 1000.0007);
      expect((await hostFs.stat(file)).mtime.getTime()).toBe(1_000_001);
      expect((await hostFs.stat(file)).mtimeMs).toBe(1_000_000.7);

      symlinkSync("bytes.bin", path.join(repo.root, "bytes.link"));
      expect((await hostFs.lstat(path.join(repo.root, "bytes.link"))).isSymbolicLink()).toBe(true);
      expect(await hostFs.readlink(path.join(repo.root, "bytes.link"))).toBe("bytes.bin");
      expect(await hostFs.realpath(path.join(repo.root, "bytes.link"))).toBe(file);

      const missing = await hostFs.readFile(path.join(repo.root, "missing")).catch((e) => e);
      expect(missing).toBeInstanceOf(Error);
      expect((missing as NodeJS.ErrnoException).code).toBe("ENOENT");

      const nested = path.join(repo.root, "made/deep");
      expect(await hostFs.mkdir(nested, { recursive: true })).toBe(path.join(repo.root, "made"));
      expect(lstatSync(nested).isDirectory()).toBe(true);
      expect(await hostFs.exists(nested)).toBe(true);
      expect(await hostFs.exists(path.join(nested, "nope"))).toBe(false);

      expect(await hostFs.execFile("git", ["-C", repo.root, "rev-parse", "HEAD"])).toEqual({
        stdout: `${repo.head}\n`,
        stderr: "",
      });

      expect(await checkoutFs.readFile(file, "utf8")).toBe("text\n");
      expect((await checkoutFs.lstat(file)).isFile()).toBe(true);
      expect(() => checkoutFs.rm).toThrow("whiteboard: checkoutFs.rm is not carried to the host.");
    } finally {
      repo.git("clean", "-fdqx");
    }
  });
});

describe("the other host modules", () => {
  it("pull-request: the default run executes on the host and keeps upstream's failure text", async () => {
    expect(
      await defaultPullRequestDeps.run(
        "git",
        ["--git-dir", path.join(repo.root, ".git"), "rev-parse", "HEAD"],
        {
          timeoutMs: 10_000,
        },
      ),
    ).toBe(`${repo.head}\n`);
    await expect(
      defaultPullRequestDeps.run(
        "git",
        ["--git-dir", path.join(repo.root, ".git"), "rev-parse", "--verify", "nope"],
        {
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toThrow("git --git-dir: fatal: Needed a single revision");
    repo.git("remote", "add", "upstream", "https://github.com/Owner/Name.git");
    try {
      expect(await githubRemotes(path.join(repo.root, ".git"), defaultPullRequestDeps)).toEqual([
        { name: "upstream", slug: "Owner/Name" },
      ]);
    } finally {
      repo.git("remote", "remove", "upstream");
    }
  });

  it("review-branch-links runs on the host; an injected runner runs here", async () => {
    repo.git("remote", "add", "origin", "https://github.com/Owner/Name.git");
    repo.git("update-ref", "refs/remotes/origin/main", repo.head);
    try {
      expect(
        await resolveReviewBranchLinks({ rootPath: repo.root, baseRef: "main", headRef: "topic" }),
      ).toEqual({ baseUrl: "https://github.com/Owner/Name/tree/main", headUrl: null });
      const before = client.calls.length;
      expect(
        await resolveReviewBranchLinks(
          { rootPath: repo.root, baseRef: "main", headRef: "topic" },
          async () => ({ ok: false, stdout: "", stderr: "" }),
        ),
      ).toEqual({ baseUrl: null, headUrl: null });
      expect(client.calls.length).toBe(before);
    } finally {
      repo.git("remote", "remove", "origin");
    }
  });

  it("review-stack: an injected runner runs here; no PR binding asks nobody", async () => {
    const before = client.calls.length;
    expect(await resolveReviewStackLayers({ pullRequestUrl: null }, [])).toEqual([]);
    expect(client.calls.length).toBe(before);
    expect(
      await resolveReviewStackLayers(
        { pullRequestUrl: "https://github.com/o/r/pull/2" },
        [],
        async () => JSON.stringify([{ pull_requests: [{ number: 2, head: { ref: "two" } }] }]),
      ),
    ).toEqual([
      {
        branch: "two",
        pullRequestNumber: 2,
        pullRequestUrl: "https://github.com/o/r/pull/2",
        reviewUuid: null,
        reviewTitle: null,
        relation: "current",
      },
    ]);
  });

  it("review-stack: a host that cannot ask GitHub answers no layers", async () => {
    const before = callsTo("invoke").length;
    expect(
      await resolveReviewStackLayers(
        { pullRequestUrl: "https://github.com/whiteboard-test-owner-404/none/pull/1" },
        [],
      ),
    ).toEqual([]);
    expect(callsTo("invoke").slice(before)).toEqual([
      {
        method: "invoke",
        hostId: IN_PROCESS_HOST_ID,
        input: {
          module: "review-stack",
          fn: "resolveReviewStackLayers",
          args: [
            { pullRequestUrl: "https://github.com/whiteboard-test-owner-404/none/pull/1" },
            [],
          ],
        },
      },
    ]);
  }, 30_000);

  it("review-head-checkout materializes the pinned checkout on the host", async () => {
    const checkout = await ensureReviewPinnedCheckout({
      rootPath: repo.root,
      ref: repo.base,
      reviewUuid: "00000000-0000-4000-8000-000000000001",
    });
    expect(checkout).toBe(
      path.join(
        repo.root,
        ".git/dev-fast/reviews/00000000-0000-4000-8000-000000000001/head",
        repo.base,
      ),
    );
    expect(readFileSync(path.join(checkout!, "src/b.ts"), "utf8")).toBe(
      "export const b = 2;\nexport const bb = 22;\n",
    );
    expect(
      await ensureReviewPinnedCheckout({
        rootPath: repo.root,
        ref: "no-such-ref",
        reviewUuid: "00000000-0000-4000-8000-000000000001",
      }),
    ).toBeNull();
  });

  it("rejects a function the allowlist does not name", async () => {
    await expect(invokeHost("local-vcs", "gitArgsSync", [repo.root, []], {})).rejects.toMatchObject(
      {
        name: "unknown_function",
        message: "whiteboard: local-vcs.gitArgsSync is not an allowlisted host function.",
      },
    );
    await expect(invokeHost("fs", "constructor", [], {})).rejects.toMatchObject({
      name: "unknown_function",
    });
  });
});

describe("payload split", () => {
  // Three files of ~3 MiB each: every file fits one hop, the whole patch does not.
  const big = (seed: string) =>
    Array.from({ length: 70_000 }, (_, line) => `${seed} line ${line} ${"x".repeat(32)}\n`).join(
      "",
    );
  let base: string;
  let head: string;

  beforeAll(() => {
    base = repo.git("rev-parse", "HEAD").trim();
    for (const name of ["one", "two", "three"]) repo.write(`big/${name}.txt`, big(name));
    head = repo.commit("Big");
  });

  afterAll(() => {
    repo.git("reset", "-q", "--hard", base);
  });

  it("re-reads diffTrees, diff, vcs.diff and diffWorkingTree in per-path batches", async () => {
    const input = { rootPath: repo.root, baseRef: base, headRef: head, kind: "git" as const };
    const expected = await upstreamVcs.diffTrees(input);
    expect(Buffer.byteLength(expected)).toBeGreaterThan(7 * 1024 * 1024);

    const before = callsTo("invoke").length;
    expect(await vcs.diffTrees(input)).toBe(expected);
    const trees = callsTo("invoke")
      .slice(before)
      .map((call) => call.input as { fn: string; args: [{ paths?: string[] }] })
      .map((call) => [call.fn, call.args[0].paths ?? null]);
    expect(trees).toEqual([
      ["diffTrees", null],
      ["diffFileSummariesTrees", null],
      // The whole set already failed, so the split starts at the halves.
      // Two ~3 MiB patches fit one hop. The halves are read in order.
      ["diffTrees", ["big/one.txt", "big/three.txt"]],
      ["diffTrees", ["big/two.txt"]],
    ]);

    const beforeDiff = callsTo("invoke").length;
    expect(await vcs.diff(input)).toBe(await upstreamVcs.diff(input));
    expect(
      callsTo("invoke")
        .slice(beforeDiff)
        .map((call) => call.input as { fn: string; args: [Record<string, unknown>] })
        .map((call) => [call.fn, call.args[0].paths ?? null, call.args[0].literalPaths ?? null]),
    ).toEqual([
      ["diff", null, null],
      ["detectLocalVcs", null, null],
      // Split reads name exact files, so a name such as `[id].tsx` is not a glob.
      ["diff", ["big/one.txt", "big/three.txt"], true],
      ["diff", ["big/two.txt"], true],
    ]);
    const proxy = (await vcs.detectLocalVcs(repo.root))!;
    expect(await proxy.diff({ base, head, format: "git" })).toBe(
      await (await upstreamVcs.detectLocalVcs(repo.root))!.diff({ base, head, format: "git" }),
    );
    expect(await vcs.diffWorkingTree({ rootPath: repo.root, kind: "git", baseRef: base })).toBe(
      await upstreamVcs.diffWorkingTree({ rootPath: repo.root, kind: "git", baseRef: base }),
    );
  }, 60_000);

  it("a single file above the hop limit fails with a clear error", async () => {
    repo.write("big/huge.txt", big("huge").repeat(3));
    const huge = repo.commit("Huge");
    try {
      await expect(
        vcs.diffTrees({ rootPath: repo.root, baseRef: head, headRef: huge, kind: "git" }),
      ).rejects.toMatchObject({
        name: "PayloadTooLarge",
        message: "whiteboard: the patch for big/huge.txt alone is above the host transfer limit.",
      });
    } finally {
      repo.git("reset", "-q", "--hard", head);
    }
  }, 60_000);
});

describe("blob reader batching", () => {
  it("splits a large answer across calls and re-requests the rest", async () => {
    const before = repo.git("rev-parse", "HEAD").trim();
    const chunk = "y".repeat(3 * 1024 * 1024);
    repo.write("blobs/one.txt", `1${chunk}`);
    repo.write("blobs/two.txt", `2${chunk}`);
    const commit = repo.commit("Blobs");
    try {
      const reader = vcs.createBlobBatchReader({ rootPath: repo.root, kind: "git" });
      const start = callsTo("readBlobs").length;
      const [one, two] = await Promise.all([
        reader.read(commit, "blobs/one.txt"),
        reader.read(commit, "blobs/two.txt"),
      ]);
      expect(one!.toString("utf8")).toBe(`1${chunk}`);
      expect(two!.toString("utf8")).toBe(`2${chunk}`);
      const calls = callsTo("readBlobs")
        .slice(start)
        .map((call) =>
          (call.input as { items: { path: string }[] }).items.map((item) => item.path),
        );
      expect(calls).toEqual([["blobs/one.txt", "blobs/two.txt"], ["blobs/two.txt"]]);
    } finally {
      repo.git("reset", "-q", "--hard", before);
    }
  }, 30_000);
});

it("the fixture's head is what git reports (sanity)", () => {
  expect(
    execFileSync("git", ["-C", repo.root, "rev-parse", "HEAD~1"], { encoding: "utf8" }).trim(),
  ).toBe(repo.base);
  mkdirSync(path.join(repo.root, "tmp-check"), { recursive: true });
  repo.git("clean", "-fdqx");
});
