import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import entry, { branchHead, page, branchBase, requireSupportedGit } from "./review.ts";
const exec = promisify(execFile);

test("branch selection resolves its own tip independently of other applied stacks", () => {
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
  expect(branchHead(payload, "scott/feature")).toBe(c);
  payload.stacks[1]!.branches[0]!.commits[0]!.commitId = "e".repeat(40);
  expect(branchHead(payload, "scott/feature")).toBe(c);
  expect(() => branchHead(payload, "missing")).toThrow("Select an applied");
});

test("empty and conflicted branches require a safe checkpoint", () => {
  expect(() => branchHead({ stacks: [{ branches: [{ name: "x", commits: [] }] }] }, "x")).toThrow(
    "no checkpointed",
  );
  expect(() =>
    branchHead(
      {
        stacks: [
          { branches: [{ name: "x", commits: [{ commitId: "a".repeat(40), conflicted: true }] }] },
        ],
      },
      "x",
    ),
  ).toThrow("conflicted");
});

test("branch review excludes sibling stacks, higher branches, and dirty workspace files", async () => {
  const path = await mkdtemp(join(tmpdir(), "bb-review-stacks-"));
  const bin = join(path, "bin");
  const previousPath = process.env.PATH;
  const harness = experimental_createHostEntryHarness(entry);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: path })).stdout.trim();
  const addCommit = async (file: string) => {
    await writeFile(join(path, file), `${file}\n`);
    await git("add", file);
    await git("commit", "-m", file);
    return git("rev-parse", "HEAD");
  };
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "review-test@example.invalid");
    await git("config", "user.name", "Review Test");
    const base = await addCommit("base.txt");
    await git("checkout", "-b", "scott/dependency");
    const dependency = await addCommit("dependency.txt");
    await git("checkout", "-b", "scott/feature");
    const head = await addCommit("feature.txt");
    await git("checkout", "-b", "scott/above");
    const above = await addCommit("above.txt");
    await git("checkout", "-b", "scott/other", "main");
    const other = await addCommit("other.txt");
    await git("checkout", "-b", "gitbutler/workspace", "main");
    await git("merge", "--no-ff", "scott/above", "scott/other", "-m", "GitButler Workspace Commit");
    await writeFile(join(path, "feature.txt"), "dirty feature edit\n");
    await writeFile(join(path, "untracked.txt"), "untracked work\n");

    // Stub only GitButler's metadata boundary; snapshot and reads use real Git objects.
    await mkdir(bin);
    const branch = (name: string, commitId: string) => ({ name, commits: [{ commitId }] });
    const state = {
      mergeBase: { commitId: base },
      stacks: [
        { branches: [branch("scott/other", other)] },
        {
          branches: [
            branch("scott/above", above),
            branch("scott/feature", head),
            branch("scott/dependency", dependency),
          ],
        },
      ],
    };
    await writeFile(join(bin, "but.json"), JSON.stringify(state));
    await writeFile(
      join(bin, "but"),
      '#!/bin/sh\n[ "$1" = status ] && [ "$2" = --json ] || exit 2\nexec cat "$0.json"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    const target = await harness.experimental_call("reviewSnapshot", {
      environmentPath: path,
      target: { branch: "scott/feature" },
    });
    expect(target).toMatchObject({ branch: "scott/feature", base, head });
    const diff = await harness.experimental_call("reviewRead", {
      target,
      section: "diff",
      side: "head",
      offset: 0,
    });
    const files = [...diff.text.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(
      (match) => match[2],
    );
    expect(files).toEqual(["dependency.txt", "feature.txt"]);
    const source = await harness.experimental_call("reviewRead", {
      target,
      section: "file",
      path: "feature.txt",
      side: "head",
      offset: 0,
    });
    expect(source.text).toBe("feature.txt\n");
    // Even an explicit SHA must not let the combined workspace become the candidate.
    await expect(
      harness.experimental_call("reviewSnapshot", {
        environmentPath: path,
        target: { base, head: await git("rev-parse", "gitbutler/workspace") },
      }),
    ).rejects.toThrow("workspace commits");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await harness.experimental_dispose();
    await rm(path, { recursive: true, force: true });
  }
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
    const target = await harness.experimental_call("reviewSnapshot", {
      environmentPath: path,

      target: { base, head },
    });
    expect(target).toEqual({ repositoryPath: await realpath(path), branch: null, base, head });
    // Explicit comparisons need only the requested commits, with no publication policy.
    expect(
      await harness.experimental_call("reviewSnapshot", {
        environmentPath: path,
        target: { base: head, head },
      }),
    ).toMatchObject({ base: head, head });

    await writeFile(join(path, "source.txt"), "unrelated later work\n");
    await git("add", "source.txt");
    await git("commit", "-m", "later");
    await writeFile(join(path, "source.txt"), "dirty shared workspace\n");
    const source = await harness.experimental_call("reviewRead", {
      target,
      section: "file",
      path: "source.txt",
      side: "head",
      offset: 0,
    });
    expect(source).toMatchObject({ text: "reviewed\n", nextOffset: null, totalLength: 9 });
    // Shared-workspace attributes must not hide a candidate's text diff.
    await writeFile(join(path, ".gitattributes"), "source.txt binary\n");
    const diff = await harness.experimental_call("reviewRead", {
      target,
      section: "diff",
      side: "head",
      offset: 0,
    });
    expect(diff.text).toContain("-base\n+reviewed");
    expect(diff.text).not.toContain("later work");
    await expect(
      harness.experimental_call("reviewRead", {
        target,
        section: "file",
        path: "../source.txt",
        side: "head",
        offset: 0,
      }),
    ).rejects.toThrow("repository-relative");
    await expect(
      harness.experimental_call("reviewSnapshot", {
        environmentPath: path,

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
      harness.experimental_call("reviewSnapshot", {
        environmentPath: path,

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

test("branch review uses the workspace merge base for the full changeset", () => {
  const base = "a".repeat(40);
  expect(branchBase({ mergeBase: { commitId: base } })).toBe(base);
  expect(() => branchBase({})).toThrow();
});

test("unsupported Git fails before dispatch instead of wasting an implementation review", () => {
  expect(() => requireSupportedGit("git version 2.39.5")).toThrow("Git 2.41 or newer");
  expect(() => requireSupportedGit("git version 2.40.1")).toThrow("Git 2.41 or newer");
  expect(() => requireSupportedGit("git version 2.41.0")).not.toThrow();
  expect(() => requireSupportedGit("git version 2.50.1 (Apple Git-155)")).not.toThrow();
});
