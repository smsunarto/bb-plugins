/**
 * One contract, two providers: a plain-git clone and a GitButler workspace
 * holding the same branch in the same state must read as the same Change,
 * and both must refuse a write made against a revision they have moved past.
 *
 * Every `but` here runs with HOME and the XDG directories inside a temporary
 * root (see test/isolate.ts), so the user's own GitButler projects and
 * settings are never read or written.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { findBranch, type Revision, type VcsAction, type WorkspaceValue } from "../core/change.ts";
import { isolate } from "../../test/isolate.ts";
import { BRANCH, buildRepos, git, ref, type Repos } from "../../test/repos.ts";
import hostEntry from "./host.ts";

const env = await isolate("source-control-contract");
const host = experimental_createHostEntryHarness(hostEntry);
let repos: Repos;

beforeAll(async () => {
  repos = await buildRepos(env.root, env.but !== null);
}, 60_000);

afterAll(async () => {
  await host.experimental_dispose();
  await env.cleanup();
});

const STALE = "0".repeat(40);

async function read(path: string): Promise<WorkspaceValue> {
  const result = await host.experimental_call("workspace", { path, readAs: "auto" });
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.state !== "workspace") throw new Error(`read as ${result.value.state}`);
  return result.value.value;
}

/** The checkout each provider reads; the GitButler one only where `but` is installed. */
const cases = [
  { provider: "git", path: () => repos.plain },
  ...(env.but === null ? [] : [{ provider: "gitbutler", path: () => repos.gitbutler! }]),
] as const;

if (env.but === null) {
  test.skip("GitButler provider: no `but` CLI on this machine, so its half is skipped", () => {});
}

