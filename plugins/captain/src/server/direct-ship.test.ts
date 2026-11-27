import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { buildRepoUrl } from "../../skills/captain-ship/scripts/direct-ship.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(HERE, "../../skills/captain-ship/scripts/direct-ship.mjs");
const SKILL_PATH = resolve(HERE, "../../skills/captain-ship/SKILL.md");

const REPO_SLUG = "smsunarto/demo-repo";
const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type RunResult = { status: number; stdout: string; stderr: string };

/** Clean environment for git and script subprocesses: strip inherited GIT_* hook vars and isolate global config. */
function cleanEnv(globalConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env["GIT_CONFIG_GLOBAL"] = globalConfig;
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_TERMINAL_PROMPT"] = "0";
  return env;
}

function runGit(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; allowFailure?: boolean },
): RunResult {
  const res = spawnSync("git", args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  const result = {
    status: res.status ?? 1,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr}`);
  }
  return result;
}

function runScript(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; allowFailure?: boolean; scriptPath?: string },
): RunResult {
  const res = spawnSync(process.execPath, [options.scriptPath ?? SCRIPT_PATH, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  const result = {
    status: res.status ?? 1,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `direct-ship.mjs ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function runScriptAsync(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; allowFailure?: boolean; scriptPath?: string },
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [options.scriptPath ?? SCRIPT_PATH, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        status: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
      if (result.status !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `direct-ship.mjs ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`,
          ),
        );
        return;
      }
      resolvePromise(result);
    });
  });
}

