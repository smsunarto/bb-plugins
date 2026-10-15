import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { fakeBut } from "../../test/fake-but.ts";
import { runGit, runGitCommand } from "./cli.ts";
import { prepareGitCheckoutChild, runGitAction } from "./git-actions.ts";
import {
  parseGitStatus,
  readGitCheckout,
  readGitPatches,
  readGitWorkspace,
} from "./git-workspace.ts";
import hostEntry from "./host.ts";

const signal = new AbortController().signal;
const host = experimental_createHostEntryHarness(hostEntry);
const name = "scott/isolated";
let scratch = "",
  main = "",
  isolated = "",
  remote = "",
  base = "",
  tip = "";
let restore: (() => Promise<void>) | undefined;
async function commit(path: string, file: string, content: string, message: string) {
  await writeFile(join(path, file), content);
  await runGit(path, ["add", "--", file], signal);
  await runGit(path, ["commit", "--quiet", "-m", message], signal);
  return (await runGit(path, ["rev-parse", "HEAD"], signal)).trim();
}
async function observed() {
  const identity = await readGitCheckout(isolated, signal);
  return { branch: identity.branch!, head: identity.head, origin: identity.origin };
}
function selection() {
  return { paths: [main], origin: remote.replace(/\.git$/, "") };
}
async function workspace() {
  return readGitWorkspace({ path: isolated, key: ".", name: "isolated" }, signal);
}
async function ref(path: string, name: string) {
  return (await runGit(path, ["rev-parse", name], signal)).trim();
}
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "gitbutler-native-"));
  main = join(scratch, "main");
  isolated = join(scratch, "external", "isolated");
  remote = join(scratch, "origin.git");
  await mkdir(main);
  await runGit(main, ["init", "--quiet", "--bare", "--initial-branch=main", remote], signal);
  await runGit(main, ["init", "--quiet", "--initial-branch=main", "."], signal);
  await runGit(main, ["config", "user.name", "Native Test"], signal);
  await runGit(main, ["config", "user.email", "native@example.com"], signal);
  await runGit(main, ["config", "commit.gpgsign", "false"], signal);
  base = await commit(main, "base.txt", "base\n", "chore: base");
  await runGit(main, ["remote", "add", "origin", remote], signal);
  await runGit(main, ["push", "--quiet", "-u", "origin", "main"], signal);
  await runGit(
    main,
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    signal,
  );
  await runGit(main, ["worktree", "add", "--quiet", "-b", name, isolated], signal);
  await commit(isolated, "first.txt", "first\n", "feat: first\n\nFirst body.");
  tip = await commit(isolated, "second.txt", "second\n", "feat: second");
});
afterEach(async () => {
  await restore?.();
  restore = undefined;
  await rm(scratch, { recursive: true, force: true });
});

test("native board reads only its own commits, dirty files, base and checkout identity", async () => {
  const log = join(scratch, "but.log");
  restore = await fakeBut(
    `printf '%s\\n' "$*" >> '${log}'; echo '{"error":"must_not_run"}'; exit 1`,
  );
  await writeFile(join(isolated, "base.txt"), "local edit\n");
  await writeFile(join(isolated, "new file\nname.txt"), "new\n");
  await writeFile(join(main, "main-only.txt"), "keep main dirty\n");
  const board = await host.experimental_call("workspace", {
    environmentPath: isolated,
    checkout: selection(),
  });
  expect(board.state).toBe("ready");
  expect(board.stacks[0]?.branches[0]?.commits.map(({ message }) => message)).toEqual([
    "feat: second",
    "feat: first\n\nFirst body.",
  ]);
  expect(board.stacks[0]?.branches[0]?.status).toBe("unpushed");
  expect(board.unassignedChanges).toEqual([
    { path: "base.txt", kind: "modified" },
    { path: "new file\nname.txt", kind: "added" },
  ]);
  expect(board.base?.commitId).toBe(base);
  expect(board.checkoutIdentity).toEqual({
    path: isolated,
    branch: name,
    head: tip,
    origin: remote.replace(/\.git$/, ""),
    commonDir: join(main, ".git"),
    kind: "git",
  });
  expect(await readFile(join(main, "main-only.txt"), "utf8")).toBe("keep main dirty\n");
  expect(await readFile(log, "utf8").catch(() => "")).toBe("");
});

test("native patches include staged, unstaged, untracked and selected-commit changes", async () => {
  await writeFile(join(isolated, "first.txt"), "staged\n");
  await runGit(isolated, ["add", "first.txt"], signal);
  await writeFile(join(isolated, "first.txt"), "staged plus working\n");
  await writeFile(join(isolated, "new.txt"), "untracked contents\n");
  const patches = await readGitPatches(isolated, { kind: "uncommitted" }, signal);
  expect(patches.files.map(({ path, kind }) => ({ path, kind }))).toEqual([
    { path: "first.txt", kind: "modified" },
    { path: "new.txt", kind: "added" },
  ]);
  expect(patches.files[0]?.patch).toContain("+staged plus working");
  expect(patches.files[1]?.patch).toContain("+untracked contents");
  expect(
    (await readGitPatches(isolated, { kind: "commit", commitId: tip }, signal)).files.map(
      ({ path }) => path,
    ),
  ).toEqual(["second.txt"]);
});

