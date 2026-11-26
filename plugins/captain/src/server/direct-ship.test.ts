import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Clean environment for git subprocesses: strip any inherited GIT_* hook vars and isolate global config. */
function cleanGitEnv(globalConfig: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env["GIT_CONFIG_GLOBAL"] = globalConfig;
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_TERMINAL_PROMPT"] = "0";
  return { ...env, ...extra };
}

type RunResult = { status: number; stdout: string; stderr: string };

function runGit(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; allowFailure?: boolean },
): RunResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    if (options.allowFailure) {
      return {
        status: err.status ?? 1,
        stdout: String(err.stdout ?? "").trim(),
        stderr: String(err.stderr ?? "").trim(),
      };
    }
    throw new Error(
      `git ${args.join(" ")} failed (exit ${err.status ?? "?"}): ${String(err.stderr ?? "")}`,
      { cause: error },
    );
  }
}

/** Exact second-field match for `git ls-remote origin refs/heads/<name>`. */
function exactLsRemote(
  cloneDir: string,
  ref: string,
  env: NodeJS.ProcessEnv,
): { rawLines: string[]; matched: string[] } {
  const { stdout } = runGit(
    [
      "--no-replace-objects",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      cloneDir,
      "ls-remote",
      "origin",
      ref,
    ],
    { env },
  );
  const rawLines = stdout === "" ? [] : stdout.split("\n");
  const matched = rawLines
    .map((line) => line.split(/\s+/u))
    .filter((parts) => parts[1] === ref)
    .map((parts) => parts[0] ?? "");
  return { rawLines, matched };
}

/** Compute `<checkout>`'s tree against the fresh bare clone `<cloneDir>` using a seeded temp index. */
function proveCheckoutTree(
  cloneDir: string,
  checkoutDir: string,
  sha: string,
  scratchRoot: string,
  env: NodeJS.ProcessEnv,
): { actualTree: string; expectedTree: string; match: boolean } {
  const indexFile = join(scratchRoot, `proof-${Math.random().toString(36).slice(2)}.idx`);
  const elsewhere = join(scratchRoot, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const indexEnv = { ...env, GIT_INDEX_FILE: indexFile };
  try {
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        `--git-dir=${cloneDir}`,
        "read-tree",
        sha,
      ],
      { cwd: elsewhere, env: indexEnv },
    );
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        `--git-dir=${cloneDir}`,
        `--work-tree=${checkoutDir}`,
        "add",
        "-A",
        "--",
        ":/",
      ],
      { cwd: elsewhere, env: indexEnv },
    );
    const actualTree = runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        `--git-dir=${cloneDir}`,
        "write-tree",
      ],
      { cwd: elsewhere, env: indexEnv },
    ).stdout;
    const expectedTree = runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        `--git-dir=${cloneDir}`,
        "rev-parse",
        `${sha}^{tree}`,
      ],
      { cwd: elsewhere, env },
    ).stdout;
    return { actualTree, expectedTree, match: actualTree === expectedTree };
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** Create a bare `origin` (with partial-clone filtering enabled) and a `crew` clone with one base commit on `main`. */
function setupScratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "captain-direct-ship-"));
  roots.push(root);
  const globalConfig = join(root, "global.gitconfig");
  writeFileSync(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  const env = cleanGitEnv(globalConfig);

  const originDir = join(root, "origin.git");
  const originUrl = `file://${originDir}`;
  const crewDir = join(root, "crew");

  runGit(["init", "--bare", "-b", "main", originDir], { env });
  runGit(["--git-dir", originDir, "config", "uploadpack.allowFilter", "true"], { env });
  runGit(["clone", originUrl, crewDir], { env });

  writeFileSync(join(crewDir, "README.md"), "base\n");
  writeFileSync(join(crewDir, ".gitignore"), "ignored.log\nbuild/\n");
  writeFileSync(join(crewDir, "ignored.log"), "tracked-ignored-initial\n");
  runGit(["add", "-f", "README.md", ".gitignore", "ignored.log"], { cwd: crewDir, env });
  runGit(["commit", "-m", "base"], { cwd: crewDir, env });
  runGit(["push", "-u", "origin", "main"], { cwd: crewDir, env });
  const base = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;

  return { root, globalConfig, env, originDir, originUrl, crewDir, base };
}