/** Create a bare origin served over `file://` (with partial-clone filtering enabled) and a crew clone with one base commit. */
function setupScratchRepo() {
  // Resolve symlinks on the temp root so `$PWD` logged by local hooks matches `originDir`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "captain-direct-ship-")));
  roots.push(root);
  const globalConfig = join(root, "global.gitconfig");
  writeFileSync(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  const env = cleanEnv(globalConfig);

  const remotesRoot = join(root, "remotes");
  const originDir = join(remotesRoot, `${REPO_SLUG}.git`);
  mkdirSync(dirname(originDir), { recursive: true });
  const baseUrl = `file://${remotesRoot}`;
  const originUrl = `${baseUrl}/${REPO_SLUG}.git`;
  const crewDir = join(root, "crew");

  runGit(["init", "--bare", "-b", "main", originDir], { env });
  runGit(["--git-dir", originDir, "config", "uploadpack.allowFilter", "true"], { env });
  runGit(["clone", originUrl, crewDir], { env });

  writeFileSync(join(crewDir, "README.md"), "base\n");
  runGit(["add", "README.md"], { cwd: crewDir, env });
  runGit(["commit", "-m", "base"], { cwd: crewDir, env });
  runGit(["push", "-u", "origin", "main"], { cwd: crewDir, env });
  const base = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;

  return { root, globalConfig, env, remotesRoot, baseUrl, originDir, originUrl, crewDir, base };
}

describe("captain-ship direct-ship script", () => {
  test("SKILL.md references the script and buildRepoUrl constructs GitHub URLs from --repo alone", () => {
    expect(readFileSync(SKILL_PATH, "utf8")).toContain("<skill-dir>/scripts/direct-ship.mjs");
    expect(buildRepoUrl("smsunarto/bb-plugins")).toBe(
      "https://github.com/smsunarto/bb-plugins.git",
    );
    expect(buildRepoUrl("smsunarto/bb-plugins", { ssh: true })).toBe(
      "git@github.com:smsunarto/bb-plugins.git",
    );
  });

  test("the script's bare blobless clone excludes refs/replace while --mirror imports it", () => {
    const { root, env, baseUrl, originDir, originUrl, crewDir, base } = setupScratchRepo();

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

    const workdir = join(root, "ship-run");
    runScript(["clone", "--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir], { env });
    const bareDir = join(workdir, "bare.git");

    // Confirm the blobless clone actually omitted blobs from its pack.
    const missingBlobs = runGit(
      ["--git-dir", bareDir, "rev-list", "--objects", "--all", "--missing=print"],
      { env },
    )
      .stdout.split("\n")
      .filter((line) => line.startsWith("?"));
    expect(missingBlobs.length).toBeGreaterThan(0);

    expect(runGit(["-C", bareDir, "for-each-ref", "refs/replace"], { env }).stdout).toBe("");
    expect(
      runGit(["-C", bareDir, "config", "--get-all", "remote.origin.fetch"], {
        env,
        allowFailure: true,
      }).stdout,
    ).toBe("");
    expect(runGit(["-C", bareDir, "rev-parse", "--is-shallow-repository"], { env }).stdout).toBe(
      "false",
    );

    // Control: --mirror imports refs/replace/* from origin, which is why the script never uses it.
    const mirrorDir = join(root, "mirror.git");
    runGit(["clone", "--mirror", originUrl, mirrorDir], { env });
    expect(runGit(["-C", mirrorDir, "for-each-ref", "refs/replace"], { env }).stdout).toContain(
      `refs/replace/${sha}`,
    );

    runScript(["cleanup", "--dir", workdir], { env });
    expect(existsSync(workdir)).toBe(false);
  });

  test("rewritten crew fetch refspec and annotated tag replace ref cannot hijack direct ship end to end", () => {
    const { root, env, baseUrl, originDir, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "feature.ts"), "export const ok = 1;\n");
    runGit(["add", "feature.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: add feature"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Crew pushes an annotated tag `rep/<sha>` pointing at an unreviewed commit and adds a fetch refspec.
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
    runGit(["config", "--add", "remote.origin.fetch", "+refs/tags/rep/*:refs/replace/*"], {
      cwd: crewDir,
      env,
    });
    runGit(["fetch", "origin"], { cwd: crewDir, env });
    expect(runGit(["rev-parse", `${sha}^{commit}`], { cwd: crewDir, env }).stdout).toBe(evil);

    // Run every subcommand of direct-ship.mjs end to end.
    const workdir = join(root, "ship-h1");
    const common = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir];
    runScript(["clone", ...common], { env });
    const verified = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha],
      { env },
    );
    expect(verified.stdout).toContain("status: ready");
    expect(verified.stdout).toContain("task: add feature");
    expect(verified.stdout).not.toContain("evil commit");

    // Checks clone holds the reviewed file, not the backdoor.
    const checksDir = join(workdir, "checks");
    expect(existsSync(join(checksDir, "feature.ts"))).toBe(true);
    expect(existsSync(join(checksDir, "backdoor.ts"))).toBe(false);

    const pushed = runScript(["push", ...common, "--target", "main", "--sha", sha], { env });
    expect(pushed.stdout).toContain("status: pushed");

    const confirmed = runScript(["confirm", ...common, "--target", "main", "--sha", sha], { env });
    expect(confirmed.stdout).toContain("status: confirmed");
    expect(confirmed.stdout).toContain(`target_sha: ${sha}`);

    runScript(["cleanup", "--dir", workdir], { env });
    expect(existsSync(workdir)).toBe(false);

    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );
  });

  test("a remote branch literally named <sha> stops on ambiguous warning, and ^{commit} still lands <sha> if warnings are off", () => {
    const { root, globalConfig, env, baseUrl, originDir, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "ok.txt"), "ok\n");
    runGit(["add", "ok.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: ok"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    writeFileSync(join(crewDir, "evil.txt"), "evil\n");
    runGit(["add", "evil.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "evil"], { cwd: crewDir, env });
    const evil = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "origin", `${evil}:refs/heads/${sha}`], { cwd: crewDir, env });

    // Default config: git emits an `ambiguous` warning and the script stops before pushing.
    const workdir1 = join(root, "ship-ambig");
    const common1 = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir1];
    runScript(["clone", ...common1], { env });
    const stopped = runScript(
      ["verify", ...common1, "--target", "main", "--branch", "crew", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(stopped.status).not.toBe(0);
    expect(stopped.stderr).toMatch(/ambiguous/iu);
    runScript(["cleanup", "--dir", workdir1], { env });

    // Even if ambiguity warnings are suppressed in global config, `^{commit}` resolves `<sha>` as an object.
    writeFileSync(
      globalConfig,
      "[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\twarnAmbiguousRefs = false\n[advice]\n\tobjectNameWarning = false\n",
    );
    const workdir2 = join(root, "ship-peel");
    const common2 = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir2];
    runScript(["clone", ...common2], { env });
    runScript(["verify", ...common2, "--target", "main", "--branch", "crew", "--sha", sha], {
      env,
    });
    runScript(["push", ...common2, "--target", "main", "--sha", sha], { env });
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );

    // Control: pushing bare `<sha>` (without `^{commit}`) from the bare clone resolves refs/heads/<sha> and lands EVIL.
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });
    runGit(
      [
        "--no-replace-objects",
        "-C",
        join(workdir2, "bare.git"),
        "push",
        "origin",
        `${sha}:refs/heads/main`,
      ],
      { env },
    );
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      evil,
    );
    runScript(["cleanup", "--dir", workdir2], { env });
  });

  test("a shallow file in the crew repo cannot hide a side-branch commit from verify's commit list", () => {
    const { root, env, baseUrl, crewDir, base } = setupScratchRepo();

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

    // Confirm the shallow boundary hides E1 in the crew repo.
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

    // direct-ship.mjs verify lists all four commits including E1.
    const workdir = join(root, "ship-shallow");
    const common = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir];
    runScript(["clone", ...common], { env });
    const verified = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", mergeSha],
      { env },
    );
    for (const subject of ["M merge", "C1 task", "E2 tip", "E1 hidden"]) {
      expect(verified.stdout).toContain(subject);
    }
    runScript(["cleanup", "--dir", workdir], { env });
  });

  test("exact ls-remote matching defeats a decoy a/refs/heads/main branch before and after push", () => {
    const { root, env, baseUrl, originUrl, crewDir } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "work.txt"), "work\n");
    runGit(["add", "work.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: work"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });
    runGit(["push", "origin", `${sha}:refs/heads/a/refs/heads/main`], { cwd: crewDir, env });

    // Unfiltered ls-remote returns 2 lines for `refs/heads/main`.
    expect(
      runGit(["ls-remote", originUrl, "refs/heads/main"], { env }).stdout.split("\n"),
    ).toHaveLength(2);

    const workdir = join(root, "ship-ls-remote");
    const common = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir];
    runScript(["clone", ...common], { env });
    expect(
      runScript(["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha], {
        env,
      }).stdout,
    ).toContain("status: ready");
    runScript(["push", ...common, "--target", "main", "--sha", sha], { env });
    const confirmed = runScript(["confirm", ...common, "--target", "main", "--sha", sha], { env });
    expect(confirmed.stdout).toContain("status: confirmed");
    expect(confirmed.stdout).toContain(`target_sha: ${sha}`);
    runScript(["cleanup", "--dir", workdir], { env });
  });

  test("global core.hooksPath and core.fsmonitor scripts do not fire during script runs, while controls fire both, and checks clone has its own .git at <sha>^{tree}", () => {
    const { root, globalConfig, env, baseUrl, originDir, originUrl, crewDir, base } =
      setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "a.txt"), "a\n");
    runGit(["add", "a.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: a"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    const hooksDir = join(root, "hooks");
    const hookLog = join(root, "hooks.log");
    const fsmLog = join(root, "fsmonitor.log");
    const fsmScript = join(root, "fsmonitor.sh");
    mkdirSync(hooksDir);
    for (const name of [
      "pre-push",
      "post-checkout",
      "post-index-change",
      "reference-transaction",
    ]) {
      const hookPath = join(hooksDir, name);
      writeFileSync(hookPath, `#!/bin/sh\necho "${name}:$PWD" >> "${hookLog}"\n`);
      chmodSync(hookPath, 0o755);
    }
    writeFileSync(fsmScript, `#!/bin/sh\necho "fsmonitor:$PWD" >> "${fsmLog}"\nprintf '/\\0'\n`);
    chmodSync(fsmScript, 0o755);

    writeFileSync(
      globalConfig,
      [
        "[user]",
        "\tname = Test",
        "\temail = test@example.com",
        "[core]",
        `\thooksPath = ${hooksDir}`,
        `\tfsmonitor = ${fsmScript}`,
        "\tfsmonitorHookVersion = 1",
        "",
      ].join("\n"),
    );

    const workdir = join(root, "ship-hooks");
    const common = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir];
    runScript(["clone", ...common], { env });
    runScript(["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha], { env });

    const bareDir = join(workdir, "bare.git");
    const checksDir = join(workdir, "checks");
    // Checks clone owns its own `.git` directory (never a worktree `.git` file) and matches `<sha>^{tree}`.
    expect(lstatSync(join(checksDir, ".git")).isDirectory()).toBe(true);
    const checksTree = runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        checksDir,
        "rev-parse",
        "HEAD^{tree}",
      ],
      { env },
    ).stdout;
    const bareTree = runGit(
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        bareDir,
        "rev-parse",
        `${sha}^{tree}`,
      ],
      { env },
    ).stdout;
    expect(checksTree).toBe(bareTree);

    runScript(["push", ...common, "--target", "main", "--sha", sha], { env });
    runScript(["confirm", ...common, "--target", "main", "--sha", sha], { env });

    // Exclude origin's own local receive-pack lines (which fire only because the test pushes over `file://`).
    const readClientHookLogs = () =>
      existsSync(hookLog)
        ? readFileSync(hookLog, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line !== "" && !line.endsWith(`:${originDir}`))
        : [];
    const readFsmLogs = () =>
      existsSync(fsmLog)
        ? readFileSync(fsmLog, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line !== "")
        : [];

    expect(readClientHookLogs()).toEqual([]);
    expect(readFsmLogs()).toEqual([]);

    // Control without the script's `-c` overrides: clone, checkout, and push fire hooks and fsmonitor.
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });
    const controlClone = join(root, "control-checks");
    runGit(["clone", "--no-checkout", originUrl, controlClone], { env });
    runGit(["-C", controlClone, "checkout", "--detach", `${sha}^{commit}`], { env });
    runGit(["-C", bareDir, "push", "origin", `${sha}^{commit}:refs/heads/main`], { env });

    const firedHooks = readClientHookLogs();
    expect(firedHooks.some((line) => line.startsWith("post-checkout:"))).toBe(true);
    expect(firedHooks.some((line) => line.startsWith("reference-transaction:"))).toBe(true);
    expect(firedHooks.some((line) => line.startsWith("pre-push:"))).toBe(true);
    expect(readFsmLogs().some((line) => line.startsWith(`fsmonitor:${controlClone}`))).toBe(true);

    runScript(["cleanup", "--dir", workdir], { env });
  });

  test("crew repo includeIf pushurl and repo-local transport config are ignored; global insteadOf with identity pushInsteadOf is refused", () => {
    const { root, globalConfig, env, baseUrl, originDir, originUrl, crewDir } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "item.txt"), "item\n");
    runGit(["add", "item.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: item"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Decoy bare repo that worktree-scoped includeIf redirects pushurl to.
    const evilOriginDir = join(root, "evil-origin.git");
    runGit(["init", "--bare", "-b", "main", evilOriginDir], { env });
    const includeFile = join(root, "worktree-override.gitconfig");
    writeFileSync(includeFile, `[remote "origin"]\n\tpushurl = file://${evilOriginDir}\n`);

    runGit(["config", "includeIf.gitdir:**/worktrees/**.path", includeFile], {
      cwd: crewDir,
      env,
    });
    runGit(["config", "core.sshCommand", "sh -c 'exit 99'"], { cwd: crewDir, env });
    runGit(["config", "credential.helper", "!sh -c 'exit 99'"], { cwd: crewDir, env });
    runGit(["config", "http.proxy", "http://127.0.0.1:1"], { cwd: crewDir, env });

    // Confirm a linked worktree under `worktrees/` actually inherits the redirected pushurl.
    const worktreesParent = join(root, "worktrees");
    mkdirSync(worktreesParent);
    const linkedWt = join(worktreesParent, "ship-wt");
    runGit(["worktree", "add", "--detach", linkedWt, sha], { cwd: crewDir, env });
    expect(
      runGit(["-C", linkedWt, "remote", "get-url", "--push", "--all", "origin"], { env }).stdout,
    ).toBe(`file://${evilOriginDir}`);

    // Running the script even from inside the poisoned crew repo ignores its config and lands on real origin.
    const workdir = join(root, "ship-isolated");
    const common = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir];
    runScript(["clone", ...common], { cwd: linkedWt, env });
    runScript(["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha], {
      cwd: linkedWt,
      env,
    });
    runScript(["push", ...common, "--target", "main", "--sha", sha], { cwd: linkedWt, env });
    runScript(["confirm", ...common, "--target", "main", "--sha", sha], { cwd: linkedWt, env });
    runScript(["cleanup", "--dir", workdir], { cwd: linkedWt, env });

    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );
    expect(
      runGit(["--git-dir", evilOriginDir, "rev-parse", "--verify", "refs/heads/main"], {
        env,
        allowFailure: true,
      }).status,
    ).not.toBe(0);

    // Global `insteadOf` paired with identity `pushInsteadOf`: get-url --push --all prints originUrl,
    // while get-url --all prints evilOriginDir. The script checks both and refuses it.
    writeFileSync(
      globalConfig,
      [
        "[user]",
        "\tname = Test",
        "\temail = test@example.com",
        `[url "file://${evilOriginDir}"]`,
        `\tinsteadOf = ${originUrl}`,
        `[url "${originUrl}"]`,
        `\tpushInsteadOf = ${originUrl}`,
        "",
      ].join("\n"),
    );
    const workdirRewritten = join(root, "ship-rewritten");
    const rejected = runScript(
      ["clone", "--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdirRewritten],
      { env, allowFailure: true },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("remote get-url --all origin");
    // Failing clone cleans up the bare clone it created before exiting.
    expect(existsSync(join(workdirRewritten, "bare.git"))).toBe(false);
    expect(existsSync(workdirRewritten)).toBe(false);
  });

  test("running the script through a symlinked directory with spaces and percent-encoding invokes the CLI", () => {
    const { root, env, baseUrl } = setupScratchRepo();
    const linkDir = join(root, "linked scripts %20 dir");
    symlinkSync(dirname(SCRIPT_PATH), linkDir);
    const viaSymlink = join(linkDir, "direct-ship.mjs");
    const workdir = join(root, "ship-symlink");

    const cloned = runScript(
      ["clone", "--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir],
      { env, scriptPath: viaSymlink },
    );
    expect(cloned.stdout).toContain("status: cloned");
    expect(existsSync(join(workdir, "bare.git"))).toBe(true);

    const bad = runScript(["clone", "--repo", "not-a-repo", "--dir", workdir], {
      env,
      scriptPath: viaSymlink,
      allowFailure: true,
    });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("invalid --repo");

    const cleaned = runScript(["cleanup", "--dir", workdir], { env, scriptPath: viaSymlink });
    expect(cleaned.stdout).toContain("status: cleaned");
    expect(existsSync(workdir)).toBe(false);
  });

  test("a commit subject and workdir path containing 'ambiguous' do not stop a valid ship", () => {
    const { root, env, baseUrl, originDir, crewDir } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "note.txt"), "clarify\n");
    runGit(["add", "note.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "fix: clarify ambiguous wording that matches more than one case"], {
      cwd: crewDir,
      env,
    });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    const workdir = join(root, "ambiguous-workdir");
    const common = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir];
    runScript(["clone", ...common], { env });
    const verified = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha],
      { env },
    );
    expect(verified.stdout).toContain("status: ready");
    expect(verified.stdout).toContain("ambiguous wording");
    expect(
      runScript(["push", ...common, "--target", "main", "--sha", sha], { env }).stdout,
    ).toContain("status: pushed");
    expect(
      runScript(["confirm", ...common, "--target", "main", "--sha", sha], { env }).stdout,
    ).toContain("status: confirmed");
    runScript(["cleanup", "--dir", workdir], { env });
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );
  });

  test("cleanEnv preserves GIT_CONFIG_COUNT credential helpers while stripping repo-pointing GIT_* vars", async () => {
    const { root, env, baseUrl } = setupScratchRepo();
    // Stripped repo-pointing GIT_* vars cannot hijack a valid clone.
    const fileWorkdir = join(root, "ship-stripped-env");
    const strippedEnv: NodeJS.ProcessEnv = {
      ...env,
      GIT_DIR: join(root, "bogus.git"),
      GIT_WORK_TREE: join(root, "bogus-wt"),
    };
    const fileClone = runScript(
      ["clone", "--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", fileWorkdir],
      { env: strippedEnv },
    );
    expect(fileClone.stdout).toContain("status: cloned");
    runScript(["cleanup", "--dir", fileWorkdir], { env });

    const helperLog = join(root, "cred-helper.log");
    const server = createServer((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    try {
      const { port } = server.address() as AddressInfo;
      const workdir = join(root, "ship-cred");
      const credEnv: NodeJS.ProcessEnv = {
        ...env,
        GIT_DIR: join(root, "bogus.git"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: `!sh -c 'echo invoked >> "${helperLog}"'`,
      };
      const res = await runScriptAsync(
        ["clone", "--repo", REPO_SLUG, "--base-url", `http://127.0.0.1:${port}`, "--dir", workdir],
        { env: credEnv, allowFailure: true },
      );
      expect(res.status).not.toBe(0);
      expect(existsSync(helperLog)).toBe(true);
      expect(readFileSync(helperLog, "utf8")).toContain("invoked");
      // Failed clone cleans up any partial workdir.
      expect(existsSync(workdir)).toBe(false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("push enforces the verified sha, target, and target_sha, and reports already-landed when rerun after a landed push", () => {
    const { root, env, baseUrl, originDir, crewDir, base } = setupScratchRepo();

    // Two commits on crew: base -> c1 -> c2.
    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "c1.txt"), "1\n");
    runGit(["add", "c1.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: step 1"], { cwd: crewDir, env });
    const c1 = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    writeFileSync(join(crewDir, "c2.txt"), "2\n");
    runGit(["add", "c2.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: step 2"], { cwd: crewDir, env });
    const c2 = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // 1. push before verify is refused.
    const wdUnverified = join(root, "ship-unverified");
    const commonUnverified = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", wdUnverified];
    runScript(["clone", ...commonUnverified], { env });
    const unverified = runScript(["push", ...commonUnverified, "--target", "main", "--sha", c2], {
      env,
      allowFailure: true,
    });
    expect(unverified.status).toBe(1);
    expect(unverified.stderr).toContain("verified.json");
    runScript(["cleanup", "--dir", wdUnverified], { env });

    // 2. push with differing --sha or differing --target is refused.
    const wdMismatch = join(root, "ship-mismatch");
    const commonMismatch = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", wdMismatch];
    runScript(["clone", ...commonMismatch], { env });
    runScript(["verify", ...commonMismatch, "--target", "main", "--branch", "crew", "--sha", c2], {
      env,
    });
    const wrongSha = runScript(["push", ...commonMismatch, "--target", "main", "--sha", c1], {
      env,
      allowFailure: true,
    });
    expect(wrongSha.status).toBe(1);
    expect(wrongSha.stderr).toContain("does not match verified");
    const wrongTarget = runScript(["push", ...commonMismatch, "--target", "other", "--sha", c2], {
      env,
      allowFailure: true,
    });
    expect(wrongTarget.status).toBe(1);
    expect(wrongTarget.stderr).toContain("does not match verified");
    runScript(["cleanup", "--dir", wdMismatch], { env });

    // 3. Target advances to c1 after verify recorded target_sha=base: push refuses even though c1..c2 would fast-forward.
    const wdMoved = join(root, "ship-moved");
    const commonMoved = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", wdMoved];
    runScript(["clone", ...commonMoved], { env });
    runScript(["verify", ...commonMoved, "--target", "main", "--branch", "crew", "--sha", c2], {
      env,
    });
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", c1], { env });
    const moved = runScript(["push", ...commonMoved, "--target", "main", "--sha", c2], {
      env,
      allowFailure: true,
    });
    expect(moved.status).toBe(3);
    expect(moved.stderr).toContain("status: not-fast-forward");
    expect(existsSync(wdMoved)).toBe(false);
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      c1,
    );

    // 4. Lost-response rerun: push lands c2, then rerunning push (and even after another commit lands on top) reports already-landed (exit 0).
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });
    const wdRerun = join(root, "ship-rerun");
    const commonRerun = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", wdRerun];
    runScript(["clone", ...commonRerun], { env });
    runScript(["verify", ...commonRerun, "--target", "main", "--branch", "crew", "--sha", c2], {
      env,
    });
    expect(
      runScript(["push", ...commonRerun, "--target", "main", "--sha", c2], { env }).stdout,
    ).toContain("status: pushed");

    const rerunSame = runScript(["push", ...commonRerun, "--target", "main", "--sha", c2], { env });
    expect(rerunSame.stdout).toContain("status: already-landed");

    // Another commit lands on top of c2 on origin/main; rerunning push still reports already-landed.
    writeFileSync(join(crewDir, "later.txt"), "later\n");
    runGit(["add", "later.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "later commit"], { cwd: crewDir, env });
    const later = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "origin", `${later}:refs/heads/main`], { cwd: crewDir, env });

    const rerunLater = runScript(["push", ...commonRerun, "--target", "main", "--sha", c2], {
      env,
    });
    expect(rerunLater.stdout).toContain("status: already-landed");
    expect(
      runScript(["confirm", ...commonRerun, "--target", "main", "--sha", c2], { env }).stdout,
    ).toContain("status: confirmed");
    runScript(["cleanup", "--dir", wdRerun], { env });
    expect(existsSync(wdRerun)).toBe(false);
  });

  test("verify reports crew-branch-missing, not-fast-forward, and already-landed cleanly, and re-cloning after a push succeeds", () => {
    const { root, env, baseUrl, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "one.txt"), "1\n");
    runGit(["add", "one.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: one"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;

    // 1. Crew branch not pushed yet: verify exits 2 with crew-branch-missing; cleanup + push + re-clone succeeds.
    const workdir = join(root, "ship-lifecycle");
    const common = ["--repo", REPO_SLUG, "--base-url", baseUrl, "--dir", workdir];
    runScript(["clone", ...common], { env });
    const missing = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("status: crew-branch-missing");
    // Failing verify cleans up clones before exiting.
    expect(existsSync(join(workdir, "bare.git"))).toBe(false);
    expect(existsSync(workdir)).toBe(false);

    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });
    runScript(["clone", ...common], { env });
    expect(
      runScript(["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha], {
        env,
      }).stdout,
    ).toContain("status: ready");

    // 2. Push lands `<sha>`, then a fresh clone's verify reports already-landed without creating `checks`.
    runScript(["push", ...common, "--target", "main", "--sha", sha], { env });
    runScript(["confirm", ...common, "--target", "main", "--sha", sha], { env });
    runScript(["cleanup", "--dir", workdir], { env });

    runScript(["clone", ...common], { env });
    const landed = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha],
      { env },
    );
    expect(landed.stdout).toContain("status: already-landed");
    expect(existsSync(join(workdir, "checks"))).toBe(false);
    runScript(["cleanup", "--dir", workdir], { env });

    // 3. A crew branch behind moved main gets status: not-fast-forward (exit 3) without creating `checks`.
    runGit(["checkout", "-b", "stale-crew", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "stale.txt"), "stale\n");
    runGit(["add", "stale.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: stale"], { cwd: crewDir, env });
    const staleSha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "stale-crew"], { cwd: crewDir, env });

    runScript(["clone", ...common], { env });
    const notFf = runScript(
      ["verify", ...common, "--target", "main", "--branch", "stale-crew", "--sha", staleSha],
      { env, allowFailure: true },
    );
    expect(notFf.status).toBe(3);
    expect(notFf.stderr).toContain("status: not-fast-forward");
    // Failing verify cleans up clones before exiting.
    expect(existsSync(join(workdir, "checks"))).toBe(false);
    expect(existsSync(join(workdir, "bare.git"))).toBe(false);
    expect(existsSync(workdir)).toBe(false);
  });
});
