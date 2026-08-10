import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  activeAutoStashOwners,
  checkoutWithAutoStash,
  stashCountsByBranch,
  type CommandResult,
  type SmartCheckoutDependencies,
} from "../lib/smart-checkout.ts";

function git(cwd: string, args: string[]): CommandResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    failedToSpawn: Boolean(result.error),
    timedOut: false,
  };
}

function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  assert.equal(result.code, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function currentBranch(cwd: string): string | null {
  const result = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() : null;
}

function dependencies(
  cwd: string,
  checkout: (branch: string) => Promise<CommandResult> = async (branch) =>
    git(cwd, ["checkout", branch]),
): SmartCheckoutDependencies {
  return {
    runGit: async (args) => git(cwd, args),
    checkout,
    currentBranch: async () => currentBranch(cwd),
    transactionId: () => "test-transaction",
    blockedStashOids: new Set<string>(),
  };
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "gh-stack-smart-checkout-"));
  gitOk(cwd, ["init", "-b", "source"]);
  gitOk(cwd, ["config", "user.name", "Smart Checkout Test"]);
  gitOk(cwd, ["config", "user.email", "smart-checkout@example.com"]);
  writeFileSync(join(cwd, "shared.txt"), "source\n");
  writeFileSync(join(cwd, "carry.txt"), "base\n");
  writeFileSync(join(cwd, "manual.txt"), "base\n");
  gitOk(cwd, ["add", "."]);
  gitOk(cwd, ["commit", "-m", "test: source"]);
  gitOk(cwd, ["checkout", "-b", "target"]);
  writeFileSync(join(cwd, "shared.txt"), "target\n");
  gitOk(cwd, ["add", "shared.txt"]);
  gitOk(cwd, ["commit", "-m", "test: target"]);
  gitOk(cwd, ["checkout", "source"]);
  return cwd;
}

function stashSubjects(cwd: string): string {
  return git(cwd, ["stash", "list", "--format=%gs"]).stdout;
}

function handledStashes(cwd: string): string {
  return git(cwd, [
    "for-each-ref",
    "--format=%(objectname)",
    "refs/bb-gh-stack/stash-state/",
  ]).stdout;
}