describe("direct-ship fresh bare blobless clone checks (BBP-102)", () => {
  test("clone forms: --bare --filter=blob:none and --bare exclude refs/replace while --mirror imports it", () => {
    const { root, env, originDir, originUrl, crewDir, base } = setupScratchRepo();

    // Commit C on crew + EVIL commit, then plant refs/replace/<C> directly on origin.
    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "feature.ts"), "export const ok = 1;\n");
    runGit(["add", "feature.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: feature"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    runGit(["checkout", "-b", "evil-branch", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "backdoor.ts"), "export const evil = true;\n");
    runGit(["add", "backdoor.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: feature"], { cwd: crewDir, env });
    const evil = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "origin", `${evil}:refs/replace/${sha}`], { cwd: crewDir, env });
    expect(
      runGit(["--git-dir", originDir, "for-each-ref", "refs/replace"], { env }).stdout,
    ).toContain(`refs/replace/${sha}`);

    const bloblessDir = join(root, "blobless.git");
    const bareDir = join(root, "bare.git");
    const mirrorDir = join(root, "mirror.git");

    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--bare",
        "--filter=blob:none",
        originUrl,
        bloblessDir,
      ],
      { env },
    );
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--bare",
        originUrl,
        bareDir,
      ],
      { env },
    );
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--mirror",
        originUrl,
        mirrorDir,
      ],
      { env },
    );

    // Confirm blobless clone actually omitted blobs from the pack.
    const missingBlobs = runGit(
      ["--git-dir", bloblessDir, "rev-list", "--objects", "--all", "--missing=print"],
      { env },
    )
      .stdout.split("\n")
      .filter((line) => line.startsWith("?"));
    expect(missingBlobs.length).toBeGreaterThan(0);

    for (const dir of [bloblessDir, bareDir]) {
      expect(runGit(["-C", dir, "for-each-ref", "refs/replace"], { env }).stdout).toBe("");
      expect(
        runGit(["-C", dir, "config", "--get-all", "remote.origin.fetch"], {
          env,
          allowFailure: true,
        }).stdout,
      ).toBe("");
      expect(runGit(["-C", dir, "rev-parse", "--is-shallow-repository"], { env }).stdout).toBe(
        "false",
      );
    }

    // --mirror imports refs/replace/* from origin, which is why the skill forbids it.
    expect(runGit(["-C", mirrorDir, "for-each-ref", "refs/replace"], { env }).stdout).toContain(
      `refs/replace/${sha}`,
    );
  });

  test("H1 end-to-end: rewritten fetch refspec + annotated tag replace ref is defeated and origin/main lands <sha>", () => {
    const { root, env, originDir, originUrl, crewDir, base } = setupScratchRepo();

    // Crew pushes honest commit C on `crew`.
    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "feature.ts"), "export const ok = 1;\n");
    runGit(["add", "feature.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: add feature"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Crew builds EVIL on top of main and pushes an annotated tag `rep/<sha>` pointing at EVIL.
    runGit(["checkout", "-b", "evil-work", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "backdoor.ts"), "export const pwn = true;\n");
    runGit(["add", "backdoor.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "evil commit"], { cwd: crewDir, env });
    const evil = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["tag", "-a", `rep/${sha}`, "-m", "hide", evil], { cwd: crewDir, env });
    runGit(["push", "origin", `refs/tags/rep/${sha}`], { cwd: crewDir, env });
    runGit(["tag", "-d", `rep/${sha}`], { cwd: crewDir, env });
    runGit(["checkout", "crew"], { cwd: crewDir, env });
    runGit(["branch", "-D", "evil-work"], { cwd: crewDir, env });

    // Crew plants the extra fetch refspec in the shared repo config.
    runGit(["config", "--add", "remote.origin.fetch", "+refs/tags/rep/*:refs/replace/*"], {
      cwd: crewDir,
      env,
    });
    // Confirm the crew repo's fetch would plant refs/replace/<sha> and resolve <sha>^{commit} to EVIL.
    runGit(["fetch", "origin"], { cwd: crewDir, env });
    expect(runGit(["rev-parse", `${sha}^{commit}`], { cwd: crewDir, env }).stdout).toBe(evil);

    // Run the new fresh-clone direct-ship procedure end to end.
    const tmpClone = join(root, "fresh-h1.git");
    const gitFresh = (args: string[], allowFailure = false) =>
      runGit(["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-C", tmpClone, ...args], {
        env,
        allowFailure,
      });

    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--bare",
        "--filter=blob:none",
        originUrl,
        tmpClone,
      ],
      { env },
    );
    expect(gitFresh(["remote", "get-url", "--push", "--all", "origin"]).stdout).toBe(originUrl);

    // Check 1: refs/heads/main matches exact ls-remote.
    const mainRef = gitFresh(["rev-parse", "--verify", "refs/heads/main"]).stdout;
    const preTarget = exactLsRemote(tmpClone, "refs/heads/main", env);
    expect(preTarget.matched).toEqual([mainRef]);

    // Check 2: not already landed (exit 1).
    expect(gitFresh(["merge-base", "--is-ancestor", sha, "refs/heads/main"], true).status).toBe(1);

    // Check 3: crew branch matches exact ls-remote and equals <sha>.
    expect(gitFresh(["rev-parse", "--verify", "refs/heads/crew"]).stdout).toBe(sha);
    expect(exactLsRemote(tmpClone, "refs/heads/crew", env).matched).toEqual([sha]);

    // Check 4: fast-forward (exit 0).
    expect(gitFresh(["merge-base", "--is-ancestor", "refs/heads/main", sha], true).status).toBe(0);

    // Check 5: commit list holds only the task commit.
    const logLines = gitFresh(["log", "--oneline", `refs/heads/main..${sha}`]).stdout.split("\n");
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("task: add feature");

    // Push from the fresh blobless clone.
    gitFresh(["push", "origin", `${sha}^{commit}:refs/heads/main`]);

    // Post-push step 5: explicit refspec fetch + exact ls-remote + ancestry check.
    gitFresh(["fetch", "origin", "+refs/heads/main:refs/heads/main"]);
    const postMain = gitFresh(["rev-parse", "--verify", "refs/heads/main"]).stdout;
    expect(exactLsRemote(tmpClone, "refs/heads/main", env).matched).toEqual([postMain]);
    expect(gitFresh(["merge-base", "--is-ancestor", sha, "refs/heads/main"], true).status).toBe(0);

    // Origin's main landed <sha>, not EVIL.
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );
    expect(sha).not.toBe(evil);
  });

  test("pushing <sha>^{commit} defeats a remote branch literally named <sha> pointing at EVIL", () => {
    const { root, env, originDir, originUrl, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "ok.txt"), "ok\n");
    runGit(["add", "ok.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: ok"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Plant a branch on origin literally named `<sha>` pointing at EVIL.
    writeFileSync(join(crewDir, "evil.txt"), "evil\n");
    runGit(["add", "evil.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "evil"], { cwd: crewDir, env });
    const evil = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "origin", `${evil}:refs/heads/${sha}`], { cwd: crewDir, env });

    const tmpClone = join(root, "fresh-named-sha.git");
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--bare",
        "--filter=blob:none",
        originUrl,
        tmpClone,
      ],
      { env },
    );

    // Control: bare `<sha>:refs/heads/main` would match refs/heads/<sha> and push EVIL.
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        tmpClone,
        "push",
        "origin",
        `${sha}:refs/heads/main`,
      ],
      { env },
    );
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      evil,
    );

    // Reset origin/main to base and push with `<sha>^{commit}:refs/heads/main`: lands <sha>, not EVIL.
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        tmpClone,
        "push",
        "origin",
        `${sha}^{commit}:refs/heads/main`,
      ],
      { env },
    );
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );
  });

  test("M1: shallow boundary hiding a side-branch commit in crew repo is defeated in fresh clone", () => {
    const { root, env, originUrl, crewDir, base } = setupScratchRepo();

    // Build M = merge(C1, side E1 -> E2) on crew and push.
    runGit(["checkout", "-b", "side", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "e1.txt"), "hidden\n");
    runGit(["add", "e1.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "E1 hidden"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "e2.txt"), "e2\n");
    runGit(["add", "e2.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "E2 tip"], { cwd: crewDir, env });
    const e2 = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;

    runGit(["checkout", "-b", "crew", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "c1.txt"), "c1\n");
    runGit(["add", "c1.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "C1 task"], { cwd: crewDir, env });
    runGit(["merge", "--no-ff", "side", "-m", "M merge"], { cwd: crewDir, env });
    const mergeSha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Plant `<common-dir>/shallow` naming E2 in crew repo: hides E1 there.
    const shallowPath = runGit(["rev-parse", "--git-path", "shallow"], {
      cwd: crewDir,
      env,
    }).stdout;
    writeFileSync(join(crewDir, shallowPath), `${e2}\n`);
    const crewLog = runGit(["log", "--format=%s", `refs/remotes/origin/main..${mergeSha}`], {
      cwd: crewDir,
      env,
    }).stdout.split("\n");
    expect(crewLog).not.toContain("E1 hidden");
    expect(crewLog).toHaveLength(3);

    // Fresh bare blobless clone has no shallow file and reveals all 4 commits including E1.
    const tmpClone = join(root, "fresh-m1.git");
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--bare",
        "--filter=blob:none",
        originUrl,
        tmpClone,
      ],
      { env },
    );
    const freshLog = runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        tmpClone,
        "log",
        "--format=%s",
        `refs/heads/main..${mergeSha}`,
      ],
      { env },
    ).stdout.split("\n");
    expect(freshLog).toEqual(expect.arrayContaining(["M merge", "C1 task", "E2 tip", "E1 hidden"]));
    expect(freshLog).toHaveLength(4);
  });

  test("M3: exact ls-remote matching defeats a spoofed a/refs/heads/main branch before and after push", () => {
    const { root, env, originUrl, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "work.txt"), "work\n");
    runGit(["add", "work.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: work"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Push decoy branch `a/refs/heads/main` whose suffix matches `refs/heads/main`.
    runGit(["push", "origin", `${sha}:refs/heads/a/refs/heads/main`], { cwd: crewDir, env });

    const tmpClone = join(root, "fresh-m3.git");
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--bare",
        "--filter=blob:none",
        originUrl,
        tmpClone,
      ],
      { env },
    );

    // Pre-push: unfiltered ls-remote returns 2 lines; exact match returns 1 line (base).
    const pre = exactLsRemote(tmpClone, "refs/heads/main", env);
    expect(pre.rawLines).toHaveLength(2);
    expect(pre.matched).toEqual([base]);

    // Push `<sha>` to main, re-fetch with explicit refspec, verify post-push exact match.
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        tmpClone,
        "push",
        "origin",
        `${sha}^{commit}:refs/heads/main`,
      ],
      { env },
    );
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        tmpClone,
        "fetch",
        "origin",
        "+refs/heads/main:refs/heads/main",
      ],
      { env },
    );
    const post = exactLsRemote(tmpClone, "refs/heads/main", env);
    expect(post.rawLines).toHaveLength(2);
    expect(post.matched).toEqual([sha]);
    expect(
      runGit(
        [
          "--no-replace-objects",
          "-c",
          "core.hooksPath=/dev/null",
          "-C",
          tmpClone,
          "rev-parse",
          "--verify",
          "refs/heads/main",
        ],
        { env },
      ).stdout,
    ).toBe(sha);
  });

  test("M2 hooks: -c core.hooksPath=/dev/null blocks all client-side hooks on clone and push while control runs them", () => {
    const { root, globalConfig, env, originDir, originUrl, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "a.txt"), "a\n");
    runGit(["add", "a.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: a"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Configure global core.hooksPath with logging hooks.
    const hooksDir = join(root, "hooks");
    const hookLog = join(root, "hooks.log");
    mkdirSync(hooksDir);
    for (const name of [
      "pre-push",
      "post-checkout",
      "post-index-change",
      "reference-transaction",
    ]) {
      const hookPath = join(hooksDir, name);
      writeFileSync(hookPath, `#!/bin/sh\necho "${name}:$PWD" >> "${hookLog}"\n`, {
        encoding: "utf8",
      });
      chmodSync(hookPath, 0o755);
    }
    writeFileSync(
      globalConfig,
      `[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\thooksPath = ${hooksDir}\n`,
    );

    const safeBare = join(root, "safe-bare.git");
    const safeWork = join(root, "safe-work");
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--bare",
        "--filter=blob:none",
        originUrl,
        safeBare,
      ],
      { env },
    );
    runGit(
      ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "clone", originUrl, safeWork],
      { env },
    );
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        safeBare,
        "push",
        "origin",
        `${sha}^{commit}:refs/heads/main`,
      ],
      { env },
    );

    // Filter out origin's own local receive-pack lines (which only exist for file:// local transport).
    const readClientLogs = () =>
      existsSync(hookLog)
        ? readFileSync(hookLog, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line !== "" && !line.endsWith(`:${originDir}`))
        : [];
    expect(readClientLogs()).toEqual([]);

    // Control without -c core.hooksPath=/dev/null: hooks fire on clone and push.
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });
    const unsafeWork = join(root, "unsafe-work");
    runGit(["clone", originUrl, unsafeWork], { env });
    runGit(["-C", safeBare, "push", "origin", `${sha}^{commit}:refs/heads/main`], { env });
    const fired = readClientLogs();
    expect(fired.some((line) => line.startsWith("post-checkout:"))).toBe(true);
    expect(fired.some((line) => line.startsWith("reference-transaction:"))).toBe(true);
    expect(fired.some((line) => line.startsWith("pre-push:"))).toBe(true);
  });

  test("L5 & M2 transport: fresh clone from verified URL ignores crew repo includeIf pushurl and transport config, and catches global pushInsteadOf", () => {
    const { root, globalConfig, env, originDir, originUrl, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "item.txt"), "item\n");
    runGit(["add", "item.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: item"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Create an evil bare repo that worktree-scoped includeIf redirects pushurl to.
    const evilOriginDir = join(root, "evil-origin.git");
    runGit(["init", "--bare", "-b", "main", evilOriginDir], { env });
    const includeFile = join(root, "worktree-override.gitconfig");
    writeFileSync(includeFile, `[remote "origin"]\n\tpushurl = file://${evilOriginDir}\n`);

    // Poison crew repo's config with L5 includeIf + M2 repo-local transport overrides.
    runGit(["config", "includeIf.gitdir:**/worktrees/**.path", includeFile], { cwd: crewDir, env });
    runGit(["config", "core.sshCommand", "sh -c 'exit 99'"], { cwd: crewDir, env });
    runGit(["config", "credential.helper", "!sh -c 'exit 99'"], { cwd: crewDir, env });
    runGit(["config", "http.proxy", "http://127.0.0.1:1"], { cwd: crewDir, env });

    // Confirm a linked worktree under `worktrees/` actually inherits the poisoned pushurl & transport keys.
    const worktreesParent = join(root, "worktrees");
    mkdirSync(worktreesParent);
    const linkedWt = join(worktreesParent, "ship-wt");
    runGit(["worktree", "add", "--detach", linkedWt, sha], { cwd: crewDir, env });
    expect(
      runGit(["-C", linkedWt, "remote", "get-url", "--push", "--all", "origin"], { env }).stdout,
    ).toBe(`file://${evilOriginDir}`);
    expect(
      runGit(["-C", linkedWt, "config", "--get", "core.sshCommand"], { env }).stdout,
    ).toContain("exit 99");

    // Fresh bare blobless clone built from the verified URL ignores every repo-local override.
    const tmpClone = join(root, "fresh-l5.git");
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--bare",
        "--filter=blob:none",
        originUrl,
        tmpClone,
      ],
      { env },
    );
    expect(
      runGit(
        [
          "--no-replace-objects",
          "-c",
          "core.hooksPath=/dev/null",
          "-C",
          tmpClone,
          "remote",
          "get-url",
          "--push",
          "--all",
          "origin",
        ],
        { env },
      ).stdout,
    ).toBe(originUrl);
    for (const key of ["core.sshCommand", "credential.helper", "http.proxy"]) {
      expect(
        runGit(["-C", tmpClone, "config", "--get", key], { env, allowFailure: true }).status,
      ).not.toBe(0);
    }

    // Push lands on the real origin; evil origin stays empty.
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        tmpClone,
        "push",
        "origin",
        `${sha}^{commit}:refs/heads/main`,
      ],
      { env },
    );
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );
    expect(
      runGit(["--git-dir", evilOriginDir, "rev-parse", "--verify", "refs/heads/main"], {
        env,
        allowFailure: true,
      }).status,
    ).not.toBe(0);

    // Global insteadOf / pushInsteadOf is caught by checking get-url --push --all against verified URL.
    writeFileSync(
      globalConfig,
      `[user]\n\tname = Test\n\temail = test@example.com\n[url "file://${evilOriginDir}"]\n\tpushInsteadOf = ${originUrl}\n`,
    );
    const rewrittenPushUrl = runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        tmpClone,
        "remote",
        "get-url",
        "--push",
        "--all",
        "origin",
      ],
      { env },
    ).stdout;
    expect(rewrittenPushUrl).toBe(`file://${evilOriginDir}`);
    expect(rewrittenPushUrl).not.toBe(originUrl);
    expect(base).not.toBe(sha);
  });

  test("tree proof against fresh clone catches tag/commit replace EVIL checkouts, tampered tracked-ignored and deleted files, and matches honest checkouts with ignored files", () => {
    const { root, env, originUrl, crewDir, base } = setupScratchRepo();

    // Commit honest C and EVIL on crew repo.
    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "app.ts"), "export const v = 1;\n");
    runGit(["add", "app.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: honest"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    runGit(["checkout", "-b", "evil-branch", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "app.ts"), "export const v = 666;\n");
    runGit(["add", "app.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: honest"], { cwd: crewDir, env });
    const evil = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["tag", "-a", "evil-tag", "-m", "evil", evil], { cwd: crewDir, env });
    const evilTagOid = runGit(["rev-parse", "refs/tags/evil-tag"], { cwd: crewDir, env }).stdout;

    // Fresh bare blobless clone of origin (clean reference for tree proof).
    const tmpClone = join(root, "fresh-proof.git");
    runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--bare",
        "--filter=blob:none",
        originUrl,
        tmpClone,
      ],
      { env },
    );

    // 1. Tag-type replace EVIL checkout: status --porcelain in crew repo is empty, fresh-clone proof catches it.
    runGit(["update-ref", `refs/replace/${sha}`, evilTagOid], { cwd: crewDir, env });
    const wtTagEvil = join(root, "wt-tag-evil");
    runGit(["worktree", "add", "--detach", wtTagEvil, sha], { cwd: crewDir, env });
    expect(
      runGit(["--no-replace-objects", "-C", wtTagEvil, "status", "--porcelain"], { env }).stdout,
    ).toBe("");
    expect(proveCheckoutTree(tmpClone, wtTagEvil, sha, root, env).match).toBe(false);

    // 2. Commit-type replace EVIL checkout: rev-parse HEAD prints <sha> even with --no-replace-objects, fresh-clone proof catches it.
    runGit(["update-ref", `refs/replace/${sha}`, evil], { cwd: crewDir, env });
    const wtCommitEvil = join(root, "wt-commit-evil");
    runGit(["worktree", "add", "--detach", wtCommitEvil, sha], { cwd: crewDir, env });
    expect(
      runGit(["--no-replace-objects", "-C", wtCommitEvil, "rev-parse", "HEAD"], { env }).stdout,
    ).toBe(sha);
    expect(readFileSync(join(wtCommitEvil, "app.ts"), "utf8")).toContain("666");
    expect(proveCheckoutTree(tmpClone, wtCommitEvil, sha, root, env).match).toBe(false);

    // Remove replace ref and create an honest detached checkout.
    runGit(["update-ref", "-d", `refs/replace/${sha}`], { cwd: crewDir, env });
    const wtHonest = join(root, "wt-honest");
    runGit(["worktree", "add", "--detach", wtHonest, sha], { cwd: crewDir, env });

    // 3. Honest checkout with untracked ignored files (e.g. build output) -> MATCH.
    mkdirSync(join(wtHonest, "build"), { recursive: true });
    writeFileSync(join(wtHonest, "build", "bundle.js"), "ignored build artifact\n");
    expect(proveCheckoutTree(tmpClone, wtHonest, sha, root, env).match).toBe(true);

    // 4. Tampered tracked-but-ignored file (`ignored.log`) -> MISMATCH (seeded index catches it).
    writeFileSync(join(wtHonest, "ignored.log"), "tampered!\n");
    expect(proveCheckoutTree(tmpClone, wtHonest, sha, root, env).match).toBe(false);
    writeFileSync(join(wtHonest, "ignored.log"), "tracked-ignored-initial\n");
    expect(proveCheckoutTree(tmpClone, wtHonest, sha, root, env).match).toBe(true);

    // 5. Deleted tracked file -> MISMATCH.
    unlinkSync(join(wtHonest, "app.ts"));
    expect(proveCheckoutTree(tmpClone, wtHonest, sha, root, env).match).toBe(false);
    writeFileSync(join(wtHonest, "app.ts"), "export const v = 1;\n");

    // 6. Extra untracked non-ignored file -> MISMATCH.
    writeFileSync(join(wtHonest, "extra.ts"), "unreviewed\n");
    expect(proveCheckoutTree(tmpClone, wtHonest, sha, root, env).match).toBe(false);
  });
});