test("an unborn board and its staged/untracked patches remain readable", async () => {
  const unborn = join(scratch, "unborn");
  await mkdir(unborn);
  await runGit(unborn, ["init", "--quiet", "--initial-branch=fresh", "."], signal);
  await writeFile(join(unborn, "staged.txt"), "staged\n");
  await runGit(unborn, ["add", "staged.txt"], signal);
  await writeFile(join(unborn, "untracked.txt"), "untracked\n");
  const board = await readGitWorkspace({ path: unborn, key: ".", name: "unborn" }, signal);
  expect(board.stacks[0]?.branches[0]).toMatchObject({
    name: "fresh",
    status: "empty",
    commits: [],
    push: "none",
  });
  expect(
    (await readGitPatches(unborn, { kind: "uncommitted" }, signal)).files.map(({ path }) => path),
  ).toEqual(["staged.txt", "untracked.txt"]);
});

test("push publishes only the isolated branch and sets its first upstream", async () => {
  expect(
    await runGitAction(
      isolated,
      { kind: "push", branch: name, force: false, acceptedLoss: [] },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "done" });
  expect(await ref(remote, `refs/heads/${name}`)).toBe(tip);
  expect(await ref(remote, "main")).toBe(base);
  expect((await workspace()).stacks[0]?.branches[0]?.status).toBe("pushed");
  expect(await ref(main, "HEAD")).toBe(base);
});

test("rename rejects stale HEAD and changes only the actual isolated branch", async () => {
  await expect(
    runGitAction(isolated, { kind: "rename", branch: name, name: "scott/new" }, signal, {
      branch: name,
      head: base,
      origin: remote.replace(/\.git$/, ""),
    }),
  ).rejects.toThrow("changed");
  expect(
    await runGitAction(
      isolated,
      { kind: "rename", branch: name, name: "scott/new" },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "done" });
  expect((await readGitCheckout(isolated, signal)).branch).toBe("scott/new");
  expect((await readGitCheckout(main, signal)).branch).toBe("main");
});

test.each(["gitbutler/workspace", "gitbutler/edit", "gitbutler/internal"])(
  "internal %s HEAD keeps the managed driver and refuses native writes and child preflight",
  async (internal) => {
    await runGit(isolated, ["branch", "-m", name, internal], signal);
    const log = join(scratch, "internal-but.log");
    restore = await fakeBut(
      `printf '%s %s\\n' "$PWD" "$*" >> '${log}'; printf '%s\\n' '{"stacks":[]}'`,
    );
    const identity = await readGitCheckout(isolated, signal);
    expect(identity).toMatchObject({ kind: "gitbutler", branch: internal, head: tip });
    const board = await host.experimental_call("workspace", {
      environmentPath: isolated,
      checkout: selection(),
    });
    expect(board.checkoutIdentity).toMatchObject({ kind: "gitbutler", branch: internal });
    expect(board.stacks).toEqual([]);
    await expect(
      runGitAction(
        isolated,
        { kind: "rename", branch: internal, name: "scott/unsafe-rename" },
        signal,
        await observed(),
      ),
    ).rejects.toThrow("named isolated branch");
    await expect(
      host.experimental_call("butAction", {
        environmentPath: isolated,
        checkout: selection(),
        observed: await observed(),
        action: { kind: "rename", branch: internal, name: "scott/unsafe-rename" },
      }),
    ).rejects.toThrow("no longer in the workspace");
    for (const kind of ["review", "conflicts"] as const) {
      await expect(
        host.experimental_call("prepareCheckoutChild", {
          environmentPath: isolated,
          checkout: selection(),
          kind,
          observed: await observed(),
        }),
      ).rejects.toThrow("changed");
    }
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      `${isolated} status -u --json`,
      `${isolated} status -u --json`,
    ]);
    expect(await ref(isolated, `refs/heads/${internal}`)).toBe(tip);
    expect(await readGitCheckout(isolated, signal)).toMatchObject({ branch: internal, head: tip });
    expect(await ref(main, "HEAD")).toBe(base);
  },
);

test("delete preserves current files and leaves the detached checkout readable", async () => {
  expect(
    await host.experimental_call("butAction", {
      environmentPath: isolated,
      checkout: selection(),
      observed: await observed(),
      action: { kind: "delete", branch: name, accepted: null },
    }),
  ).toEqual({ status: "done" });
  expect(await readGitCheckout(isolated, signal)).toMatchObject({ branch: null, head: tip });
  expect(await readFile(join(isolated, "first.txt"), "utf8")).toBe("first\n");
  expect(
    (
      await runGit(main, ["for-each-ref", "--format=%(refname)", `refs/heads/${name}`], signal)
    ).trim(),
  ).toBe("");
  const after = await host.experimental_call("workspace", {
    environmentPath: isolated,
    checkout: selection(),
  });
  expect(after.state).toBe("ready");
  expect(after.stacks).toEqual([]);
  expect(after.base?.commitId).toBe(tip);
});