test("clean and non-conflicting dirty checkouts do not create stashes", async () => {
  const cwd = repository();
  try {
    const clean = await checkoutWithAutoStash("target", dependencies(cwd));
    assert.equal(clean.ok, true);
    assert.equal(currentBranch(cwd), "target");
    assert.equal(stashSubjects(cwd), "");

    gitOk(cwd, ["checkout", "source"]);
    writeFileSync(join(cwd, "carry.txt"), "carried edit\n");
    const dirty = await checkoutWithAutoStash("target", dependencies(cwd));
    assert.equal(dirty.ok, true);
    assert.equal(currentBranch(cwd), "target");
    assert.equal(readFileSync(join(cwd, "carry.txt"), "utf8"), "carried edit\n");
    assert.equal(stashSubjects(cwd), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("conflicting tracked edits are auto-stashed and restored on their owner branch", async () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, "manual.txt"), "handmade\n");
    gitOk(cwd, ["stash", "push", "-m", "handmade stash"]);
    writeFileSync(join(cwd, "shared.txt"), "staged source work\n");
    gitOk(cwd, ["add", "shared.txt"]);
    writeFileSync(join(cwd, "shared.txt"), "unstaged source work\n");
    writeFileSync(join(cwd, "untracked-note.txt"), "never stash me\n");

    const deps = dependencies(cwd);
    const away = await checkoutWithAutoStash("target", deps);
    assert.equal(away.ok, true, away.message);
    assert.equal(currentBranch(cwd), "target");
    assert.equal(readFileSync(join(cwd, "shared.txt"), "utf8"), "target\n");
    assert.equal(readFileSync(join(cwd, "untracked-note.txt"), "utf8"), "never stash me\n");
    assert.match(stashSubjects(cwd), /bb-gh-stack:auto-stash:v1:/);
    assert.match(stashSubjects(cwd), /handmade stash/);
    assert.deepEqual(await activeAutoStashOwners(deps), new Set(["source"]));

    // A handmade stash pushed above the plugin stash must also remain intact.
    writeFileSync(join(cwd, "carry.txt"), "second handmade stash\n");
    gitOk(cwd, ["stash", "push", "-m", "handmade stash above"]);

    const back = await checkoutWithAutoStash("source", deps);
    assert.equal(back.ok, true, back.message);
    assert.equal(currentBranch(cwd), "source");
    assert.equal(
      readFileSync(join(cwd, "shared.txt"), "utf8"),
      "unstaged source work\n",
    );
    assert.match(git(cwd, ["diff", "--cached", "--name-only"]).stdout, /shared\.txt/);
    assert.match(git(cwd, ["diff", "--name-only"]).stdout, /shared\.txt/);
    assert.equal(readFileSync(join(cwd, "untracked-note.txt"), "utf8"), "never stash me\n");
    assert.match(stashSubjects(cwd), /bb-gh-stack:auto-stash:v1:/);
    assert.match(stashSubjects(cwd), /handmade stash/);
    assert.match(stashSubjects(cwd), /handmade stash above/);
    assert.match(handledStashes(cwd), /^[0-9a-f]{40,64}$/m);
    assert.deepEqual(await activeAutoStashOwners(deps), new Set());
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an untracked checkout blocker is never stashed", async () => {
  const cwd = repository();
  try {
    gitOk(cwd, ["checkout", "target"]);
    writeFileSync(join(cwd, "blocked.txt"), "tracked on target\n");
    gitOk(cwd, ["add", "blocked.txt"]);
    gitOk(cwd, ["commit", "-m", "test: add blocker"]);
    gitOk(cwd, ["checkout", "source"]);
    writeFileSync(join(cwd, "blocked.txt"), "untracked on source\n");

    const outcome = await checkoutWithAutoStash("target", dependencies(cwd));
    assert.equal(outcome.ok, false);
    assert.equal(currentBranch(cwd), "source");
    assert.equal(readFileSync(join(cwd, "blocked.txt"), "utf8"), "untracked on source\n");
    assert.equal(stashSubjects(cwd), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a failed retry restores the exact plugin stash and leaves handmade stashes alone", async () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, "manual.txt"), "handmade\n");
    gitOk(cwd, ["stash", "push", "-m", "handmade stash"]);
    writeFileSync(join(cwd, "shared.txt"), "source work\n");
    let targetAttempts = 0;
    const deps = dependencies(cwd, async (branch) => {
      if (branch === "target" && ++targetAttempts === 2) {
        return {
          code: 1,
          stdout: "",
          stderr: "simulated retry failure\n",
          failedToSpawn: false,
          timedOut: false,
        };
      }
      return git(cwd, ["checkout", branch]);
    });

    const outcome = await checkoutWithAutoStash("target", deps);
    assert.equal(outcome.ok, false);
    assert.equal(currentBranch(cwd), "source");
    assert.equal(readFileSync(join(cwd, "shared.txt"), "utf8"), "source work\n");
    assert.match(stashSubjects(cwd), /bb-gh-stack:auto-stash:v1:/);
    assert.match(stashSubjects(cwd), /handmade stash/);
    assert.match(handledStashes(cwd), /^[0-9a-f]{40,64}$/m);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a restore conflict preserves the stash and records durable recovery state", async () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, "shared.txt"), "stashed source work\n");
    const deps = dependencies(cwd);
    const away = await checkoutWithAutoStash("target", deps);
    assert.equal(away.ok, true, away.message);

    // Bypass the plugin once to change the stash owner's base, then return
    // through smart checkout so applying the old patch conflicts.
    gitOk(cwd, ["checkout", "source"]);
    writeFileSync(join(cwd, "shared.txt"), "new source commit\n");
    gitOk(cwd, ["add", "shared.txt"]);
    gitOk(cwd, ["commit", "-m", "test: move source"]);
    gitOk(cwd, ["checkout", "target"]);

    const back = await checkoutWithAutoStash("source", deps);
    assert.equal(back.ok, false);
    assert.equal(currentBranch(cwd), "source");
    assert.match(git(cwd, ["status", "--short"]).stdout, /^UU shared\.txt$/m);
    assert.match(stashSubjects(cwd), /bb-gh-stack:auto-stash:v1:/);
    assert.match(handledStashes(cwd), /^[0-9a-f]{40,64}$/m);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stash counts group every entry by the branch it was made on", async () => {
  const cwd = repository();
  try {
    const deps = dependencies(cwd);
    assert.deepEqual(await stashCountsByBranch(deps), new Map());

    // Two on `source`, one made by hand and one by the plugin's own path.
    writeFileSync(join(cwd, "manual.txt"), "hand edit\n");
    gitOk(cwd, ["stash", "push", "-m", "by hand"]);
    writeFileSync(join(cwd, "carry.txt"), "second edit\n");
    gitOk(cwd, ["stash", "push"]);

    gitOk(cwd, ["checkout", "target"]);
    writeFileSync(join(cwd, "manual.txt"), "target edit\n");
    gitOk(cwd, ["stash", "push", "-m", "on target"]);

    assert.deepEqual(
      await stashCountsByBranch(deps),
      new Map([
        ["source", 2],
        ["target", 1],
      ]),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The owner is read from Git's own "On <branch>:" prefix, so a branch name
// inside a hand-written message must not be counted as an owner.
test("stash counts read the branch prefix, not the message body", async () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, "manual.txt"), "hand edit\n");
    gitOk(cwd, ["stash", "push", "-m", "On target: notes about target"]);
    assert.deepEqual(
      await stashCountsByBranch(dependencies(cwd)),
      new Map([["source", 1]]),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an unreadable stash list reports unknown rather than zero", async () => {
  const counts = await stashCountsByBranch({
    runGit: async () => ({
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
      failedToSpawn: false,
      timedOut: false,
    }),
  });
  assert.equal(counts, null);
});