describe.skipIf(env.but === null)("both providers", () => {
  test("read branch X as the same branch, differing only in provider", async () => {
    const [plain, workspace] = await Promise.all([read(repos.plain), read(repos.gitbutler!)]);
    expect(plain.provider).toBe("git");
    expect(workspace.provider).toBe("gitbutler");
    expect(plain.checkedOut).toBe(BRANCH);
    expect(workspace.checkedOut).toBeNull();

    const branch = findBranch(plain, BRANCH);
    expect(branch).toMatchObject({
      name: BRANCH,
      head: repos.unpushed,
      remote: { ref: `origin/${BRANCH}`, name: BRANCH },
      status: "ahead",
      push: "push",
      ahead: 1,
      behind: 0,
      newUpstream: 0,
      upstreamCommits: [],
      moreCommits: 0,
    });
    expect(branch?.commits.map(({ id, subject }) => ({ id, subject }))).toEqual([
      { id: repos.unpushed, subject: "feat: two" },
      { id: repos.pushed, subject: "feat: one" },
    ]);
    expect(findBranch(workspace, BRANCH)).toEqual(branch);

    const { lastFetched: _plainFetch, ...plainTarget } = plain.target!;
    const { lastFetched: _butFetch, ...butTarget } = workspace.target!;
    expect(plainTarget).toEqual({
      ref: "origin/main",
      head: repos.base,
      behind: 0,
      base: { id: repos.base, subject: "chore: base" },
    });
    expect(butTarget).toEqual(plainTarget);
    expect(workspace.path).toBe(repos.gitbutler);
    expect(plain.commonDir).toBe(join(repos.plain, ".git"));
  });

  test("list the same edits as the same uncommitted files, and the same patches", async () => {
    const edit = async (path: string) => {
      await writeFile(join(path, "one.txt"), "one, edited\n");
      await writeFile(join(path, "new file.txt"), "new\n");
      await rm(join(path, "base.txt"));
    };
    await Promise.all([edit(repos.plain), edit(repos.gitbutler!)]);
    try {
      const uncommitted = (value: WorkspaceValue) =>
        [...value.uncommitted, ...value.stacks.flatMap((stack) => stack.assigned)].sort((a, b) =>
          a.path.localeCompare(b.path),
        );
      const [plain, workspace] = await Promise.all([read(repos.plain), read(repos.gitbutler!)]);
      expect(uncommitted(plain)).toEqual([
        { path: "base.txt", kind: "deleted" },
        { path: "new file.txt", kind: "added" },
        { path: "one.txt", kind: "modified" },
      ]);
      expect(uncommitted(workspace)).toEqual(uncommitted(plain));

      const files = async (path: string) => {
        const result = await host.experimental_call("patches", {
          path,
          readAs: "auto",
          source: { kind: "uncommitted" },
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.value.files
          .map(({ path: file, kind, patch }) => ({ path: file, kind, patched: patch !== "" }))
          .sort((a, b) => a.path.localeCompare(b.path));
      };
      expect(await files(repos.plain)).toEqual([
        { path: "base.txt", kind: "deleted", patched: true },
        { path: "new file.txt", kind: "added", patched: true },
        { path: "one.txt", kind: "modified", patched: true },
      ]);
      expect(await files(repos.gitbutler!)).toEqual(await files(repos.plain));
    } finally {
      for (const path of [repos.plain, repos.gitbutler!]) {
        git(path, "checkout", "--quiet", "--", ".");
        git(path, "clean", "--quiet", "-fd");
      }
    }
  });
});

describe.each(cases)("$provider provider", ({ path }) => {
  test("reads one commit's patches", async () => {
    const result = await host.experimental_call("patches", {
      path: path(),
      readAs: "auto",
      source: { kind: "commit", commitId: repos.unpushed },
    });
    expect(result.ok && result.value.files.map(({ path: file, kind }) => ({ file, kind }))).toEqual(
      [{ file: "two.txt", kind: "added" }],
    );
  });

  /** Every ref a stale write could move: the branch, its remote-tracking ref, and origin's. */
  const refs = () => ({
    branch: ref(path(), `refs/heads/${BRANCH}`),
    tracking: ref(path(), `refs/remotes/origin/${BRANCH}`),
    remoteBranch: ref(repos.origin, `refs/heads/${BRANCH}`),
    remoteMain: ref(repos.origin, "refs/heads/main"),
    head: ref(path(), "HEAD"),
  });

  const write = (action: VcsAction, expected: Revision) =>
    host.experimental_call("vcsAction", { path: path(), readAs: "auto", action, expected });

  test("refuses a push or land against a stale head, changing nothing", async () => {
    const before = refs();
    const push = await write(
      { kind: "push", branch: BRANCH, force: false, acceptedLoss: [] },
      { head: STALE, target: repos.base },
    );
    expect(push).toMatchObject({ status: "conflict" });
    const land = await write(
      { kind: "land", branch: BRANCH, message: "feat: one and two", accepted: null },
      { head: STALE, target: repos.base },
    );
    expect(land).toMatchObject({ status: "conflict" });
    expect(refs()).toEqual(before);
  });

  test("refuses a pull or land against a stale target, changing nothing", async () => {
    const before = refs();
    const pull = await write({ kind: "pull", accepted: null }, { head: null, target: STALE });
    expect(pull).toMatchObject({ status: "conflict" });
    const land = await write(
      { kind: "land", branch: BRANCH, message: "feat: one and two", accepted: null },
      { head: repos.unpushed, target: STALE },
    );
    expect(land).toMatchObject({ status: "conflict" });
    expect(refs()).toEqual(before);
  });

  test("refuses a write on a branch it does not have", async () => {
    const result = await write(
      { kind: "push", branch: "nowhere", force: false, acceptedLoss: [] },
      { head: repos.unpushed, target: repos.base },
    );
    expect(result).toEqual({
      status: "conflict",
      detail: "nowhere is no longer in this checkout.",
    });
  });

  test("pulls nothing when the target has nothing new", async () => {
    const result = await write(
      { kind: "pull", accepted: null },
      { head: null, target: repos.base },
    );
    expect(result).toEqual({ status: "upToDate" });
  });

  test("pushes the branch at the revision it was read at", async () => {
    const result = await write(
      { kind: "push", branch: BRANCH, force: false, acceptedLoss: [] },
      { head: repos.unpushed, target: repos.base },
    );
    // The provider that runs second finds origin already at the head the first pushed.
    expect(["done", "upToDate"]).toContain(result.status);
    expect(ref(repos.origin, `refs/heads/${BRANCH}`)).toBe(repos.unpushed);
    const branch = findBranch(await read(path()), BRANCH);
    expect(branch).toMatchObject({ status: "pushed", ahead: 0, behind: 0, push: "none" });
  });
});
/** Delete removes the branch the shared repositories hold, so it gets its own. */
describe.each(cases)("$provider provider deletes a branch", ({ provider }) => {
  let own: Repos;
  beforeAll(async () => {
    own = await buildRepos(
      env.root,
      provider === "gitbutler",
      join(env.root, `delete-${provider}`),
    );
  }, 60_000);
  const path = () => (provider === "git" ? own.plain : own.gitbutler!);
  const write = (action: VcsAction, expected: Revision) =>
    host.experimental_call("vcsAction", { path: path(), readAs: "auto", action, expected });

  test("refuses a delete against a stale head, changing nothing", async () => {
    const before = ref(path(), `refs/heads/${BRANCH}`);
    const result = await write(
      { kind: "delete", branch: BRANCH, accepted: null },
      { head: STALE, target: own.base },
    );
    expect(result).toMatchObject({ status: "conflict" });
    expect(ref(path(), `refs/heads/${BRANCH}`)).toBe(before);
  });

  test("deletes the local branch at the revision it was read at, leaving origin's", async () => {
    const remote = ref(own.origin, `refs/heads/${BRANCH}`);
    const result = await write(
      { kind: "delete", branch: BRANCH, accepted: null },
      { head: own.unpushed, target: own.base },
    );
    expect(result).toEqual({ status: "done" });
    expect(ref(path(), `refs/heads/${BRANCH}`)).toBeNull();
    expect(ref(own.origin, `refs/heads/${BRANCH}`)).toBe(remote);
  });
});

/** Commit adds commits to X, so it gets its own repositories too. */
describe.each(cases)("$provider provider commits the reader's files", ({ provider }) => {
  let own: Repos;
  beforeAll(async () => {
    own = await buildRepos(
      env.root,
      provider === "gitbutler",
      join(env.root, `commit-${provider}`),
    );
  }, 60_000);
  const path = () => (provider === "git" ? own.plain : own.gitbutler!);
  const write = (action: VcsAction, expected: Revision) =>
    host.experimental_call("vcsAction", { path: path(), readAs: "auto", action, expected });
  const commit = (paths: string[], head: string) =>
    write(
      { kind: "commit", branch: BRANCH, message: "feat: three", paths },
      { head, target: own.base },
    );

  test("refuses a commit against a stale head, or of a file that is no longer changed", async () => {
    await writeFile(join(path(), "three.txt"), "three\n");
    const before = ref(path(), `refs/heads/${BRANCH}`);
    expect(await commit(["three.txt"], STALE)).toMatchObject({ status: "conflict" });
    expect(await commit(["gone.txt"], own.unpushed)).toEqual({
      status: "conflict",
      detail: "gone.txt has no uncommitted change here any more.",
    });
    expect(ref(path(), `refs/heads/${BRANCH}`)).toBe(before);
  });

  test("commits exactly the named files onto the branch, a literal `*` included, and leaves the rest", async () => {
    await writeFile(join(path(), "three.txt"), "three\n");
    await writeFile(join(path(), "*.txt"), "star\n");
    await writeFile(join(path(), "four.txt"), "four\n");
    const result = await commit(["three.txt", "*.txt"], own.unpushed);
    expect(result).toEqual({ status: "done" });
    const head = ref(path(), `refs/heads/${BRANCH}`)!;
    expect(git(path(), "log", "-1", "--format=%P %s", head).trim()).toBe(
      `${own.unpushed} feat: three`,
    );
    expect(
      git(path(), "show", "--name-only", "--format=", head).trim().split("\n").toSorted(),
    ).toEqual(["*.txt", "three.txt"]);
    const value = await read(path());
    expect(value.uncommitted.map((change) => change.path)).toEqual(["four.txt"]);
  });
});

describe("checkouts that are not a branch of a repository", () => {
  test("a directory outside any repository reads as not-git", async () => {
    expect(await host.experimental_call("workspace", { path: env.root, readAs: "auto" })).toEqual({
      ok: true,
      value: { state: "not-git", path: env.root },
    });
  });

  test("a detached checkout reads as detached", async () => {
    const detached = join(env.root, "detached");
    git(repos.plain, "worktree", "add", "--quiet", "--detach", detached, repos.base);
    expect(await host.experimental_call("workspace", { path: detached, readAs: "auto" })).toEqual({
      ok: true,
      value: { state: "detached", path: detached },
    });
  });
});

describe.skipIf(env.but === null)("a GitButler workspace", () => {
  test("reads as plain git when asked to", async () => {
    const value = await host.experimental_call("workspace", {
      path: repos.gitbutler!,
      readAs: "git",
    });
    expect(value.ok && value.value.state === "workspace" && value.value.value).toMatchObject({
      provider: "git",
      checkedOut: "gitbutler/workspace",
    });
  });

  test("on a host without `but` says so, once", async () => {
    const path = process.env["PATH"];
    // Only the system directories, where git is and `but` is not.
    process.env["PATH"] = ["/usr/bin", "/bin"].join(":");
    try {
      expect(
        await host.experimental_call("workspace", { path: repos.gitbutler!, readAs: "auto" }),
      ).toEqual({
        ok: false,
        error: {
          code: "but-missing",
          message: "The GitButler CLI (but) is not installed on this host.",
        },
      });
    } finally {
      process.env["PATH"] = path;
    }
  });
});