test.each(["delete", "land"] as const)(
  "%s removes branch configuration before the same branch name is recreated",
  async (kind) => {
    await runGit(main, ["config", `branch.${name}.remote`, "origin"], signal);
    await runGit(main, ["config", `branch.${name}.merge`, "refs/heads/different-upstream"], signal);
    await runGit(main, ["config", `branch.${name}.pushRemote`, "origin"], signal);
    await runGit(main, ["config", `branch.${name}.description`, "old branch description"], signal);
    const action =
      kind === "delete"
        ? ({ kind, branch: name, accepted: null } as const)
        : ({ kind, branch: name, message: "feat: landed", accepted: null } as const);
    expect(await runGitAction(isolated, action, signal, await observed())).toEqual({
      status: "done",
    });
    const head = await ref(isolated, "HEAD");
    await runGit(isolated, ["switch", "--quiet", "-c", name], signal);
    const after = await workspace();
    expect(after.stacks[0]?.branches[0]?.upstreamCommits).toEqual([]);
    expect(after.stacks[0]?.branches[0]?.status).toBe("unpushed");
    for (const key of ["remote", "merge", "pushRemote", "description"]) {
      const result = await runGitCommand(
        main,
        ["config", "--get", `branch.${name}.${key}`],
        signal,
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }
    expect(await ref(isolated, "HEAD")).toBe(head);
    expect(await ref(main, "HEAD")).toBe(base);
  },
);

test("a configuration cleanup failure reports the already deleted branch and preserves its files", async () => {
  await runGit(main, ["config", `branch.${name}.remote`, "origin"], signal);
  await runGit(main, ["config", `branch.${name}.merge`, "refs/heads/different-upstream"], signal);
  await writeFile(join(main, ".git", "config.lock"), "held by another process\n");
  await expect(
    runGitAction(
      isolated,
      { kind: "delete", branch: name, accepted: null },
      signal,
      await observed(),
    ),
  ).rejects.toThrow("branch was deleted, but its local branch configuration could not be removed");
  expect(await readGitCheckout(isolated, signal)).toMatchObject({ branch: null, head: tip });
  expect(await readFile(join(isolated, "first.txt"), "utf8")).toBe("first\n");
  expect(
    (
      await runGit(main, ["for-each-ref", "--format=%(refname)", `refs/heads/${name}`], signal)
    ).trim(),
  ).toBe("");
  expect((await runGit(main, ["config", "--get", `branch.${name}.merge`], signal)).trim()).toBe(
    "refs/heads/different-upstream",
  );
});

test("destructive actions reject dirty files without changing refs or files", async () => {
  await writeFile(join(isolated, "first.txt"), "preserve dirty work\n");
  for (const action of [
    { kind: "delete", branch: name, accepted: null },
    { kind: "land", branch: name, message: "feat: combined", accepted: null },
    { kind: "updateWorkspace", accepted: null },
  ] as const) {
    await expect(runGitAction(isolated, action, signal, await observed())).rejects.toThrow(
      "uncommitted changes",
    );
  }
  expect(await readGitCheckout(isolated, signal)).toMatchObject({ branch: name, head: tip });
  expect(await readFile(join(isolated, "first.txt"), "utf8")).toBe("preserve dirty work\n");
  expect(await ref(remote, "main")).toBe(base);
});

test("target update rebases only the isolated checkout", async () => {
  const target = await commit(main, "incoming.txt", "incoming\n", "feat: incoming");
  await runGit(main, ["push", "--quiet", "origin", "main"], signal);
  await writeFile(join(main, "sentinel.txt"), "untouched main work\n");
  expect(
    await runGitAction(
      isolated,
      { kind: "updateWorkspace", accepted: null },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "confirm", risk: { conflicted: [name], overlapsUncommitted: false } });
  expect(
    await runGitAction(
      isolated,
      { kind: "updateWorkspace", accepted: { conflicted: [name], overlapsUncommitted: false } },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "done" });
  expect((await workspace()).base?.commitId).toBe(target);
  expect((await workspace()).stacks[0]?.branches[0]?.commits.map(({ message }) => message)).toEqual(
    ["feat: second", "feat: first\n\nFirst body."],
  );
  expect(await readFile(join(main, "sentinel.txt"), "utf8")).toBe("untouched main work\n");
  expect(await ref(main, "HEAD")).toBe(target);
});

test("squash-land publishes one commit parented to target without moving main", async () => {
  await writeFile(join(main, "sentinel.txt"), "keep main\n");
  expect(
    await runGitAction(
      isolated,
      {
        kind: "land",
        branch: name,
        message: "feat: isolated work\n\nSquashed body.",
        accepted: null,
      },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "done" });
  const landed = await ref(remote, "main");
  expect((await runGit(remote, ["show", "-s", "--format=%B", landed], signal)).trim()).toBe(
    "feat: isolated work\n\nSquashed body.",
  );
  expect(await ref(remote, `${landed}^`)).toBe(base);
  expect((await runGit(remote, ["rev-list", "--count", `${base}..main`], signal)).trim()).toBe("1");
  expect(await readGitCheckout(isolated, signal)).toMatchObject({ branch: null, head: landed });
  expect(await ref(main, "HEAD")).toBe(base);
  expect(await readFile(join(main, "sentinel.txt"), "utf8")).toBe("keep main\n");
});

test.each([false, true])(
  "single-commit land retains the original author and date (target advanced=%s)",
  async (advanced) => {
    await runGit(isolated, ["reset", "--hard", base], signal);
    await writeFile(join(isolated, "contributed.txt"), "original contribution\n");
    await runGit(isolated, ["add", "contributed.txt"], signal);
    await runGit(
      isolated,
      [
        "commit",
        "--quiet",
        "--author=Original Contributor <contributor@example.com>",
        "--date=2001-02-03T04:05:06+05:30",
        "-m",
        "feat: contributed work\n\nOriginal body.",
      ],
      signal,
    );
    tip = await ref(isolated, "HEAD");
    let target = base;
    if (advanced) {
      target = await commit(main, "incoming.txt", "incoming\n", "feat: incoming");
      await runGit(main, ["push", "--quiet", "origin", "main"], signal);
    }
    await expect(
      runGitAction(
        isolated,
        { kind: "land", branch: name, message: "explicit changed message", accepted: null },
        signal,
        await observed(),
      ),
    ).rejects.toThrow("confirm its commit message");
    expect(await ref(remote, "main")).toBe(target);
    expect(
      await runGitAction(
        isolated,
        { kind: "land", branch: name, message: null, accepted: null },
        signal,
        await observed(),
      ),
    ).toEqual({ status: "done" });
    const landed = await ref(remote, "main");
    expect(landed === tip).toBe(!advanced);
    expect(await ref(remote, `${landed}^`)).toBe(target);
    expect(
      (await runGit(remote, ["show", "-s", "--format=%an%x00%ae%x00%aI", landed], signal)).trim(),
    ).toBe(
      ["Original Contributor", "contributor@example.com", "2001-02-03T04:05:06+05:30"].join("\0"),
    );
    expect((await runGit(remote, ["show", "-s", "--format=%B", landed], signal)).trimEnd()).toBe(
      "feat: contributed work\n\nOriginal body.",
    );
    expect(await ref(main, "HEAD")).toBe(target);
  },
);

test("status parsing keeps rename destinations and unmerged paths", () => {
  expect(parseGitStatus("R  new name\0old name\0UU conflict.txt\0?? new\nfile\0")).toEqual({
    changes: [
      { path: "new name", kind: "renamed" },
      { path: "conflict.txt", kind: "modified" },
      { path: "new\nfile", kind: "added" },
    ],
    conflicts: ["conflict.txt"],
    untracked: ["new\nfile"],
  });
});

test("a differently named upstream is the push destination and a triangular push is refused", async () => {
  await runGit(isolated, ["push", "--quiet", "-u", "origin", `${name}:review-feature`], signal);
  const next = await commit(isolated, "third.txt", "third\n", "feat: third");
  expect(
    await runGitAction(
      isolated,
      { kind: "push", branch: name, force: false, acceptedLoss: [] },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "done" });
  expect(await ref(remote, "review-feature")).toBe(next);
  expect(
    (
      await runGit(remote, ["for-each-ref", "--format=%(refname)", `refs/heads/${name}`], signal)
    ).trim(),
  ).toBe("");
  const fork = join(scratch, "fork.git");
  await runGit(main, ["init", "--bare", "--quiet", fork], signal);
  await runGit(main, ["remote", "add", "fork", fork], signal);
  await runGit(main, ["config", `branch.${name}.pushRemote`, "fork"], signal);
  expect((await workspace()).stacks[0]?.branches[0]).toMatchObject({
    status: "unknown",
    push: "none",
  });
  await expect(
    runGitAction(
      isolated,
      { kind: "push", branch: name, force: false, acceptedLoss: [] },
      signal,
      await observed(),
    ),
  ).rejects.toThrow("push remote differs");
  expect((await runGit(fork, ["for-each-ref", "--format=%(refname)"], signal)).trim()).toBe("");
});

test("pull fast-forwards the isolated branch from its real upstream", async () => {
  await runGitAction(
    isolated,
    { kind: "push", branch: name, force: false, acceptedLoss: [] },
    signal,
    await observed(),
  );
  const elsewhere = join(scratch, "elsewhere");
  await runGit(main, ["worktree", "add", "--quiet", "-b", "contributor", elsewhere, tip], signal);
  const incoming = await commit(
    elsewhere,
    "incoming.txt",
    "from collaborator\n",
    "feat: collaborator",
  );
  await runGit(elsewhere, ["push", "--quiet", "origin", `HEAD:${name}`], signal);
  expect(
    await runGitAction(
      isolated,
      { kind: "pull", branch: name, accepted: null },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "done" });
  expect(await ref(isolated, "HEAD")).toBe(incoming);
  expect(await ref(main, "HEAD")).toBe(base);
});

test("force push requires the actual upstream commit loss and publishes the observed tip", async () => {
  await runGitAction(
    isolated,
    { kind: "push", branch: name, force: false, acceptedLoss: [] },
    signal,
    await observed(),
  );
  const elsewhere = join(scratch, "force-contributor");
  await runGit(main, ["worktree", "add", "--quiet", "-b", "contributor", elsewhere, tip], signal);
  const upstream = await commit(elsewhere, "remote.txt", "remote\n", "feat: remote");
  await runGit(elsewhere, ["push", "--quiet", "origin", `HEAD:${name}`], signal);
  const local = await commit(isolated, "local.txt", "local\n", "feat: local");
  await expect(
    runGitAction(
      isolated,
      { kind: "push", branch: name, force: true, acceptedLoss: [] },
      signal,
      await observed(),
    ),
  ).rejects.toThrow("not asked about");
  expect(await ref(remote, name)).toBe(upstream);
  expect(
    await runGitAction(
      isolated,
      { kind: "push", branch: name, force: true, acceptedLoss: [upstream] },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "done" });
  expect(await ref(remote, name)).toBe(local);
});

test("an applied main-workspace branch cannot be rewritten through its isolated checkout", async () => {
  await runGit(main, ["switch", "--quiet", "-c", "gitbutler/workspace"], signal);
  const log = join(scratch, "guard.log");
  const payload = JSON.stringify({ stacks: [{ branches: [{ name, commits: [] }] }] });
  restore = await fakeBut(`printf '%s %s\\n' "$PWD" "$*" >> '${log}'; printf '%s\\n' '${payload}'`);
  await expect(
    runGitAction(
      isolated,
      { kind: "rename", branch: name, name: "scott/new" },
      signal,
      await observed(),
    ),
  ).rejects.toThrow("applied in the main GitButler workspace");
  expect((await readGitCheckout(isolated, signal)).branch).toBe(name);
  expect((await readFile(log, "utf8")).trim()).toBe(`${main} status --json`);
});

test.each([false, true])(
  "a parked metadata head (archived=%s) cannot be renamed from a linked checkout",
  async (archived) => {
    const directory = join(main, ".git", "gitbutler");
    await mkdir(directory);
    const metadata = [
      "[branches.parked]",
      'name = ""',
      "in_workspace = false",
      "[[branches.parked.heads]]",
      `name = "${name}"`,
      `archived = ${archived}`,
      "",
    ].join("\n");
    const path = join(directory, "virtual_branches.toml");
    await writeFile(path, metadata);
    await expect(
      runGitAction(
        isolated,
        { kind: "rename", branch: name, name: "scott/unsafe-rename" },
        signal,
        await observed(),
      ),
    ).rejects.toThrow("recorded in GitButler metadata");
    expect((await readGitCheckout(isolated, signal)).branch).toBe(name);
    expect(await ref(isolated, "HEAD")).toBe(tip);
    expect(await ref(main, "HEAD")).toBe(base);
    expect(await readFile(path, "utf8")).toBe(metadata);
  },
);

test.each(["[branches", "[branches.invalid]\nheads = [7]\n", "[branches.invalid]\n"])(
  "invalid GitButler metadata blocks shared-ref writes without changing the checkout (%s)",
  async (metadata) => {
    const directory = join(main, ".git", "gitbutler");
    await mkdir(directory);
    await writeFile(join(directory, "virtual_branches.toml"), metadata);
    await expect(
      runGitAction(
        isolated,
        { kind: "delete", branch: name, accepted: null },
        signal,
        await observed(),
      ),
    ).rejects.toThrow("branch metadata is invalid");
    expect((await readGitCheckout(isolated, signal)).branch).toBe(name);
    expect(await ref(isolated, "HEAD")).toBe(tip);
    expect(await ref(main, "HEAD")).toBe(base);
  },
);

test("metadata for a different branch permits the isolated branch's own rename", async () => {
  const directory = join(main, ".git", "gitbutler");
  await mkdir(directory);
  const metadata =
    '[branches.other]\nin_workspace = false\n[[branches.other.heads]]\nname = "scott/other"\n';
  const path = join(directory, "virtual_branches.toml");
  await writeFile(path, metadata);
  expect(
    await runGitAction(
      isolated,
      { kind: "rename", branch: name, name: "scott/safe-rename" },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "done" });
  expect((await readGitCheckout(isolated, signal)).branch).toBe("scott/safe-rename");
  expect(await ref(isolated, "HEAD")).toBe(tip);
  expect(await ref(main, "HEAD")).toBe(base);
  expect(await readFile(path, "utf8")).toBe(metadata);
});

test("existing GitButler storage with missing branch metadata refuses a native write", async () => {
  await mkdir(join(main, ".git", "gitbutler"));
  await expect(
    runGitAction(
      isolated,
      { kind: "rename", branch: name, name: "scott/unsafe-rename" },
      signal,
      await observed(),
    ),
  ).rejects.toThrow("branch metadata could not be read");
  expect((await readGitCheckout(isolated, signal)).branch).toBe(name);
  expect(await ref(isolated, "HEAD")).toBe(tip);
  expect(await ref(main, "HEAD")).toBe(base);
});

test("custom GitButler metadata storage blocks native writes rather than guessing its location", async () => {
  await runGit(main, ["config", "gitbutler.storagePath", join(scratch, "custom-storage")], signal);
  await expect(
    runGitAction(
      isolated,
      { kind: "rename", branch: name, name: "scott/unsafe-rename" },
      signal,
      await observed(),
    ),
  ).rejects.toThrow("custom GitButler storage path");
  expect((await readGitCheckout(isolated, signal)).branch).toBe(name);
  expect(await ref(isolated, "HEAD")).toBe(tip);
  expect(await ref(main, "HEAD")).toBe(base);
});

test.each([false, true])(
  "a removed secondary worktree (locked=%s) does not block the surviving checkout or prune its registration",
  async (locked) => {
    const removed = join(scratch, "removed-checkout");
    await runGit(
      main,
      ["worktree", "add", "--quiet", "-b", "scott/removed", removed, base],
      signal,
    );
    const gitDir = (await runGit(removed, ["rev-parse", "--absolute-git-dir"], signal)).trim();
    if (locked)
      await runGit(main, ["worktree", "lock", "--reason", "offline device", removed], signal);
    await rm(removed, { recursive: true });
    const before = await runGit(isolated, ["worktree", "list", "--porcelain", "-z"], signal);
    expect(before).toContain(`worktree ${removed}\0`);
    expect(before).toContain(locked ? "locked offline device\0" : "prunable ");
    const snapshot = await observed();
    expect(await prepareGitCheckoutChild(isolated, "review", snapshot, signal)).toMatchObject({
      branch: name,
      head: tip,
    });
    expect(
      await runGitAction(
        isolated,
        { kind: "rename", branch: name, name: "scott/surviving" },
        signal,
        snapshot,
      ),
    ).toEqual({ status: "done" });
    expect(
      await prepareGitCheckoutChild(isolated, "conflicts", await observed(), signal),
    ).toMatchObject({
      branch: "scott/surviving",
      head: tip,
    });
    expect(await runGit(isolated, ["worktree", "list", "--porcelain", "-z"], signal)).toContain(
      `worktree ${removed}\0`,
    );
    expect(await readFile(join(gitDir, "gitdir"), "utf8")).toContain(removed);
    expect(await ref(main, "HEAD")).toBe(base);
    expect(await ref(main, "refs/heads/scott/removed")).toBe(base);
  },
);

test("metadata left in a removed worktree's admin directory still protects the surviving branch", async () => {
  const removed = join(scratch, "removed-managed-checkout");
  await runGit(main, ["worktree", "add", "--quiet", "-b", "scott/removed", removed, base], signal);
  const gitDir = (await runGit(removed, ["rev-parse", "--absolute-git-dir"], signal)).trim();
  const storage = join(gitDir, "gitbutler");
  await mkdir(storage);
  const metadata = `[branches.parked]\nin_workspace = false\n[[branches.parked.heads]]\nname = "${name}"\n`;
  await writeFile(join(storage, "virtual_branches.toml"), metadata);
  await rm(removed, { recursive: true });
  const snapshot = await observed();
  await expect(
    runGitAction(
      isolated,
      { kind: "rename", branch: name, name: "scott/unsafe-rename" },
      signal,
      snapshot,
    ),
  ).rejects.toThrow("recorded in GitButler metadata");
  await expect(prepareGitCheckoutChild(isolated, "review", snapshot, signal)).rejects.toThrow(
    "recorded in GitButler metadata",
  );
  expect(await readGitCheckout(isolated, signal)).toMatchObject({ branch: name, head: tip });
  expect(await readFile(join(storage, "virtual_branches.toml"), "utf8")).toBe(metadata);
  expect(await ref(main, "HEAD")).toBe(base);
});

test("land refuses a conflicting target without publishing or changing either checkout", async () => {
  tip = await commit(isolated, "base.txt", "isolated change\n", "feat: isolated base");
  const target = await commit(main, "base.txt", "main change\n", "feat: main base");
  await runGit(main, ["push", "--quiet", "origin", "main"], signal);
  await expect(
    runGitAction(
      isolated,
      { kind: "land", branch: name, message: "feat: combined", accepted: null },
      signal,
      await observed(),
    ),
  ).rejects.toThrow("conflicts with its target");
  expect(await ref(remote, "main")).toBe(target);
  expect(await ref(isolated, "HEAD")).toBe(tip);
  expect(await readFile(join(isolated, "base.txt"), "utf8")).toBe("isolated change\n");
});

test("selected operations reject a checkout outside the known worktree registry or without observed HEAD", async () => {
  const unregistered = join(scratch, "unregistered");
  await runGit(main, ["clone", "--quiet", remote, unregistered], signal);
  const missing = await host.experimental_call("workspace", {
    environmentPath: unregistered,
    checkout: selection(),
  });
  expect(missing.state).toBe("noRepository");
  await expect(
    host.experimental_call("butAction", {
      environmentPath: isolated,
      checkout: selection(),
      action: { kind: "rename", branch: name, name: "scott/new" },
    }),
  ).rejects.toThrow("Refresh the isolated checkout");
  expect((await readGitCheckout(isolated, signal)).branch).toBe(name);
});

test("a stale observed origin cannot publish to a different repository", async () => {
  const before = await observed();
  const other = join(scratch, "other.git");
  await runGit(main, ["init", "--quiet", "--bare", other], signal);
  await runGit(main, ["remote", "set-url", "origin", other], signal);
  await expect(
    runGitAction(
      isolated,
      { kind: "push", branch: name, force: false, acceptedLoss: [] },
      signal,
      before,
    ),
  ).rejects.toThrow("origin changed");
  expect((await runGit(other, ["for-each-ref", "--format=%(refname)"], signal)).trim()).toBe("");
  expect(await ref(isolated, "HEAD")).toBe(tip);
});

test("a failed branch deletion safely reattaches the original branch and keeps its files", async () => {
  await runGit(main, ["config", `branch.${name}.remote`, "origin"], signal);
  await runGit(main, ["config", `branch.${name}.merge`, "refs/heads/different-upstream"], signal);
  const hook = join(main, ".git", "hooks", "reference-transaction");
  await writeFile(
    hook,
    `#!/bin/sh\nif [ "$1" = prepared ]; then\n  while read old next ref; do\n    if [ "$next" = 0000000000000000000000000000000000000000 ] && [ "$ref" = refs/heads/${name} ]; then exit 1; fi\n  done\nfi\nexit 0\n`,
    { mode: 0o755 },
  );
  await expect(
    runGitAction(
      isolated,
      { kind: "delete", branch: name, accepted: null },
      signal,
      await observed(),
    ),
  ).rejects.toThrow("original branch was reattached");
  expect(await readGitCheckout(isolated, signal)).toMatchObject({ branch: name, head: tip });
  expect(await readFile(join(isolated, "first.txt"), "utf8")).toBe("first\n");
  expect(await ref(main, `refs/heads/${name}`)).toBe(tip);
  expect((await runGit(main, ["config", "--get", `branch.${name}.merge`], signal)).trim()).toBe(
    "refs/heads/different-upstream",
  );
});

test("a rejected landing publication keeps the source branch and target unchanged", async () => {
  await writeFile(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await expect(
    runGitAction(
      isolated,
      { kind: "land", branch: name, message: "feat: combined", accepted: null },
      signal,
      await observed(),
    ),
  ).rejects.toThrow("did not leave refs/heads/main");
  expect(await ref(remote, "main")).toBe(base);
  expect(await readGitCheckout(isolated, signal)).toMatchObject({ branch: name, head: tip });
});

test("a previously published identical squash is up to date and cannot publish an empty second landing", async () => {
  await runGit(main, ["merge", "--squash", name], signal);
  await runGit(main, ["commit", "--quiet", "-m", "feat: already landed"], signal);
  await runGit(main, ["push", "--quiet", "origin", "main"], signal);
  const landed = await ref(remote, "main");
  expect(
    await runGitAction(
      isolated,
      { kind: "land", branch: name, message: "feat: combined", accepted: null },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "upToDate" });
  expect(await ref(remote, "main")).toBe(landed);
  expect(await readGitCheckout(isolated, signal)).toMatchObject({ branch: name, head: tip });
});

test("actions in separate linked worktrees serialize on the shared Git directory", async () => {
  const second = join(scratch, "second-checkout");
  await runGit(main, ["worktree", "add", "--quiet", "-b", "scott/second", second, base], signal);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(scratch, "bin");
  await mkdir(bin);
  const log = join(scratch, "writes.log");
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$1 $2" = 'branch -m' ]; then\n  printf 'start %s\\n' "$PWD" >> '${log}'\n  sleep 0.1\n  '${realGit}' "$@"\n  result=$?\n  printf 'end %s\\n' "$PWD" >> '${log}'\n  exit "$result"\nfi\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const previous = process.env["PATH"];
  const firstObserved = await observed();
  const secondIdentity = await readGitCheckout(second, signal);
  process.env["PATH"] = `${bin}:${previous ?? ""}`;
  try {
    const answers = await Promise.all([
      host.experimental_call("butAction", {
        environmentPath: isolated,
        checkout: selection(),
        observed: firstObserved,
        action: { kind: "rename", branch: name, name: "scott/renamed-first" },
      }),
      host.experimental_call("butAction", {
        environmentPath: second,
        checkout: selection(),
        observed: {
          branch: secondIdentity.branch,
          head: secondIdentity.head,
          origin: secondIdentity.origin,
        },
        action: { kind: "rename", branch: "scott/second", name: "scott/renamed-second" },
      }),
    ]);
    expect(answers).toEqual([{ status: "done" }, { status: "done" }]);
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
    expect((await readGitCheckout(isolated, signal)).branch).toBe("scott/renamed-first");
    expect((await readGitCheckout(second, signal)).branch).toBe("scott/renamed-second");
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
});

test("child preflight shares branch guards and permits the actual detached rebase conflict", async () => {
  const identity = await host.experimental_call("prepareCheckoutChild", {
    environmentPath: isolated,
    checkout: selection(),
    kind: "review",
    observed: await observed(),
  });
  expect(identity).toMatchObject({ kind: "git", branch: name, head: tip });
  tip = await commit(isolated, "base.txt", "isolated\n", "feat: isolated base");
  await commit(main, "base.txt", "target\n", "feat: target base");
  await runGit(main, ["push", "--quiet", "origin", "main"], signal);
  await expect(
    runGitAction(
      isolated,
      { kind: "updateWorkspace", accepted: { conflicted: [name], overlapsUncommitted: false } },
      signal,
      await observed(),
    ),
  ).rejects.toThrow();
  const board = await workspace();
  expect(board.conflictedFiles).toEqual(["base.txt"]);
  expect(board.checkoutIdentity?.branch).toBeNull();
  const conflicted = board.checkoutIdentity!;
  const snapshot = { branch: conflicted.branch, head: conflicted.head, origin: conflicted.origin };
  expect(
    await host.experimental_call("prepareCheckoutChild", {
      environmentPath: isolated,
      checkout: selection(),
      kind: "conflicts",
      observed: snapshot,
    }),
  ).toEqual(conflicted);
  await expect(
    host.experimental_call("prepareCheckoutChild", {
      environmentPath: isolated,
      checkout: selection(),
      kind: "review",
      observed: snapshot,
    }),
  ).rejects.toThrow("named branch");
  await runGit(main, ["switch", "--quiet", "-c", "gitbutler/workspace"], signal);
  restore = await fakeBut(
    `printf '%s\\n' '{"stacks":[{"branches":[{"name":"${name}","commits":[]}]}]}'`,
  );
  await expect(
    host.experimental_call("prepareCheckoutChild", {
      environmentPath: isolated,
      checkout: selection(),
      kind: "conflicts",
      observed: snapshot,
    }),
  ).rejects.toThrow("applied in the main GitButler workspace");
});

test("Node closes Git stdin while reading an unborn checkout's patches", async () => {
  const unborn = join(scratch, "node-unborn");
  await mkdir(unborn);
  await runGit(unborn, ["init", "--quiet", "--initial-branch=fresh", "."], signal);
  await writeFile(join(unborn, "new.txt"), "Node native diff\n");
  const module = new URL("./git-workspace.ts", import.meta.url).href;
  const script = `import { readGitPatches } from ${JSON.stringify(module)}; const value = await readGitPatches(${JSON.stringify(unborn)}, {kind:'uncommitted'}, new AbortController().signal); process.stdout.write(JSON.stringify(value));`;
  const output = execFileSync("node", ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: join(import.meta.dirname, "../.."),
    encoding: "utf8",
    timeout: 10_000,
  });
  const patches: unknown = JSON.parse(output);
  expect(patches).toMatchObject({
    files: [
      { path: "new.txt", kind: "added", patch: expect.stringContaining("+Node native diff") },
    ],
    truncated: false,
  });
});

test("a configured differently named upstream remains the push destination before its ref is fetched", async () => {
  await runGit(main, ["config", `branch.${name}.remote`, "origin"], signal);
  await runGit(main, ["config", `branch.${name}.merge`, "refs/heads/review-feature"], signal);
  expect((await workspace()).stacks[0]?.branches[0]?.status).toBe("unpushed");
  expect(
    await runGitAction(
      isolated,
      { kind: "push", branch: name, force: false, acceptedLoss: [] },
      signal,
      await observed(),
    ),
  ).toEqual({ status: "done" });
  expect(await ref(remote, "review-feature")).toBe(tip);
  expect(
    (
      await runGit(remote, ["for-each-ref", "--format=%(refname)", `refs/heads/${name}`], signal)
    ).trim(),
  ).toBe("");
});
