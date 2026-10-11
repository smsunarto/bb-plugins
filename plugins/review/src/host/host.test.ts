import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import entry, {
  branchCommits,
  page,
  validatePublicationBase,
  requireSupportedGit,
} from "./host.ts";
const exec = promisify(execFile);

test("branch scope uses only its owned commits, preserving lower stack ancestry as context", () => {
  const a = "a".repeat(40),
    b = "b".repeat(40),
    c = "c".repeat(40);
  const payload = {
    stacks: [
      {
        branches: [
          {
            name: "scott/feature",
            commits: [
              { commitId: c, conflicted: false },
              { commitId: b, conflicted: false },
            ],
          },
          { name: "scott/dependency", commits: [{ commitId: a, conflicted: false }] },
        ],
      },
      {
        branches: [
          { name: "scott/other", commits: [{ commitId: "d".repeat(40), conflicted: false }] },
        ],
      },
    ],
  };
  expect(branchCommits(payload, "scott/feature")).toEqual({ newest: c, oldest: b });
  payload.stacks[1]!.branches[0]!.commits[0]!.commitId = "e".repeat(40);
  expect(branchCommits(payload, "scott/feature")).toEqual({ newest: c, oldest: b });
  expect(() => branchCommits(payload, "missing")).toThrow("Select an applied");
});

test("empty and conflicted branches require a safe checkpoint", () => {
  expect(() =>
    branchCommits({ stacks: [{ branches: [{ name: "x", commits: [] }] }] }, "x"),
  ).toThrow("no checkpointed");
  expect(() =>
    branchCommits(
      {
        stacks: [
          { branches: [{ name: "x", commits: [{ commitId: "a".repeat(40), conflicted: true }] }] },
        ],
      },
      "x",
    ),
  ).toThrow("conflicted");
});

test("pinned source and diff remain unchanged after the live branch and working file move", async () => {
  const path = await mkdtemp(join(tmpdir(), "bb-review-git-"));
  const harness = experimental_createHostEntryHarness(entry);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: path })).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "review-test@example.invalid");
    await git("config", "user.name", "Review Test");
    await writeFile(join(path, "source.txt"), "base\n");
    await git("add", "source.txt");
    await git("commit", "-m", "base");
    const base = await git("rev-parse", "main");
    await writeFile(join(path, "source.txt"), "reviewed\n");
    await git("add", "source.txt");
    await git("commit", "-m", "candidate");
    const head = await git("rev-parse", "main");
    const target = await harness.experimental_call("snapshot", {
      environmentPath: path,
      scope: "segment",
      target: { base, head },
    });
    expect(target).toEqual({ repositoryPath: await realpath(path), branch: null, base, head });
    await git("branch", "destination", base);
    expect(
      await harness.experimental_call("snapshot", {
        environmentPath: path,
        scope: "publication",
        target: { base, head, upstream: "destination" },
      }),
    ).toEqual(target);
    await expect(
      harness.experimental_call("snapshot", {
        environmentPath: path,
        scope: "publication",
        target: { base: head, head, upstream: "destination" },
      }),
    ).rejects.toThrow("merge base");
    await expect(
      harness.experimental_call("snapshot", {
        environmentPath: path,
        scope: "publication",
        target: { base, head, upstream: base },
      }),
    ).rejects.toThrow("branch or remote-tracking");
    await expect(
      harness.experimental_call("snapshot", {
        environmentPath: path,
        scope: "publication",
        target: { base, head },
      }),
    ).rejects.toThrow("declared upstream");

    await writeFile(join(path, "source.txt"), "unrelated later work\n");
    await git("add", "source.txt");
    await git("commit", "-m", "later");
    await writeFile(join(path, "source.txt"), "dirty shared workspace\n");
    const source = await harness.experimental_call("read", {
      target,
      section: "file",
      path: "source.txt",
      side: "head",
      offset: 0,
    });
    expect(source).toMatchObject({ text: "reviewed\n", nextOffset: null, totalLength: 9 });
    // Shared-workspace attributes must not hide a candidate's text diff.
    await writeFile(join(path, ".gitattributes"), "source.txt binary\n");
    const diff = await harness.experimental_call("read", {
      target,
      section: "diff",
      side: "head",
      offset: 0,
    });
    expect(diff.text).toContain("-base\n+reviewed");
    expect(diff.text).not.toContain("later work");
    await expect(
      harness.experimental_call("read", {
        target,
        section: "file",
        path: "../source.txt",
        side: "head",
        offset: 0,
      }),
    ).rejects.toThrow("repository-relative");
    await expect(
      harness.experimental_call("snapshot", {
        environmentPath: path,
        scope: "segment",
        target: { base, head: "HEAD" },
      }),
    ).rejects.toThrow();
    await git("add", "source.txt");
    await git(
      "commit",
      "--author",
      "GitButler <gitbutler@gitbutler.com>",
      "-m",
      "GitButler Workspace Commit",
    );
    const workspaceSha = await git("rev-parse", "main");
    await expect(
      harness.experimental_call("snapshot", {
        environmentPath: path,
        scope: "segment",
        target: { base, head: workspaceSha },
      }),
    ).rejects.toThrow("workspace commits");
  } finally {
    await harness.experimental_dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("context pages cover complete content without silently clipping the tail", () => {
  const input = "a".repeat(16000) + "last page";
  const first = page(input, 0);
  const last = page(input, first.nextOffset!);
  expect(first.text + last.text).toBe(input);
  expect(last.nextOffset).toBeNull();
});

test("explicit publication scope rejects a narrower range than the entire workspace chain", () => {
  const base = "a".repeat(40);
  const workspace = { mergeBase: { commitId: base } };
  expect(() => validatePublicationBase(workspace, base)).not.toThrow();
  expect(() => validatePublicationBase(workspace, "b".repeat(40))).toThrow("entire selected chain");
  expect(() => validatePublicationBase({}, base)).toThrow();
});

test("unsupported Git fails before dispatch instead of wasting an implementation review", () => {
  expect(() => requireSupportedGit("git version 2.39.5")).toThrow("Git 2.41 or newer");
  expect(() => requireSupportedGit("git version 2.40.1")).toThrow("Git 2.41 or newer");
  expect(() => requireSupportedGit("git version 2.41.0")).not.toThrow();
  expect(() => requireSupportedGit("git version 2.50.1 (Apple Git-155)")).not.toThrow();
});
